/**
 * TikTok e Instagram: tus cuentas leídas con sus API oficiales (solo lectura), igual que los canales de YouTube.
 *
 * Cada vídeo se guarda con sus cifras, se empareja con su clip cuando hay UNA coincidencia clara (la descripción)
 * y entonces queda como publicación de ese clip, con su medición. No publica, no borra y no toca clips.
 * Instagram todavía no da visitas con los permisos actuales: se guardan likes y comentarios y las visitas quedan
 * «sin medir» (null), nunca como cero.
 */
import type { DB } from './db'
import { matchTikTokToClip, parseTikTokUrl } from './tiktok'
import { matchVideoToClip, MIN_INTERVAL_MINUTES, normalizeText, SNAPSHOT_KEEPALIVE_MINUTES } from './youtube-channels'

export type SocialPlatform = 'tiktok' | 'instagram'

/** fetch mínimo (GET y POST) para poder probar sin red. */
export type SocialFetch = (url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

export class SocialError extends Error {}

export interface SocialItem {
  videoId: string
  url: string
  description: string
  /** ISO 8601. */
  publishedAt: string | null
  durationSeconds: number | null
  /** null = la plataforma no lo da (no es un cero). */
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
}

export interface SocialAccountData {
  platform: SocialPlatform
  /** Siempre con @ delante, como se apuntan las publicaciones. */
  account: string
  displayName: string | null
  followers: number | null
  totalLikes: number | null
  videoCount: number | null
  items: SocialItem[]
}

export interface SocialRefreshResult {
  accounts: { platform: SocialPlatform; account: string; ok: boolean; error?: string; summary?: SocialSyncSummary }[]
}

export interface SocialSyncSummary {
  videos: number
  linkedNow: number
  unmatched: number
  measured: number
}

type Row = Record<string, any>
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
export const conArroba = (a: string) => '@' + a.trim().replace(/^@+/, '')
const mismaCuenta = (a: unknown, b: unknown) => String(a ?? '').replace(/^@/, '').replace(/ · .*$/, '').trim().toLowerCase() === String(b ?? '').replace(/^@/, '').trim().toLowerCase()

// ---------------------------------------------------------------- lectura (API oficiales)

const TIKTOK_API = 'https://open.tiktokapis.com/v2'

async function leerJson(r: Awaited<ReturnType<SocialFetch>>, quien: string): Promise<any> {
  let d: any = null
  try {
    d = await r.json()
  } catch {
    /* sin cuerpo */
  }
  const err = d?.error
  const msg = typeof err === 'object' && err ? err.message || (err.code !== 'ok' ? err.code : '') : typeof err === 'string' ? err : ''
  if (!r.ok || msg) throw new SocialError(`${quien} respondió con un error${msg ? `: ${msg}` : ` (${r.status})`}.`)
  return d
}

/** Cuenta de TikTok autorizada: perfil y todos sus vídeos públicos (API oficial, scope video.list). */
export async function fetchTikTokAccount(alias: string, token: string, f: SocialFetch): Promise<SocialAccountData> {
  const auth = { Authorization: `Bearer ${token}` }
  const u = await leerJson(await f(`${TIKTOK_API}/user/info/?fields=display_name,follower_count,likes_count,video_count`, { headers: auth }), 'TikTok')
  const user = u?.data?.user ?? {}
  const items: SocialItem[] = []
  let cursor: number | null = null
  const campos = 'id,title,video_description,create_time,share_url,duration,view_count,like_count,comment_count,share_count'
  for (let pagina = 0; pagina < 60; pagina++) {
    const d = await leerJson(await f(`${TIKTOK_API}/video/list/?fields=${campos}`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(cursor == null ? { max_count: 20 } : { max_count: 20, cursor })
    }), 'TikTok')
    for (const v of (d?.data?.videos ?? []) as Row[]) {
      const id = String(v.id ?? '')
      if (!id) continue
      const ref = parseTikTokUrl(String(v.share_url ?? '').split('?')[0])
      const t = num(v.create_time)
      items.push({
        videoId: id,
        url: ref?.url ?? `https://www.tiktok.com/@${alias.replace(/^@/, '')}/video/${id}`,
        description: String(v.video_description ?? v.title ?? ''),
        publishedAt: t ? new Date(t * 1000).toISOString() : null,
        durationSeconds: num(v.duration),
        views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count)
      })
    }
    if (!d?.data?.has_more || d?.data?.cursor == null) break
    cursor = Number(d.data.cursor)
  }
  return {
    platform: 'tiktok', account: conArroba(alias), displayName: user.display_name ?? null,
    followers: num(user.follower_count), totalLikes: num(user.likes_count), videoCount: num(user.video_count), items
  }
}

const GRAPH = 'https://graph.facebook.com/v26.0'

/** Cuenta profesional de Instagram ligada a tu página de Facebook (API de Meta). Sin visitas por ahora. */
export async function fetchInstagramAccount(token: string, f: SocialFetch): Promise<SocialAccountData> {
  const g = async (ruta: string, q: Record<string, string>) =>
    leerJson(await f(`${GRAPH}/${ruta}?${new URLSearchParams({ ...q, access_token: token })}`, {}), 'Instagram')
  // la cuenta: por las páginas que administras o, si Meta no las lista, por las que concediste al token
  let igId: string | null = null
  const paginas = await g('me/accounts', { fields: 'instagram_business_account{id}' })
  for (const p of (paginas?.data ?? []) as Row[]) igId ??= p.instagram_business_account?.id ?? null
  if (!igId) {
    const dbg = await g('debug_token', { input_token: token })
    const ids = ((dbg?.data?.granular_scopes ?? []) as Row[]).find((s) => s.scope === 'pages_show_list')?.target_ids ?? []
    for (const pid of ids as string[]) {
      if (igId) break
      igId = (await g(String(pid), { fields: 'instagram_business_account{id}' }))?.instagram_business_account?.id ?? null
    }
  }
  if (!igId) throw new SocialError('No hay ninguna cuenta de Instagram profesional ligada a tu página de Facebook (o faltan permisos).')
  const perfil = await g(igId, { fields: 'username,name,followers_count,media_count' })
  const items: SocialItem[] = []
  let url: string | null = `${GRAPH}/${igId}/media?${new URLSearchParams({ fields: 'id,caption,permalink,timestamp,media_product_type,like_count,comments_count', limit: '50', access_token: token })}`
  for (let pagina = 0; url && pagina < 40; pagina++) {
    const d = await leerJson(await f(url, {}), 'Instagram')
    for (const m of (d?.data ?? []) as Row[]) {
      items.push({
        videoId: String(m.id), url: String(m.permalink ?? ''), description: String(m.caption ?? ''),
        publishedAt: m.timestamp ? new Date(m.timestamp).toISOString() : null, durationSeconds: null,
        views: null, likes: num(m.like_count), comments: num(m.comments_count), shares: null
      })
    }
    url = typeof d?.paging?.next === 'string' ? d.paging.next : null
  }
  return {
    platform: 'instagram', account: conArroba(String(perfil?.username ?? igId)), displayName: perfil?.name ?? null,
    followers: num(perfil?.followers_count), totalLikes: null, videoCount: num(perfil?.media_count), items
  }
}

// ---------------------------------------------------------------- guardar, emparejar y medir

function anotar(db: DB, platform: SocialPlatform, videoId: string, v: SocialItem, t: string): void {
  if (v.views == null && v.likes == null) return
  const u = db.prepare('SELECT measured_at, views, likes, comments, shares FROM social_video_snapshots WHERE platform = ? AND video_id = ? ORDER BY measured_at DESC, id DESC LIMIT 1').get(platform, videoId) as Row | undefined
  const igual = u && u.views === v.views && u.likes === v.likes && u.comments === v.comments && u.shares === v.shares
  if (u && igual && Date.parse(t) - Date.parse(u.measured_at) < SNAPSHOT_KEEPALIVE_MINUTES * 60_000) return
  db.prepare('INSERT INTO social_video_snapshots (platform, video_id, measured_at, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?, ?)').run(platform, videoId, t, v.views, v.likes, v.comments, v.shares)
}

function medir(db: DB, platform: SocialPlatform, publicationId: number, v: Row, t: string, force: boolean): boolean {
  const ultima = db.prepare('SELECT measured_at FROM analytics_snapshots WHERE publication_id = ? ORDER BY measured_at DESC, id DESC LIMIT 1').get(publicationId) as Row | undefined
  if (!force && ultima && Date.parse(t) - Date.parse(ultima.measured_at) < MIN_INTERVAL_MINUTES * 60_000) return false
  db.prepare('INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, shares, origin) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(publicationId, t, v.views, v.likes, v.comments, v.shares, `${platform}_api`)
  return true
}

/** El mismo vídeo en una URL puesta a mano (TikTok: por su número; Instagram: por el enlace). */
function mismaUrl(platform: SocialPlatform, url: string | null, v: Row): boolean {
  if (!url) return false
  if (platform === 'tiktok') return parseTikTokUrl(url)?.videoId === v.video_id
  const corta = (x: string) => x.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  return !!v.url && corta(url) === corta(v.url)
}

/** Asocia el vídeo a un clip: completa la publicación que ya tenga el clip en esa cuenta (o sin enlace) o crea una. */
function attach(db: DB, platform: SocialPlatform, v: Row, clipId: string, state: 'auto' | 'manual', reason: string, t: string): number {
  const pubs = db.prepare('SELECT * FROM publications WHERE clip_id = ? AND platform = ? ORDER BY id').all(clipId, platform) as Row[]
  let pub = pubs.find((p) => mismaUrl(platform, p.url, v)) ?? pubs.find((p) => !p.url && (p.account === '' || mismaCuenta(p.account, v.account)))
  if (pub) {
    db.prepare('UPDATE publications SET url = COALESCE(url, ?), published_at = COALESCE(?, published_at), account = CASE WHEN account = \'\' THEN ? ELSE account END, caption_used = COALESCE(caption_used, ?), updated_at = ? WHERE id = ?')
      .run(v.url, v.published_at, v.account, v.description, t, pub.id)
  } else {
    const clip = db.prepare('SELECT sha256, file_sha256 FROM clips WHERE clip_id = ?').get(clipId) as Row | undefined
    if (!clip) throw new Error('El clip no existe.')
    const cuenta = pubs.some((p) => mismaCuenta(p.account, v.account)) ? `${v.account} · ${v.video_id}` : v.account
    const r = db.prepare(
      `INSERT INTO publications (clip_id, platform, account, status, url, published_at, caption_used, sha256_at_publish, created_at, updated_at)
       VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)`
    ).run(clipId, platform, cuenta, v.url, v.published_at ?? t, v.description, clip.file_sha256 ?? clip.sha256 ?? null, t, t)
    pub = { id: Number(r.lastInsertRowid) }
    // el canal entra en la lista de cuentas (como al marcar publicaciones a mano)
    db.prepare('INSERT OR IGNORE INTO accounts (platform, name, created_at) VALUES (?, ?, ?)').run(platform, v.account, t)
  }
  db.prepare('UPDATE social_videos SET publication_id = ?, match_state = ?, match_reason = ? WHERE platform = ? AND video_id = ?').run(pub.id, state, reason, platform, v.video_id)
  return pub.id as number
}

/** Clip de un vídeo: la descripción publicada contiene la del clip (y la duración cuadra si se sabe). */
export function matchSocialToClip(v: Pick<SocialItem, 'description' | 'durationSeconds'>, clips: { clipId: string; title: string | null; caption: string | null; duration: number | null }[]): { clipId: string; reason: string } | null {
  const porDescripcion = matchTikTokToClip(v, clips)
  if (porDescripcion) return { clipId: porDescripcion, reason: v.durationSeconds != null ? 'misma descripción y misma duración' : 'misma descripción' }
  return matchVideoToClip({ title: null, description: v.description, durationSeconds: v.durationSeconds }, clips)
}

/** Guarda lo leído de una cuenta: vídeos, cifras, emparejados nuevos y mediciones de los emparejados. */
export function saveSocialAccount(db: DB, data: SocialAccountData, opts: { now?: () => string; force?: boolean } = {}): SocialSyncSummary {
  const t = (opts.now ?? (() => new Date().toISOString()))()
  const p = data.platform
  const r: SocialSyncSummary = { videos: 0, linkedNow: 0, unmatched: 0, measured: 0 }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO social_accounts (platform, account, display_name, followers, total_likes, video_count, stats_at, last_scan_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(platform, account) DO UPDATE SET display_name = excluded.display_name, followers = excluded.followers, total_likes = excluded.total_likes,
         video_count = excluded.video_count, stats_at = excluded.stats_at, last_scan_at = excluded.last_scan_at, error = NULL`
    ).run(p, data.account, data.displayName, data.followers, data.totalLikes, data.videoCount, t, t)
    const conTexto = (db.prepare('SELECT clip_id, title, caption, duration FROM clips').all() as Row[])
      .map((c) => ({ clipId: c.clip_id as string, title: c.title as string | null, caption: c.caption as string | null, duration: c.duration as number | null }))
    // del más antiguo al más nuevo: si un clip está dos veces, el primero se queda el clip y el repetido queda a la vista
    for (const d of [...data.items].sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))) {
      r.videos++
      db.prepare(
        `INSERT INTO social_videos (platform, video_id, account, url, description, published_at, duration_seconds, views, likes, comments, shares, stats_at, first_seen_at, last_seen_at)
         VALUES (@p, @id, @account, @url, @description, @published, @dur, @views, @likes, @comments, @shares, @t, @t, @t)
         ON CONFLICT(platform, video_id) DO UPDATE SET account = excluded.account, url = excluded.url, description = excluded.description,
           published_at = excluded.published_at, duration_seconds = excluded.duration_seconds, views = excluded.views, likes = excluded.likes,
           comments = excluded.comments, shares = excluded.shares, stats_at = excluded.stats_at, last_seen_at = excluded.last_seen_at, removed_at = NULL`
      ).run({ p, id: d.videoId, account: data.account, url: d.url, description: d.description, published: d.publishedAt, dur: d.durationSeconds, views: d.views, likes: d.likes, comments: d.comments, shares: d.shares, t })
      anotar(db, p, d.videoId, d, t)
      let v = db.prepare('SELECT * FROM social_videos WHERE platform = ? AND video_id = ?').get(p, d.videoId) as Row
      if (!v.publication_id && v.match_state === 'unmatched') {
        const aMano = (db.prepare('SELECT id, url FROM publications WHERE platform = ? AND url IS NOT NULL').all(p) as Row[]).find((x) => mismaUrl(p, x.url, v))
        if (aMano && !db.prepare('SELECT 1 FROM social_videos WHERE publication_id = ?').get(aMano.id)) {
          db.prepare("UPDATE social_videos SET publication_id = ?, match_state = 'manual', match_reason = 'URL puesta a mano' WHERE platform = ? AND video_id = ?").run(aMano.id, p, d.videoId)
          r.linkedNow++
        } else {
          // un clip ya emparejado con otro vídeo de esta plataforma no se vuelve a proponer (sería un repetido)
          const ocupados = new Set((db.prepare(
            'SELECT pb.clip_id FROM social_videos s JOIN publications pb ON pb.id = s.publication_id WHERE s.platform = ? AND s.video_id <> ?'
          ).all(p, d.videoId) as Row[]).map((x) => x.clip_id))
          const m = matchSocialToClip(d, conTexto.filter((c) => !ocupados.has(c.clipId)))
          if (m) {
            attach(db, p, v, m.clipId, 'auto', m.reason, t)
            r.linkedNow++
          }
        }
        v = db.prepare('SELECT * FROM social_videos WHERE platform = ? AND video_id = ?').get(p, d.videoId) as Row
      }
      if (v.publication_id) {
        if (medir(db, p, v.publication_id, v, t, opts.force === true)) r.measured++
      } else if (v.match_state !== 'ignored') {
        r.unmatched++
      }
    }
    // lo que la cuenta ya no devuelve lo has borrado (o es privado): sale del panel y de los repetidos
    const vistos = new Set(data.items.map((i) => i.videoId))
    for (const x of db.prepare('SELECT video_id FROM social_videos WHERE platform = ? AND account = ? AND removed_at IS NULL').all(p, data.account) as Row[]) {
      if (!vistos.has(x.video_id)) db.prepare('UPDATE social_videos SET removed_at = ? WHERE platform = ? AND video_id = ?').run(t, p, x.video_id)
    }
  })()
  return r
}

/** Apunta que una cuenta no se pudo leer (se enseña en su pestaña; lo guardado no se toca). */
export function markSocialError(db: DB, platform: SocialPlatform, account: string, error: string, now: () => string = () => new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO social_accounts (platform, account, error, last_scan_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(platform, account) DO UPDATE SET error = excluded.error`
  ).run(platform, conArroba(account), `${error} (${now().slice(0, 16).replace('T', ' ')})`)
}

/** El usuario decide a qué clip corresponde un vídeo que no se emparejó solo. */
export function linkSocialVideo(db: DB, platform: SocialPlatform, videoId: string, clipId: string, now: () => string = () => new Date().toISOString()): void {
  const v = db.prepare('SELECT * FROM social_videos WHERE platform = ? AND video_id = ?').get(platform, videoId) as Row | undefined
  if (!v) throw new Error('El vídeo no existe.')
  if (v.publication_id) throw new Error('Ese vídeo ya está asociado a un clip.')
  db.transaction(() => {
    const t = now()
    const id = attach(db, platform, v, clipId, 'manual', 'elegido a mano', t)
    medir(db, platform, id, v, v.stats_at ?? t, true)
  })()
}

/** Deshace un emparejamiento equivocado (borra las mediciones que se le atribuyeron y le quita la URL). */
export function unlinkSocialVideo(db: DB, platform: SocialPlatform, videoId: string): void {
  const v = db.prepare('SELECT * FROM social_videos WHERE platform = ? AND video_id = ?').get(platform, videoId) as Row | undefined
  if (!v?.publication_id) return
  db.transaction(() => {
    db.prepare('DELETE FROM analytics_snapshots WHERE publication_id = ? AND origin = ?').run(v.publication_id, `${platform}_api`)
    db.prepare('UPDATE publications SET url = NULL WHERE id = ?').run(v.publication_id)
    db.prepare("UPDATE social_videos SET publication_id = NULL, match_state = 'review', match_reason = NULL WHERE platform = ? AND video_id = ?").run(platform, videoId)
  })()
}

// ---------------------------------------------------------------- panel

export interface SocialVideoView {
  platform: SocialPlatform
  videoId: string
  url: string
  account: string
  description: string
  publishedAt: string | null
  durationSeconds: number | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  /** Visitas ganadas entre dos mediciones separadas alrededor de un día; null si no hay con qué comparar. */
  gain: { views: number; hours: number } | null
  series: { t: string; views: number }[]
  clipId: string | null
  clipTitle: string | null
  campaignName: string | null
  hasThumb: boolean
  thumbVersion: number | null
  matchState: string
  /** REGLA Nº1: este vídeo repite a otro de la misma plataforma (mismo texto o mismo clip). */
  repeatOf: string | null
}

export interface SocialAccountView {
  platform: SocialPlatform
  account: string
  displayName: string | null
  followers: number | null
  followersChange: { delta: number; since: string } | null
  totalLikes: number | null
  videoCount: number | null
  /** Suma de las visitas conocidas (null si la plataforma no las da). */
  totalViews: number | null
  gain: number | null
  lastScanAt: string | null
  error: string | null
  videos: SocialVideoView[]
}

/** Primeras palabras de la descripción, para ver repetidos aunque cambien los hashtags. */
const huella = (t: string) => normalizeText(t).split(' ').slice(0, 12).join(' ')

export function getSocialDashboards(db: DB, now: Date = new Date()): SocialAccountView[] {
  const cuentas = db.prepare('SELECT * FROM social_accounts ORDER BY platform, account').all() as Row[]
  const filas = db.prepare(
    `SELECT s.*, p.clip_id, c.title AS clip_title, c.filename, c.thumb_path, c.cover_mtime_ms, COALESCE(k.display_name, k.folder_name) AS campaign_name
     FROM social_videos s LEFT JOIN publications p ON p.id = s.publication_id LEFT JOIN clips c ON c.clip_id = p.clip_id
     LEFT JOIN campaigns k ON k.campaign_id = c.campaign_id
     WHERE s.removed_at IS NULL
     ORDER BY s.published_at DESC, s.video_id`
  ).all() as Row[]
  const snaps = db.prepare('SELECT platform, video_id, measured_at, views FROM social_video_snapshots WHERE views IS NOT NULL ORDER BY measured_at').all() as Row[]
  const porVideo = new Map<string, { t: string; views: number }[]>()
  for (const s of snaps) {
    const k = `${s.platform}|${s.video_id}`
    const l = porVideo.get(k) ?? []
    l.push({ t: s.measured_at, views: s.views })
    porVideo.set(k, l)
  }
  // repetidos por plataforma: el más antiguo es el original; los demás lo repiten
  const original = new Map<string, string>()
  const repite = new Map<string, string>()
  for (const f of [...filas].reverse()) {
    const claves = [huella(f.description ?? ''), f.clip_id ? `clip:${f.clip_id}` : ''].filter((x) => x.length >= 15 || x.startsWith('clip:'))
    for (const c of claves) {
      const k = `${f.platform}|${c}`
      const o = original.get(k)
      if (o && o !== f.video_id) repite.set(`${f.platform}|${f.video_id}`, o)
      else if (!o) original.set(k, f.video_id)
    }
  }
  const ahora = now.getTime()
  const ganancia = (serie: { t: string; views: number }[]) => {
    if (serie.length < 2) return null
    const ultima = serie[serie.length - 1]
    const tu = Date.parse(ultima.t)
    if (ahora - tu > 36 * 3600_000) return null
    // la medición más cercana a 24 h antes de la última, con al menos 12 h de diferencia
    const previas = serie.filter((s) => tu - Date.parse(s.t) >= 12 * 3600_000)
    if (!previas.length) return null
    const ref = previas.reduce((m, s) => (Math.abs(tu - Date.parse(s.t) - 24 * 3600_000) < Math.abs(tu - Date.parse(m.t) - 24 * 3600_000) ? s : m))
    return { views: Math.max(0, ultima.views - ref.views), hours: Math.round((tu - Date.parse(ref.t)) / 3600_000) }
  }
  return cuentas.map((c) => {
    const videos: SocialVideoView[] = filas.filter((f) => f.platform === c.platform && f.account === c.account).map((f) => {
      const serie = porVideo.get(`${f.platform}|${f.video_id}`) ?? []
      return {
        platform: f.platform, videoId: f.video_id, url: f.url ?? '', account: f.account, description: f.description ?? '',
        publishedAt: f.published_at, durationSeconds: f.duration_seconds, views: f.views, likes: f.likes, comments: f.comments, shares: f.shares,
        gain: ganancia(serie), series: serie.slice(-30), clipId: f.clip_id ?? null, clipTitle: f.clip_title ?? f.filename ?? null,
        campaignName: f.campaign_name ?? null, hasThumb: !!f.thumb_path, thumbVersion: f.cover_mtime_ms ?? null,
        matchState: f.match_state, repeatOf: repite.get(`${f.platform}|${f.video_id}`) ?? null
      }
    })
    const conVisitas = videos.filter((v) => v.views != null)
    const gains = videos.map((v) => v.gain?.views).filter((g): g is number => g != null)
    const hist = db.prepare('SELECT measured_at, followers FROM social_account_snapshots WHERE platform = ? AND account = ? AND followers IS NOT NULL ORDER BY measured_at').all(c.platform, c.account) as Row[]
    const desde = hist.find((h) => ahora - Date.parse(h.measured_at) <= 7 * 24 * 3600_000) ?? null
    return {
      platform: c.platform, account: c.account, displayName: c.display_name, followers: c.followers,
      followersChange: desde && c.followers != null && c.followers !== desde.followers ? { delta: c.followers - desde.followers, since: desde.measured_at } : null,
      totalLikes: c.total_likes, videoCount: c.video_count,
      totalViews: conVisitas.length ? conVisitas.reduce((s, v) => s + (v.views ?? 0), 0) : null,
      gain: gains.length ? gains.reduce((a, b) => a + b, 0) : null,
      lastScanAt: c.last_scan_at, error: c.error, videos
    }
  })
}

/** Historial de seguidores de cada cuenta: una fila cuando cambia o, si no, como mucho cada seis horas. */
export function noteSocialFollowers(db: DB, data: SocialAccountData, now: () => string = () => new Date().toISOString()): void {
  if (data.followers == null) return
  const t = now()
  const u = db.prepare('SELECT measured_at, followers FROM social_account_snapshots WHERE platform = ? AND account = ? ORDER BY measured_at DESC, id DESC LIMIT 1').get(data.platform, data.account) as Row | undefined
  if (u && u.followers === data.followers && Date.parse(t) - Date.parse(u.measured_at) < 6 * 3600_000) return
  db.prepare('INSERT INTO social_account_snapshots (platform, account, measured_at, followers, video_count) VALUES (?, ?, ?, ?, ?)').run(data.platform, data.account, t, data.followers, data.videoCount)
}
