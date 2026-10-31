/**
 * Canales de YouTube: descubrir solos los vídeos subidos, emparejarlos con su clip y medirlos.
 * Así no hay que pegar la URL de cada vídeo. Todo son datos propios de CONTENT OS.
 *
 * Emparejar es delicado: un error atribuiría las cifras de un vídeo al clip que no es. Por eso
 * solo se empareja solo cuando hay UNA única coincidencia clara; lo demás queda a la vista para
 * que lo decida el usuario con un clic.
 */
import type { DB } from './db'
import { fetchChannel, fetchChannelStats, fetchUploads, fetchVideoDetails, parseChannelRef, parseYouTubeVideoId, shortUrl, YouTubeApiError, type FetchLike, type VideoDetails } from './youtube'

export type ChannelKind = 'clips' | 'personal'

export interface ChannelView {
  channelId: string
  kind: ChannelKind
  handle: string | null
  title: string | null
  addedAt: string
  lastScanAt: string | null
  videos: number
  linked: number
}

export interface ChannelSyncSummary {
  channels: number
  /** Vídeos vistos en los canales. */
  videos: number
  /** Emparejados solos en esta pasada. */
  linkedNow: number
  /** Sin emparejar (a la espera de que el usuario decida). */
  unmatched: number
  /** Mediciones nuevas guardadas. */
  measured: number
}

export interface MatchCandidate {
  clipId: string
  title: string | null
  caption: string | null
  duration: number | null
}

type Row = Record<string, any>

/** Diferencia máxima de duración entre el vídeo de YouTube y el clip para considerarlos el mismo. */
export const DURATION_TOLERANCE = 2.0
/** No guardar otra medición del mismo vídeo antes de estos minutos. */
export const MIN_INTERVAL_MINUTES = 15

/** Texto comparable: sin hashtags, sin emojis ni signos, en minúsculas. */
export function normalizeText(t: string | null | undefined): string {
  return (t ?? '')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Clip al que corresponde un vídeo, o null si no hay una única coincidencia clara.
 *   - el título del vídeo es el del clip (o empieza por él), o su descripción contiene la del clip;
 *   - y, si se conocen ambas duraciones, no difieren en más de DURATION_TOLERANCE segundos.
 */
export function matchVideoToClip(video: Pick<VideoDetails, 'title' | 'description' | 'durationSeconds'>, clips: MatchCandidate[]): { clipId: string; reason: string } | null {
  const vt = normalizeText(video.title)
  const vd = normalizeText(video.description)
  const encontrados: { clipId: string; reason: string }[] = []
  for (const c of clips) {
    if (video.durationSeconds != null && c.duration != null && Math.abs(video.durationSeconds - c.duration) > DURATION_TOLERANCE) continue
    const ct = normalizeText(c.title)
    const cc = normalizeText(c.caption).slice(0, 60)
    let reason: string | null = null
    if (ct.length >= 8 && vt === ct) reason = 'mismo título'
    else if (ct.length >= 12 && (vt.startsWith(ct + ' ') || vd.startsWith(ct + ' ') || vd === ct)) reason = 'el título del clip abre el del vídeo'
    else if (cc.length >= 30 && (vd.includes(cc) || vt.includes(cc))) reason = 'misma descripción'
    if (reason) encontrados.push({ clipId: c.clipId, reason: video.durationSeconds != null && c.duration != null ? `${reason} y misma duración` : reason })
  }
  return encontrados.length === 1 ? encontrados[0] : null
}

/** Canales seguidos; con `kind`, solo los de ese tipo. */
export function listChannels(db: DB, kind?: ChannelKind): ChannelView[] {
  const filas = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM youtube_videos v WHERE v.channel_id = c.channel_id) AS n,
       (SELECT COUNT(*) FROM youtube_videos v WHERE v.channel_id = c.channel_id AND v.publication_id IS NOT NULL) AS linked
     FROM youtube_channels c ORDER BY c.added_at`
  ).all() as Row[]
  return filas.filter((c) => !kind || c.kind === kind).map((c) => ({ channelId: c.channel_id, kind: c.kind, handle: c.handle, title: c.title, addedAt: c.added_at, lastScanAt: c.last_scan_at, videos: c.n, linked: c.linked }))
}

/** Comprueba el canal contra YouTube y lo guarda. */
export async function addChannel(db: DB, texto: string, apiKey: string, fetchImpl: FetchLike, now: () => string = () => new Date().toISOString(), kind: ChannelKind = 'clips'): Promise<ChannelView> {
  const ref = parseChannelRef(texto)
  if (!ref) throw new YouTubeApiError('not_found', 'Escribe el @nombre del canal o pega su URL (youtube.com/@nombre).')
  const info = await fetchChannel(ref, apiKey, fetchImpl)
  // un canal es de un tipo o del otro: en los dos apartados se contaría dos veces y sus vídeos se intentarían emparejar
  const previo = db.prepare('SELECT kind FROM youtube_channels WHERE channel_id = ?').get(info.channelId) as Row | undefined
  if (previo && previo.kind !== kind) {
    throw new YouTubeApiError('not_found', previo.kind === 'clips' ? 'Ese canal ya está en «Canales», con los de clips. Quítalo de allí antes de añadirlo aquí.' : 'Ese canal ya está en «Canales personales». Quítalo de allí antes de añadirlo aquí.')
  }
  db.prepare(
    `INSERT INTO youtube_channels (channel_id, handle, title, uploads_playlist, added_at, kind) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET handle = excluded.handle, title = excluded.title, uploads_playlist = excluded.uploads_playlist`
  ).run(info.channelId, info.handle, info.title, info.uploadsPlaylist, now(), kind)
  return listChannels(db).find((c) => c.channelId === info.channelId)!
}

/**
 * Pasa un canal personal a los de clips sin perder nada: sus vídeos y su historial se quedan y, en la siguiente
 * sincronización, sus vídeos se emparejan con los clips (los que no sean de campaña quedan para decidir).
 */
export function moveChannelToClips(db: DB, channelId: string): void {
  const c = db.prepare('SELECT kind FROM youtube_channels WHERE channel_id = ?').get(channelId) as Row | undefined
  if (!c) throw new Error('Ese canal no está en la aplicación.')
  if (c.kind === 'clips') return
  db.prepare("UPDATE youtube_channels SET kind = 'clips' WHERE channel_id = ?").run(channelId)
}

/** Deja de seguir un canal. Las publicaciones y mediciones ya guardadas se conservan. */
export function removeChannel(db: DB, channelId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM youtube_video_snapshots WHERE video_id IN (SELECT video_id FROM youtube_videos WHERE channel_id = ?)').run(channelId)
    db.prepare('DELETE FROM youtube_channel_snapshots WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM youtube_videos WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM youtube_channels WHERE channel_id = ?').run(channelId)
  })()
}

/**
 * Publicación de YouTube marcada en la app (sin enlace) en este canal y a la misma hora que el vídeo (±3 h).
 * Solo si hay una clara: la más cercana y con al menos una hora de diferencia con la siguiente.
 */
function publicacionSinEnlace(db: DB, canal: Row, publishedAt: string | null): Row | null {
  if (!publishedAt) return null
  const nombre = (x: unknown) => String(x ?? '').replace(/ · .*$/, '').replace(/^@/, '').trim().toLowerCase()
  const suyo = [canal.handle, canal.title].filter(Boolean).map(nombre)
  const t = Date.parse(publishedAt)
  const cand = (db.prepare("SELECT id, clip_id, account, published_at FROM publications WHERE platform = 'youtube' AND status = 'published' AND (url IS NULL OR url = '') AND published_at IS NOT NULL").all() as Row[])
    .filter((p) => suyo.includes(nombre(p.account)) && Math.abs(Date.parse(p.published_at) - t) <= 3 * 3600_000)
    .filter((p) => !db.prepare('SELECT 1 FROM youtube_videos WHERE publication_id = ?').get(p.id))
    .map((p) => ({ p, gap: Math.abs(Date.parse(p.published_at) - t) }))
    .sort((a, b) => a.gap - b.gap)
  if (!cand.length || (cand[1] && cand[1].gap - cand[0].gap < 3600_000)) return null
  return cand[0].p
}

/** Asocia un vídeo a un clip: usa la publicación de YouTube que ya tenga el clip o crea una. */
function attach(db: DB, video: Row, clipId: string, state: 'auto' | 'manual', reason: string, canal: Row, t: string): number {
  const url = shortUrl(video.video_id)
  const cuenta: string = canal.handle ?? canal.title ?? ''
  const pubs = db.prepare("SELECT * FROM publications WHERE clip_id = ? AND platform = 'youtube' ORDER BY id").all(clipId) as Row[]
  let pub = pubs.find((p) => parseYouTubeVideoId(p.url) === video.video_id) ?? pubs.find((p) => !p.url)
  if (pub) {
    // se completa lo que faltaba; la cuenta solo si estaba vacía y no choca con otra publicación
    const cuentaLibre = pub.account === '' && !pubs.some((p) => p.id !== pub!.id && p.account === cuenta)
    db.prepare('UPDATE publications SET url = COALESCE(url, ?), published_at = COALESCE(?, published_at), account = ?, title_used = COALESCE(title_used, ?), updated_at = ? WHERE id = ?')
      .run(url, video.published_at, cuentaLibre ? cuenta : pub.account, video.title, t, pub.id)
  } else {
    const clip = db.prepare('SELECT sha256, file_sha256 FROM clips WHERE clip_id = ?').get(clipId) as Row | undefined
    if (!clip) throw new Error('El clip no existe.')
    const cuentaFinal = pubs.some((p) => p.account === cuenta) ? `${cuenta} · ${video.video_id}` : cuenta
    const r = db.prepare(
      `INSERT INTO publications (clip_id, platform, account, status, url, published_at, title_used, sha256_at_publish, created_at, updated_at)
       VALUES (?, 'youtube', ?, 'published', ?, ?, ?, ?, ?, ?)`
    ).run(clipId, cuentaFinal, url, video.published_at ?? t, video.title, clip.file_sha256 ?? clip.sha256 ?? null, t, t)
    pub = { id: Number(r.lastInsertRowid) }
  }
  db.prepare('UPDATE youtube_videos SET publication_id = ?, match_state = ?, match_reason = ? WHERE video_id = ?').run(pub.id, state, reason, video.video_id)
  return pub.id as number
}

function medir(db: DB, publicationId: number, v: Row, t: string, force: boolean): boolean {
  const ultima = db.prepare('SELECT measured_at FROM analytics_snapshots WHERE publication_id = ? ORDER BY measured_at DESC, id DESC LIMIT 1').get(publicationId) as Row | undefined
  if (!force && ultima && new Date(t).getTime() - new Date(ultima.measured_at).getTime() < MIN_INTERVAL_MINUTES * 60_000) return false
  db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, origin, raw_json) VALUES (?, ?, ?, ?, ?, 'youtube_api', ?)")
    .run(publicationId, t, v.views, v.likes, v.comments, v.raw_json ?? null)
  return true
}

/** Cada cuánto se guarda una cifra que no ha cambiado (para saber que el vídeo se seguía mirando). */
export const SNAPSHOT_KEEPALIVE_MINUTES = 60

/**
 * Historial propio de cada vídeo del canal, emparejado o no. Se guarda una fila cuando cambia alguna cifra
 * o, si no cambia, como mucho una por hora.
 */
function anotarVideo(db: DB, videoId: string, v: { views: number | null; likes: number | null; comments: number | null }, t: string): boolean {
  if (v.views == null) return false
  const u = db.prepare('SELECT measured_at, views, likes, comments FROM youtube_video_snapshots WHERE video_id = ? ORDER BY measured_at DESC, id DESC LIMIT 1').get(videoId) as Row | undefined
  const igual = u && u.views === v.views && u.likes === v.likes && u.comments === v.comments
  if (u && igual && new Date(t).getTime() - new Date(u.measured_at).getTime() < SNAPSHOT_KEEPALIVE_MINUTES * 60_000) return false
  db.prepare('INSERT INTO youtube_video_snapshots (video_id, measured_at, views, likes, comments) VALUES (?, ?, ?, ?, ?)').run(videoId, t, v.views, v.likes, v.comments)
  return true
}

/**
 * Suscriptores, visitas totales y vídeos públicos de cada canal (una petición para todos). Guarda la cifra
 * actual y una fila de historial cuando cambia o, si no, como mucho una cada seis horas.
 */
export async function syncChannelStats(db: DB, apiKey: string, fetchImpl: FetchLike, now: () => string = () => new Date().toISOString()): Promise<number> {
  const canales = db.prepare('SELECT channel_id FROM youtube_channels').all() as Row[]
  if (canales.length === 0) return 0
  const cifras = await fetchChannelStats(canales.map((c) => c.channel_id), apiKey, fetchImpl)
  const t = now()
  let n = 0
  db.transaction(() => {
    for (const [id, s] of cifras) {
      db.prepare('UPDATE youtube_channels SET subscribers = ?, total_views = ?, video_count = ?, stats_at = ? WHERE channel_id = ?').run(s.subscribers, s.totalViews, s.videoCount, t, id)
      const u = db.prepare('SELECT measured_at, subscribers, total_views, video_count FROM youtube_channel_snapshots WHERE channel_id = ? ORDER BY measured_at DESC, id DESC LIMIT 1').get(id) as Row | undefined
      const igual = u && u.subscribers === s.subscribers && u.total_views === s.totalViews && u.video_count === s.videoCount
      if (u && igual && new Date(t).getTime() - new Date(u.measured_at).getTime() < 6 * 3600_000) continue
      db.prepare('INSERT INTO youtube_channel_snapshots (channel_id, measured_at, subscribers, total_views, video_count) VALUES (?, ?, ?, ?, ?)').run(id, t, s.subscribers, s.totalViews, s.videoCount)
      n++
    }
  })()
  return n
}

/**
 * Recorre los canales: descubre vídeos nuevos, empareja los que tengan una coincidencia única,
 * y guarda una medición de los emparejados. No toca clips ni nada del generador.
 */
export async function syncChannels(db: DB, apiKey: string, fetchImpl: FetchLike, opts: { now?: () => string; force?: boolean } = {}): Promise<ChannelSyncSummary> {
  const now = opts.now ?? (() => new Date().toISOString())
  const r: ChannelSyncSummary = { channels: 0, videos: 0, linkedNow: 0, unmatched: 0, measured: 0 }
  const canales = db.prepare('SELECT * FROM youtube_channels ORDER BY added_at').all() as Row[]
  for (const canal of canales) {
    const ids = await fetchUploads(canal.uploads_playlist, apiKey, fetchImpl)
    const detalles = await fetchVideoDetails(ids, apiKey, fetchImpl)
    const t = now()
    db.transaction(() => {
      r.channels++
      for (const id of ids) {
        const d = detalles.get(id)
        if (!d) continue
        r.videos++
        db.prepare(
          `INSERT INTO youtube_videos (video_id, channel_id, title, description, published_at, duration_seconds, views, likes, comments, stats_at, first_seen_at, last_seen_at)
           VALUES (@id, @canal, @title, @description, @published, @dur, @views, @likes, @comments, @t, @t, @t)
           ON CONFLICT(video_id) DO UPDATE SET title = excluded.title, description = excluded.description, published_at = excluded.published_at,
             duration_seconds = excluded.duration_seconds, views = excluded.views, likes = excluded.likes, comments = excluded.comments,
             stats_at = excluded.stats_at, last_seen_at = excluded.last_seen_at`
        ).run({ id, canal: canal.channel_id, title: d.title, description: d.description, published: d.publishedAt, dur: d.durationSeconds, views: d.views, likes: d.likes, comments: d.comments, t })
        anotarVideo(db, id, d, t)
        // canal personal: solo se guardan sus cifras. Sus vídeos no son clips: ni se emparejan ni se miden como publicación.
        if (canal.kind === 'personal') continue
        let v = db.prepare('SELECT * FROM youtube_videos WHERE video_id = ?').get(id) as Row
        // una publicación puesta a mano con esta misma URL ya dice de qué clip es
        // 'review' = el usuario deshizo un emparejamiento: se lista, pero ya no se empareja solo
        if (!v.publication_id && v.match_state === 'unmatched') {
          const aMano = (db.prepare("SELECT id, url FROM publications WHERE platform = 'youtube' AND url IS NOT NULL").all() as Row[]).find((p) => parseYouTubeVideoId(p.url) === id)
          if (aMano) {
            db.prepare("UPDATE youtube_videos SET publication_id = ?, match_state = 'manual', match_reason = 'URL puesta a mano' WHERE video_id = ?").run(aMano.id, id)
          } else {
            // candidatos: clips que no tengan ya OTRO vídeo de este canal
            const ocupados = new Set((db.prepare(
              'SELECT p.clip_id FROM youtube_videos y JOIN publications p ON p.id = y.publication_id WHERE y.channel_id = ? AND y.video_id <> ?'
            ).all(canal.channel_id, id) as Row[]).map((x) => x.clip_id))
            const candidatos = (db.prepare('SELECT clip_id, title, caption, duration FROM clips').all() as Row[])
              .filter((c) => !ocupados.has(c.clip_id))
              .map((c) => ({ clipId: c.clip_id, title: c.title, caption: c.caption, duration: c.duration }))
            const m = matchVideoToClip({ title: d.title, description: d.description, durationSeconds: d.durationSeconds }, candidatos)
            if (m) {
              attach(db, v, m.clipId, 'auto', m.reason, canal, t)
              r.linkedNow++
            } else {
              // si no casa por título: lo marcaste en la app como subido en este canal (sin enlace) a la misma hora
              const p = publicacionSinEnlace(db, canal, d.publishedAt)
              if (p) {
                attach(db, v, p.clip_id, 'auto', 'mismo canal y misma hora que lo marcado como subido', canal, t)
                r.linkedNow++
              }
            }
          }
          v = db.prepare('SELECT * FROM youtube_videos WHERE video_id = ?').get(id) as Row
        }
        if (v.publication_id) {
          if (medir(db, v.publication_id, { ...v, raw_json: JSON.stringify(d.raw) }, t, opts.force === true)) r.measured++
        } else if (v.match_state !== 'ignored') {
          r.unmatched++
        }
      }
      db.prepare('UPDATE youtube_channels SET last_scan_at = ? WHERE channel_id = ?').run(t, canal.channel_id)
    })()
  }
  return r
}

/** El usuario decide a qué clip corresponde un vídeo que no se pudo emparejar solo. */
export function linkVideo(db: DB, videoId: string, clipId: string, now: () => string = () => new Date().toISOString()): void {
  const v = db.prepare('SELECT * FROM youtube_videos WHERE video_id = ?').get(videoId) as Row | undefined
  if (!v) throw new Error('El vídeo no existe.')
  if (v.publication_id) throw new Error('Ese vídeo ya está asociado a un clip.')
  const canal = db.prepare('SELECT * FROM youtube_channels WHERE channel_id = ?').get(v.channel_id) as Row
  db.transaction(() => {
    const t = now()
    const pubId = attach(db, v, clipId, 'manual', 'elegido a mano', canal, t)
    if (v.views != null) medir(db, pubId, { ...v, raw_json: null }, v.stats_at ?? t, true)
  })()
}

/**
 * Deshace un emparejamiento equivocado: borra las mediciones de YouTube que se atribuyeron a esa
 * publicación, le quita la URL y deja el vídeo pendiente de que el usuario elija el clip correcto.
 */
export function unlinkVideo(db: DB, videoId: string): void {
  const v = db.prepare('SELECT * FROM youtube_videos WHERE video_id = ?').get(videoId) as Row | undefined
  if (!v?.publication_id) return
  db.transaction(() => {
    db.prepare("DELETE FROM analytics_snapshots WHERE publication_id = ? AND origin = 'youtube_api'").run(v.publication_id)
    db.prepare('UPDATE publications SET url = NULL WHERE id = ?').run(v.publication_id)
    db.prepare("UPDATE youtube_videos SET publication_id = NULL, match_state = 'review', match_reason = NULL WHERE video_id = ?").run(videoId)
  })()
}

/** Marca un vídeo del canal como ajeno a los clips (o deshace esa marca). */
export function ignoreVideo(db: DB, videoId: string, ignored: boolean): void {
  db.prepare("UPDATE youtube_videos SET match_state = ? WHERE video_id = ? AND publication_id IS NULL").run(ignored ? 'ignored' : 'review', videoId)
}

/**
 * REGLA Nº1 (Vyro): un clip nunca en dos canales de YouTube. Clips que PROBABLEMENTE ya están en alguno de tus canales
 * seguidos (de clips o personales) aunque la app no los haya emparejado: mismo título, título que empieza por el del
 * clip o lo contiene, y duración parecida si se sabe. Es a propósito generoso: ante la duda, el clip no se propone.
 * Devuelve clipId -> canales (handle o título) donde aparece.
 */
export function clipsProbablyOnYouTube(db: DB): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const clips = (db.prepare('SELECT clip_id, title, duration FROM clips WHERE title IS NOT NULL').all() as Row[])
    .map((c) => ({ id: c.clip_id as string, t: normalizeText(c.title), d: c.duration as number | null }))
    .filter((c) => c.t.length >= 12)
  const videos = db.prepare(
    `SELECT y.title, y.duration_seconds, COALESCE(ch.handle, ch.title) AS canal FROM youtube_videos y JOIN youtube_channels ch ON ch.channel_id = y.channel_id
     WHERE y.publication_id IS NULL`
  ).all() as Row[]
  for (const v of videos) {
    const vt = normalizeText(v.title)
    if (!vt) continue
    for (const c of clips) {
      if (v.duration_seconds != null && c.d != null && Math.abs(v.duration_seconds - c.d) > 6) continue
      if (vt === c.t || vt.startsWith(c.t + ' ') || vt.includes(c.t)) {
        const s = out.get(c.id) ?? new Set<string>()
        s.add(String(v.canal ?? ''))
        out.set(c.id, s)
      }
    }
  }
  return out
}

/** Marca como «publicado en YouTube» los clips que probablemente ya están en algún canal (para que el plan no los proponga). */
export function withChannelVideos<T extends { clipId: string; published: string[] }>(db: DB, clips: T[]): T[] {
  const enYouTube = clipsProbablyOnYouTube(db)
  if (!enYouTube.size) return clips
  return clips.map((k) => (enYouTube.has(k.clipId) && !k.published.includes('youtube') ? { ...k, published: [...k.published, 'youtube'] } : k))
}
