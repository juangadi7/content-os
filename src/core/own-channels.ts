/**
 * Canales propios (16-nov-2026): GTA 6, Curiosidades e Historias Roblox.
 *
 * Cada canal tiene sus vídeos (las carpetas VIDEOS_GTA6, VIDEOS_CURIOSIDADES y VIDEOS_ROBLOX), sus cuentas en
 * TikTok, YouTube e Instagram (las apunta el usuario) y, por cada vídeo, dónde se ha subido (own_posts).
 *
 * De dónde sale cada cifra (se guarda y se enseña):
 *   - «api»: YouTube (clave de API, canales añadidos como personales) y TikTok/Instagram (API oficial de las cuentas
 *     conectadas en .secretos). Son las tablas youtube_video_snapshots y social_video_snapshots.
 *   - «manual»: lo que el usuario apunta en la app (own_post_stats). La retención solo llega así.
 *   - «metricool»: reservado para cuando la subida la haga Metricool (misma tabla, otro origen).
 * Nada se inventa ni se interpola: una cifra que no se ha medido es null, nunca cero.
 */
import type { DB } from './db'
import { parseTikTokUrl } from './tiktok'
import { parseYouTubeVideoId, shortUrl } from './youtube'
import { normalizeText } from './youtube-channels'

export const OWN_CHANNELS = ['gta', 'curio', 'roblox'] as const
export type OwnChannel = (typeof OWN_CHANNELS)[number]
export const asOwnChannel = (v: unknown): OwnChannel | null => (OWN_CHANNELS.includes(v as OwnChannel) ? (v as OwnChannel) : null)
export const OWN_NAMES: Record<OwnChannel, string> = { gta: 'GTA 6', curio: 'Curiosidades', roblox: 'Historias Roblox' }

export const OWN_PLATFORMS = ['tiktok', 'youtube', 'instagram'] as const
export type OwnPlatform = (typeof OWN_PLATFORMS)[number]
export const asOwnPlatform = (v: unknown): OwnPlatform | null => (OWN_PLATFORMS.includes(v as OwnPlatform) ? (v as OwnPlatform) : null)

export type DataSource = 'api' | 'manual' | 'metricool'
export const METRICS = ['views', 'likes', 'comments', 'shares', 'retention'] as const
export type Metric = (typeof METRICS)[number]

type Row = Record<string, any>
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const ahora = () => new Date().toISOString()

// ---------------------------------------------------------------- cuentas

export interface OwnAccountView {
  id: number
  channel: OwnChannel
  platform: OwnPlatform
  account: string
  /** api = sus cifras llegan solas; manual = hay que apuntarlas (o conectar la cuenta). */
  source: DataSource
  /** Por qué es «manual» o qué falta, en palabras sencillas. */
  note: string | null
  followers: number | null
  followersAt: string | null
}

/** Cuenta tal y como se guarda: con @ delante (salvo que sea un id de canal de YouTube). */
export function normalizeAccount(platform: OwnPlatform, texto: unknown): string | null {
  if (typeof texto !== 'string') return null
  let t = texto.trim()
  const url = /(?:youtube\.com\/|tiktok\.com\/|instagram\.com\/)(@?[A-Za-z0-9._-]+)/i.exec(t)
  if (url) t = url[1]
  t = t.replace(/\/+$/, '')
  if (!t) return null
  if (platform === 'youtube' && /^UC[A-Za-z0-9_-]{22}$/.test(t)) return t
  if (!/^@?[A-Za-z0-9._-]{2,60}$/.test(t)) return null
  return '@' + t.replace(/^@+/, '')
}

/** Canal de YouTube seguido que corresponde a la cuenta (por @ o por id). */
function youtubeChannelOf(db: DB, account: string): Row | undefined {
  return db.prepare('SELECT * FROM youtube_channels WHERE lower(handle) = lower(?) OR channel_id = ?').get(account, account) as Row | undefined
}

function socialAccountOf(db: DB, platform: 'tiktok' | 'instagram', account: string): Row | undefined {
  return db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND lower(account) = lower(?)').get(platform, account) as Row | undefined
}

export function listOwnAccounts(db: DB, channel?: OwnChannel, connected: { platform: string; account: string }[] = []): OwnAccountView[] {
  const filas = (channel
    ? db.prepare('SELECT * FROM own_accounts WHERE channel = ? ORDER BY platform, account').all(channel)
    : db.prepare('SELECT * FROM own_accounts ORDER BY channel, platform, account').all()) as Row[]
  return filas.map((f) => {
    const platform = f.platform as OwnPlatform
    let source: DataSource = 'manual'
    let note: string | null = null
    let followers: number | null = null
    let followersAt: string | null = null
    if (platform === 'youtube') {
      const c = youtubeChannelOf(db, f.account)
      if (c) {
        source = 'api'
        followers = num(c.subscribers)
        followersAt = c.stats_at ?? null
      } else note = 'Conecta YouTube en Ajustes para que sus cifras lleguen solas.'
    } else {
      const s = socialAccountOf(db, platform, f.account)
      const conectada = connected.some((c) => c.platform === platform && c.account.replace(/^@/, '').toLowerCase() === String(f.account).replace(/^@/, '').toLowerCase())
      if (s || conectada) {
        source = 'api'
        followers = num(s?.followers)
        followersAt = s?.stats_at ?? null
        if (!s) note = 'Conectada: sus cifras llegan en la próxima lectura (cada 30 min).'
      } else {
        note = platform === 'tiktok'
          ? 'Sin conectar: apunta sus cifras a mano (o autorízala como @juanriclipss).'
          : 'Sin conectar: apunta sus cifras a mano.'
      }
    }
    return { id: f.id, channel: f.channel, platform, account: f.account, source, note, followers, followersAt }
  })
}

export function addOwnAccount(db: DB, channel: unknown, platform: unknown, account: unknown, now = ahora()): { channel: OwnChannel; platform: OwnPlatform; account: string } {
  const c = asOwnChannel(channel)
  const p = asOwnPlatform(platform)
  if (!c) throw new Error('Canal no válido.')
  if (!p) throw new Error('Red no válida.')
  const a = normalizeAccount(p, account)
  if (!a) throw new Error('Escribe la cuenta como @nombre (o pega el enlace del perfil).')
  db.prepare('INSERT OR IGNORE INTO own_accounts (channel, platform, account, created_at) VALUES (?, ?, ?, ?)').run(c, p, a, now)
  return { channel: c, platform: p, account: a }
}

export function removeOwnAccount(db: DB, id: unknown): void {
  if (typeof id !== 'number') throw new Error('Cuenta no válida.')
  db.prepare('DELETE FROM own_accounts WHERE id = ?').run(id)
}

// ---------------------------------------------------------------- subidas

export interface OwnPostInput {
  channel: unknown
  video: unknown
  platform: unknown
  uploaded: boolean
  url?: unknown
  account?: unknown
}

/** Id del vídeo en la red a partir de su enlace (null si no se reconoce). */
export function extIdFromUrl(platform: OwnPlatform, url: string | null): string | null {
  if (!url) return null
  if (platform === 'youtube') return parseYouTubeVideoId(url)
  if (platform === 'tiktok') return parseTikTokUrl(url)?.videoId ?? null
  return null // Instagram: el enlace no lleva el id de la API; se empareja por el enlace
}

const primeraCuenta = (db: DB, channel: OwnChannel, platform: OwnPlatform) =>
  ((db.prepare('SELECT account FROM own_accounts WHERE channel = ? AND platform = ? ORDER BY id LIMIT 1').get(channel, platform) as Row | undefined)?.account as string | undefined) ?? ''

/** Marca (o desmarca) un vídeo como subido a una red. Desmarcar borra también las cifras apuntadas a mano de esa subida. */
export function setOwnPost(db: DB, input: OwnPostInput, now = ahora()): void {
  const c = asOwnChannel(input.channel)
  const p = asOwnPlatform(input.platform)
  if (!c || !p) throw new Error('Canal o red no válidos.')
  if (typeof input.video !== 'string' || !input.video) throw new Error('Vídeo no válido.')
  if (!input.uploaded) {
    db.prepare('DELETE FROM own_posts WHERE channel = ? AND video = ? AND platform = ?').run(c, input.video, p)
    return
  }
  const url = typeof input.url === 'string' && /^https?:\/\//i.test(input.url.trim()) ? input.url.trim() : null
  const cuenta = typeof input.account === 'string' && input.account.trim() ? normalizeAccount(p, input.account) ?? '' : primeraCuenta(db, c, p)
  const ext = extIdFromUrl(p, url)
  const ya = db.prepare('SELECT * FROM own_posts WHERE channel = ? AND video = ? AND platform = ?').get(c, input.video, p) as Row | undefined
  if (ya) {
    db.prepare('UPDATE own_posts SET url = COALESCE(?, url), ext_id = COALESCE(?, ext_id), account = CASE WHEN ? <> \'\' THEN ? ELSE account END WHERE id = ?')
      .run(url, ext, cuenta, cuenta, ya.id)
  } else {
    db.prepare('INSERT INTO own_posts (channel, video, platform, account, url, ext_id, posted_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'manual\', ?)')
      .run(c, input.video, p, cuenta, url, ext, now, now)
  }
}

export interface OwnStatsInput {
  channel: unknown
  video: unknown
  platform: unknown
  views?: unknown
  likes?: unknown
  comments?: unknown
  shares?: unknown
  /** % medio visto, 0-100. */
  retention?: unknown
  /** YouTube Studio, «Vieron vs. deslizaron»: % que se quedó a verlo (0-100). */
  viewedPct?: unknown
  /** YouTube Studio: duración media vista, en segundos. */
  avgViewS?: unknown
  url?: unknown
}

const segundos = (v: unknown): number | null => {
  if (typeof v === 'string' && !v.trim()) return null
  // acepta «23», «23,5» o «0:23» (como lo enseña YouTube Studio)
  if (typeof v === 'string' && /^\d+:\d{1,2}$/.test(v.trim())) {
    const [m, s] = v.trim().split(':').map(Number)
    return m * 60 + s
  }
  const n = typeof v === 'string' ? Number(v.replace('s', '').replace(',', '.').trim()) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 36000 ? Math.round(n * 10) / 10 : null
}

const entero = (v: unknown): number | null => {
  if (typeof v === 'string' && !v.trim()) return null // en blanco = no se sabe (no es un cero)
  const n = typeof v === 'string' ? Number(v.replace(/[.\s]/g, '').replace(',', '.')) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}
const porcentaje = (v: unknown): number | null => {
  if (typeof v === 'string' && !v.trim()) return null
  const n = typeof v === 'string' ? Number(v.replace('%', '').replace(',', '.').trim()) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null
}

/** Apunta a mano las cifras de un vídeo en una red (si no estaba marcado como subido, lo marca). */
export function addOwnStats(db: DB, input: OwnStatsInput, now = ahora()): void {
  const c = asOwnChannel(input.channel)
  const p = asOwnPlatform(input.platform)
  if (!c || !p || typeof input.video !== 'string') throw new Error('Vídeo no válido.')
  const valores = { views: entero(input.views), likes: entero(input.likes), comments: entero(input.comments), shares: entero(input.shares), retention: porcentaje(input.retention) }
  if (input.retention != null && input.retention !== '' && valores.retention == null) throw new Error('La retención es un porcentaje entre 0 y 100.')
  const studio = { viewedPct: porcentaje(input.viewedPct), avgViewS: segundos(input.avgViewS) }
  if (input.viewedPct != null && input.viewedPct !== '' && studio.viewedPct == null) throw new Error('«Vieron» es un porcentaje entre 0 y 100.')
  if (input.avgViewS != null && input.avgViewS !== '' && studio.avgViewS == null) throw new Error('La duración media va en segundos (por ejemplo 23 o 0:23).')
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined
  setOwnPost(db, { channel: c, video: input.video, platform: p, uploaded: true, url }, now)
  if ([...Object.values(valores), ...Object.values(studio)].every((v) => v == null)) return
  const post = db.prepare('SELECT id FROM own_posts WHERE channel = ? AND video = ? AND platform = ?').get(c, input.video, p) as Row
  db.prepare('INSERT INTO own_post_stats (post_id, measured_at, views, likes, comments, shares, retention, viewed_pct, avg_view_s, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'manual\')')
    .run(post.id, now, valores.views, valores.likes, valores.comments, valores.shares, valores.retention, studio.viewedPct, studio.avgViewS)
}

/** Fila de `youtube_manual.json` (lo que lee la fábrica de Curiosidades: `fabrica/datos/youtube_manual.json`). */
export interface YouTubeManualRow {
  /** Id del vídeo de YouTube (la clave para la fábrica). */
  id: string
  titulo: string
  vieron_pct: number | null
  retencion_media_pct: number | null
  duracion_media_vista_s: number | null
  visitas: number | null
  /** Día (AAAA-MM-DD) de la última cifra apuntada. */
  fecha_apuntado: string | null
}

/**
 * Lo apuntado a mano de YouTube Studio para cada Short del canal: la última cifra de cada dato.
 * Solo los vídeos con su id de YouTube (emparejados solos o con el enlace pegado); sin id, la fábrica no los reconoce.
 */
export function youtubeManualRows(db: DB, channel: OwnChannel, titles: Map<string, string>): YouTubeManualRow[] {
  const posts = db.prepare("SELECT * FROM own_posts WHERE channel = ? AND platform = 'youtube' AND ext_id IS NOT NULL ORDER BY posted_at").all(channel) as Row[]
  const out: YouTubeManualRow[] = []
  for (const p of posts) {
    const filas = db.prepare("SELECT * FROM own_post_stats WHERE post_id = ? AND origin = 'manual' ORDER BY measured_at").all(p.id) as Row[]
    if (!filas.length) continue
    const ultimo = (k: string): number | null => {
      for (let i = filas.length - 1; i >= 0; i--) if (num(filas[i][k]) != null) return num(filas[i][k])
      return null
    }
    out.push({
      id: p.ext_id,
      titulo: titles.get(p.video) ?? p.video,
      vieron_pct: ultimo('viewed_pct'),
      retencion_media_pct: ultimo('retention'),
      duracion_media_vista_s: ultimo('avg_view_s'),
      visitas: ultimo('views'),
      fecha_apuntado: localDay(filas.at(-1)!.measured_at)
    })
  }
  return out
}

/**
 * Las marcas antiguas («subido a YouTube», clave settings "<canal>_upload:<carpeta>") pasan a own_posts.
 * Se hace una vez por marca: después la marca vieja se borra. Devuelve cuántas pasó.
 */
export function adoptLegacyMarks(db: DB, channel: OwnChannel): number {
  const filas = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`${channel}_upload:%`) as Row[]
  let n = 0
  for (const f of filas) {
    const video = String(f.key).slice(`${channel}_upload:`.length)
    if (!video || Number.isNaN(Date.parse(f.value))) continue
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO own_posts (channel, video, platform, account, posted_at, source, created_at) VALUES (?, ?, \'youtube\', ?, ?, \'manual\', ?)')
        .run(channel, video, primeraCuenta(db, channel, 'youtube'), f.value, f.value)
      db.prepare('DELETE FROM settings WHERE key = ?').run(f.key)
    })()
    n++
  }
  return n
}

/** Fecha de subida por red de cada vídeo del canal (para las marcas de la lista de vídeos). */
export function ownUploads(db: DB, channel: OwnChannel): Map<string, Partial<Record<OwnPlatform, string>>> {
  const out = new Map<string, Partial<Record<OwnPlatform, string>>>()
  for (const f of db.prepare('SELECT video, platform, posted_at, created_at FROM own_posts WHERE channel = ?').all(channel) as Row[]) {
    const m = out.get(f.video) ?? {}
    m[f.platform as OwnPlatform] = f.posted_at ?? f.created_at
    out.set(f.video, m)
  }
  return out
}

// ---------------------------------------------------------------- emparejar solo con lo que dan las API

export interface OwnVideoRef {
  /** Carpeta del vídeo. */
  id: string
  title: string | null
  description: string | null
}

/** ¿Este texto de la red corresponde a este vídeo? Título igual, o el texto contiene el título o el principio de la descripción. */
function coincide(texto: string | null, v: OwnVideoRef): boolean {
  const t = normalizeText(texto)
  if (!t) return false
  const titulo = normalizeText(v.title)
  if (titulo && (t === titulo || (titulo.length >= 18 && t.includes(titulo)) || (t.length >= 18 && titulo.startsWith(t)))) return true
  const desc = normalizeText(v.description).slice(0, 48).trim()
  return desc.length >= 24 && t.includes(desc)
}

/**
 * Busca en los vídeos que ya leen las API (canales de YouTube seguidos y cuentas de TikTok/Instagram) los de las cuentas
 * del canal, y los empareja con su carpeta cuando hay UNA única coincidencia clara. Así se marcan solos como subidos y
 * sus cifras llegan sin tocar nada. Lo dudoso no se empareja. Devuelve cuántos emparejó.
 */
export function autoLinkOwn(db: DB, channel: OwnChannel, videos: OwnVideoRef[], now = ahora()): number {
  const cuentas = db.prepare('SELECT platform, account FROM own_accounts WHERE channel = ?').all(channel) as Row[]
  if (!cuentas.length || !videos.length) return 0
  const usados = new Set((db.prepare('SELECT platform, ext_id FROM own_posts WHERE ext_id IS NOT NULL').all() as Row[]).map((r) => `${r.platform}:${r.ext_id}`))
  let n = 0
  for (const cu of cuentas) {
    const platform = cu.platform as OwnPlatform
    let candidatos: { ext: string; texto: string | null; url: string | null; publicado: string | null }[] = []
    if (platform === 'youtube') {
      const canal = youtubeChannelOf(db, cu.account)
      if (!canal) continue
      candidatos = (db.prepare('SELECT video_id, title, published_at FROM youtube_videos WHERE channel_id = ? AND match_state <> \'ignored\'').all(canal.channel_id) as Row[])
        .map((r) => ({ ext: r.video_id, texto: r.title, url: shortUrl(r.video_id), publicado: r.published_at }))
    } else {
      candidatos = (db.prepare('SELECT video_id, description, url, published_at FROM social_videos WHERE platform = ? AND lower(account) = lower(?) AND removed_at IS NULL').all(platform, cu.account) as Row[])
        .map((r) => ({ ext: r.video_id, texto: r.description, url: r.url, publicado: r.published_at }))
    }
    candidatos = candidatos.filter((c) => !usados.has(`${platform}:${c.ext}`))
    for (const v of videos) {
      const ya = db.prepare('SELECT * FROM own_posts WHERE channel = ? AND video = ? AND platform = ?').get(channel, v.id, platform) as Row | undefined
      if (ya?.ext_id) continue
      const encaja = candidatos.filter((c) => coincide(c.texto, v))
      if (encaja.length !== 1) continue
      // y ese vídeo de la red no puede encajar también con otra carpeta
      if (videos.filter((o) => coincide(encaja[0].texto, o)).length !== 1) continue
      const c = encaja[0]
      if (ya) {
        db.prepare('UPDATE own_posts SET ext_id = ?, url = COALESCE(url, ?), account = CASE WHEN account = \'\' THEN ? ELSE account END, posted_at = COALESCE(?, posted_at) WHERE id = ?')
          .run(c.ext, c.url, cu.account, c.publicado, ya.id)
      } else {
        db.prepare('INSERT INTO own_posts (channel, video, platform, account, url, ext_id, posted_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'api\', ?)')
          .run(channel, v.id, platform, cu.account, c.url, c.ext, c.publicado ?? now, now)
      }
      usados.add(`${platform}:${c.ext}`)
      candidatos = candidatos.filter((x) => x !== c)
      n++
    }
  }
  return n
}

// ---------------------------------------------------------------- cifras

export interface Measurement {
  t: string
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  retention: number | null
  origin: DataSource
}

/** Todas las mediciones de una subida (API + a mano), de la más antigua a la más reciente. */
function measurementsOf(db: DB, post: Row): Measurement[] {
  const out: Measurement[] = []
  if (post.ext_id && post.platform === 'youtube') {
    for (const s of db.prepare('SELECT measured_at, views, likes, comments FROM youtube_video_snapshots WHERE video_id = ? ORDER BY measured_at').all(post.ext_id) as Row[]) {
      out.push({ t: s.measured_at, views: num(s.views), likes: num(s.likes), comments: num(s.comments), shares: null, retention: null, origin: 'api' })
    }
  } else if (post.ext_id && (post.platform === 'tiktok' || post.platform === 'instagram')) {
    for (const s of db.prepare('SELECT measured_at, views, likes, comments, shares FROM social_video_snapshots WHERE platform = ? AND video_id = ? ORDER BY measured_at').all(post.platform, post.ext_id) as Row[]) {
      out.push({ t: s.measured_at, views: num(s.views), likes: num(s.likes), comments: num(s.comments), shares: num(s.shares), retention: null, origin: 'api' })
    }
  }
  for (const s of db.prepare('SELECT * FROM own_post_stats WHERE post_id = ? ORDER BY measured_at').all(post.id) as Row[]) {
    out.push({ t: s.measured_at, views: num(s.views), likes: num(s.likes), comments: num(s.comments), shares: num(s.shares), retention: num(s.retention), origin: (s.origin as DataSource) ?? 'manual' })
  }
  return out.sort((a, b) => a.t.localeCompare(b.t))
}

export interface OwnPostStats {
  platform: OwnPlatform
  account: string
  url: string | null
  postedAt: string | null
  /** Quién apuntó la subida. */
  source: DataSource
  /** Última cifra conocida de cada dato (null = sin medir). */
  latest: Record<Metric, number | null>
  /** De dónde sale cada una de esas cifras. */
  origin: Partial<Record<Metric, DataSource>>
  measuredAt: string | null
  /** Visitas medidas, en orden (para la gráfica y la comparación). */
  series: { t: string; views: number }[]
  /** Datos de YouTube Studio apuntados a mano (última cifra de cada uno). */
  studio: { viewedPct: number | null; avgViewS: number | null }
  /** Id del vídeo en la red (null si aún no se sabe: sin enlace ni emparejado). */
  extId: string | null
}

export interface OwnVideoStats {
  id: string
  title: string
  posts: OwnPostStats[]
  /** Suma de las redes (solo de lo medido). */
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  /** Media de la retención apuntada en sus redes. */
  retention: number | null
  /** Primera subida. */
  postedAt: string | null
}

export interface OwnDay {
  /** Día local AAAA-MM-DD. */
  day: string
  /** Visitas acumuladas ese día (última medición conocida de cada subida), por red y en total. */
  total: number
  byPlatform: Partial<Record<OwnPlatform, number>>
}

export interface OwnHourSlot {
  /** Franja de 3 horas: de `from` a `from + 3`. */
  from: number
  /** Vídeos con cifra madura (entre 24 h y 4 días después de subirlos) subidos en esa franja. */
  videos: number
  /** Mediana de esas visitas; null si no hay vídeos. */
  median: number | null
}

export interface OwnFollowers {
  platform: OwnPlatform
  account: string
  /** Mediciones de seguidores (suscriptores en YouTube), de la más antigua a la más reciente. */
  series: { t: string; value: number }[]
}

export interface OwnChannelStats {
  channel: OwnChannel
  name: string
  accounts: OwnAccountView[]
  videos: OwnVideoStats[]
  daily: OwnDay[]
  bestHours: OwnHourSlot[]
  followers: OwnFollowers[]
  /** De dónde salen los datos de cada red, en este canal (para enseñarlo junto a cada cifra). */
  sources: Record<OwnPlatform, Partial<Record<Metric, DataSource[]>>>
}

const mediana = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

export function localDay(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Visitas «maduras» de una subida: la medición más cercana a las 48 h, entre 24 h y 96 h. */
export function matureViews(postedAt: string | null, series: { t: string; views: number }[]): number | null {
  if (!postedAt) return null
  const t0 = Date.parse(postedAt)
  if (Number.isNaN(t0)) return null
  let mejor: { d: number; v: number } | null = null
  for (const s of series) {
    const h = (Date.parse(s.t) - t0) / 3600_000
    if (h < 24 || h > 96) continue
    const d = Math.abs(h - 48)
    if (!mejor || d < mejor.d) mejor = { d, v: s.views }
  }
  return mejor?.v ?? null
}

/** Estadísticas de un canal propio. Empareja antes lo que las API ya conocen. */
export function getOwnChannelStats(db: DB, channel: OwnChannel, videos: OwnVideoRef[], connected: { platform: string; account: string }[] = []): OwnChannelStats {
  try {
    autoLinkOwn(db, channel, videos)
  } catch {
    /* emparejar es una ayuda: si falla, se enseña lo que haya */
  }
  const titulo = new Map(videos.map((v) => [v.id, v.title ?? v.id]))
  const posts = (db.prepare('SELECT * FROM own_posts WHERE channel = ? ORDER BY posted_at').all(channel) as Row[]).filter((p) => titulo.has(p.video))
  const sources = Object.fromEntries(OWN_PLATFORMS.map((p) => [p, {}])) as OwnChannelStats['sources']
  const porVideo = new Map<string, OwnPostStats[]>()
  const todas: { platform: OwnPlatform; ms: Measurement[] }[] = []
  for (const p of posts) {
    const ms = measurementsOf(db, p)
    todas.push({ platform: p.platform, ms })
    const latest = Object.fromEntries(METRICS.map((m) => [m, null])) as Record<Metric, number | null>
    const origin: Partial<Record<Metric, DataSource>> = {}
    for (const m of METRICS) {
      for (let i = ms.length - 1; i >= 0; i--) {
        const v = ms[i][m]
        if (v != null) {
          latest[m] = v
          origin[m] = ms[i].origin
          const lista = (sources[p.platform as OwnPlatform][m] ??= [])
          if (!lista.includes(ms[i].origin)) lista.push(ms[i].origin)
          break
        }
      }
    }
    const fila: OwnPostStats = {
      platform: p.platform, account: p.account, url: p.url, postedAt: p.posted_at ?? p.created_at, source: p.source,
      latest, origin, measuredAt: ms.at(-1)?.t ?? null,
      series: ms.filter((m) => m.views != null).map((m) => ({ t: m.t, views: m.views as number })),
      studio: {
        viewedPct: num((db.prepare('SELECT viewed_pct FROM own_post_stats WHERE post_id = ? AND viewed_pct IS NOT NULL ORDER BY measured_at DESC LIMIT 1').get(p.id) as Row | undefined)?.viewed_pct),
        avgViewS: num((db.prepare('SELECT avg_view_s FROM own_post_stats WHERE post_id = ? AND avg_view_s IS NOT NULL ORDER BY measured_at DESC LIMIT 1').get(p.id) as Row | undefined)?.avg_view_s)
      },
      extId: p.ext_id ?? null
    }
    porVideo.set(p.video, [...(porVideo.get(p.video) ?? []), fila])
  }

  const suma = (xs: (number | null)[]) => (xs.some((x) => x != null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null)
  const lista: OwnVideoStats[] = videos.map((v) => {
    const ps = porVideo.get(v.id) ?? []
    const ret = ps.map((p) => p.latest.retention).filter((x): x is number => x != null)
    return {
      id: v.id,
      title: v.title ?? v.id,
      posts: ps,
      views: suma(ps.map((p) => p.latest.views)),
      likes: suma(ps.map((p) => p.latest.likes)),
      comments: suma(ps.map((p) => p.latest.comments)),
      shares: suma(ps.map((p) => p.latest.shares)),
      retention: ret.length ? Math.round((ret.reduce((a, b) => a + b, 0) / ret.length) * 10) / 10 : null,
      postedAt: ps.map((p) => p.postedAt).filter((x): x is string => !!x).sort()[0] ?? null
    }
  })

  // evolución: por cada día con alguna medición, suma de la última medición conocida de cada subida
  const dias = [...new Set(todas.flatMap((x) => x.ms.filter((m) => m.views != null).map((m) => localDay(m.t))))].sort()
  const daily: OwnDay[] = dias.map((day) => {
    const byPlatform: Partial<Record<OwnPlatform, number>> = {}
    let total = 0
    for (const x of todas) {
      const hasta = x.ms.filter((m) => m.views != null && localDay(m.t) <= day).at(-1)
      if (!hasta) continue
      byPlatform[x.platform] = (byPlatform[x.platform] ?? 0) + (hasta.views as number)
      total += hasta.views as number
    }
    return { day, total, byPlatform }
  })

  // mejor hora: visitas maduras de cada subida según la hora (local) a la que salió
  const franjas = new Map<number, number[]>()
  for (const ps of porVideo.values()) {
    for (const p of ps) {
      const v = matureViews(p.postedAt, p.series)
      if (v == null || !p.postedAt) continue
      const desde = Math.floor(new Date(p.postedAt).getHours() / 3) * 3
      franjas.set(desde, [...(franjas.get(desde) ?? []), v])
    }
  }
  const bestHours: OwnHourSlot[] = [0, 3, 6, 9, 12, 15, 18, 21].map((from) => ({ from, videos: franjas.get(from)?.length ?? 0, median: mediana(franjas.get(from) ?? []) }))

  const accounts = listOwnAccounts(db, channel, connected)
  const followers: OwnFollowers[] = accounts.map((a) => {
    let serie: { t: string; value: number }[] = []
    if (a.platform === 'youtube') {
      const c = youtubeChannelOf(db, a.account)
      if (c) serie = (db.prepare('SELECT measured_at, subscribers FROM youtube_channel_snapshots WHERE channel_id = ? AND subscribers IS NOT NULL ORDER BY measured_at').all(c.channel_id) as Row[]).map((r) => ({ t: r.measured_at, value: r.subscribers }))
    } else {
      serie = (db.prepare('SELECT measured_at, followers FROM social_account_snapshots WHERE platform = ? AND lower(account) = lower(?) AND followers IS NOT NULL ORDER BY measured_at').all(a.platform, a.account) as Row[]).map((r) => ({ t: r.measured_at, value: r.followers }))
    }
    if (!serie.length && a.followers != null) serie = [{ t: a.followersAt ?? ahora(), value: a.followers }]
    return { platform: a.platform, account: a.account, series: serie }
  })

  return { channel, name: OWN_NAMES[channel], accounts, videos: lista, daily, bestHours, followers, sources }
}
