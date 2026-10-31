/**
 * TikTok: cifras públicas de un vídeo leídas de su página (sin cuenta ni clave).
 * TikTok no ofrece una API sencilla para esto y puede bloquear la lectura cuando quiera: todo aquí
 * falla de forma clara y nunca borra lo ya guardado. Solo lectura.
 */
import type { DB } from './db'
import { latestSnapshot } from './analytics'
import { savePublication } from './publications'
import { normalizeText } from './youtube-channels'
import type { TextFetch } from './vyro'

export class TikTokError extends Error {
  constructor(readonly code: 'url' | 'network' | 'blocked' | 'not_found' | 'no_match', message: string) {
    super(message)
  }
}

export interface TikTokVideo {
  videoId: string
  author: string
  url: string
  description: string
  /** ISO 8601. */
  createdAt: string | null
  durationSeconds: number | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
}

/** https://www.tiktok.com/@usuario/video/123… -> usuario e id. null si no es la URL de un vídeo. */
export function parseTikTokUrl(url: string | null | undefined): { author: string; videoId: string; url: string } | null {
  const m = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([A-Za-z0-9._]{1,40})\/video\/(\d{6,25})(?:[/?#].*)?$/i.exec((url ?? '').trim())
  return m ? { author: m[1], videoId: m[2], url: `https://www.tiktok.com/@${m[1]}/video/${m[2]}` } : null
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** Saca los datos del vídeo de los datos incrustados en su página. */
export function parseTikTokPage(html: string): TikTokVideo {
  const m = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  let detalle: any
  try {
    detalle = m ? JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.video-detail'] : null
  } catch {
    detalle = null
  }
  if (!detalle) throw new TikTokError('blocked', 'TikTok no ha dejado leer el vídeo (puede estar pidiendo una verificación). Se volverá a intentar más tarde.')
  const it = detalle.itemInfo?.itemStruct
  if (detalle.statusCode !== 0 || !it?.id) throw new TikTokError('not_found', 'TikTok no devuelve ese vídeo: es privado, se borró o la URL no es correcta.')
  const s = it.statsV2 ?? it.stats ?? {}
  const t = num(it.createTime)
  return {
    videoId: String(it.id), author: String(it.author?.uniqueId ?? ''), url: `https://www.tiktok.com/@${it.author?.uniqueId}/video/${it.id}`,
    description: typeof it.desc === 'string' ? it.desc : '', createdAt: t ? new Date(t * 1000).toISOString() : null,
    durationSeconds: num(it.video?.duration), views: num(s.playCount), likes: num(s.diggCount), comments: num(s.commentCount),
    shares: num(s.shareCount), saves: num(s.collectCount)
  }
}

export async function fetchTikTokVideo(url: string, pedir: TextFetch): Promise<TikTokVideo> {
  const ref = parseTikTokUrl(url)
  if (!ref) throw new TikTokError('url', 'Pega la URL completa del vídeo: https://www.tiktok.com/@usuario/video/…')
  let r: Awaited<ReturnType<TextFetch>>
  try {
    r = await pedir(ref.url, { headers: { 'User-Agent': 'ContentOS/0.1 (personal stats reader)', Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } })
  } catch (e) {
    throw new TikTokError('network', `No se pudo conectar con TikTok (${(e as Error).message}).`)
  }
  if (!r.ok) throw new TikTokError(r.status === 404 ? 'not_found' : 'blocked', `TikTok respondió con un error (${r.status}).`)
  const v = parseTikTokPage(await r.text())
  if (v.videoId !== ref.videoId) throw new TikTokError('blocked', 'TikTok devolvió otra página en lugar del vídeo.')
  return v
}

type Row = Record<string, any>

function guardarMedicion(db: DB, publicationId: number, v: TikTokVideo, at: string): void {
  db.prepare(
    `INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, shares, saves, origin, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'tiktok_page', ?)`
  ).run(publicationId, at, v.views, v.likes, v.comments, v.shares, v.saves, JSON.stringify({ views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves }))
}

/**
 * Clip al que corresponde un vídeo de TikTok: la descripción publicada contiene la del clip y la
 * duración coincide. Si varios clips comparten descripción, gana el de duración claramente más cercana.
 */
export function matchTikTokToClip(v: Pick<TikTokVideo, 'description' | 'durationSeconds'>, clips: { clipId: string; caption: string | null; duration: number | null }[]): string | null {
  const desc = normalizeText(v.description)
  const candidatos = clips
    .map((c) => ({ c, texto: normalizeText(c.caption), dif: v.durationSeconds != null && c.duration != null ? Math.abs(c.duration - v.durationSeconds) : null }))
    .filter((x) => x.texto.length >= 15 && desc.includes(x.texto) && (x.dif == null || x.dif <= 1.6))
    .sort((a, b) => (a.dif ?? 9) - (b.dif ?? 9) || b.texto.length - a.texto.length)
  if (candidatos.length === 0) return null
  if (candidatos.length === 1) return candidatos[0].c.clipId
  const [a, b] = candidatos
  // dos clips con la misma descripción: solo si la duración (TikTok la da en segundos enteros) decide con margen
  return a.dif != null && b.dif != null && b.dif - a.dif >= 0.6 ? a.c.clipId : null
}

export interface TikTokAddResult {
  clipId: string
  title: string
  account: string
  views: number | null
  /** true si ya estaba apuntado y solo se le puso la URL o una medición nueva. */
  existed: boolean
  /** Hashtags de la descripción publicada que la ficha del clip no lleva (la campaña puede prohibirlos). */
  extraHashtags: string[]
}

/**
 * Apunta un vídeo de TikTok a partir de su URL: lo lee, averigua a qué clip corresponde y deja la
 * publicación hecha (cuenta, fecha, URL) con su primera medición.
 */
export async function addTikTokVideo(db: DB, url: string, pedir: TextFetch, now: () => string = () => new Date().toISOString()): Promise<TikTokAddResult> {
  const v = await fetchTikTokVideo(url, pedir)
  const account = '@' + v.author
  const yaPorUrl = db.prepare("SELECT id, clip_id FROM publications WHERE platform = 'tiktok' AND url = ?").get(v.url) as Row | undefined
  let clipId: string | null = yaPorUrl?.clip_id ?? null
  if (!clipId) {
    const clips = (db.prepare('SELECT clip_id, caption, duration FROM clips WHERE present_in_source = 1').all() as Row[]).map((k) => ({ clipId: k.clip_id as string, caption: k.caption as string | null, duration: k.duration as number | null }))
    clipId = matchTikTokToClip(v, clips)
  }
  if (!clipId) throw new TikTokError('no_match', 'No sé a qué clip corresponde ese vídeo (la descripción no coincide con ninguna o coincide con varias). Abre el clip, pulsa «Marcar publicado» en TikTok y pega ahí la URL.')
  const clip = db.prepare('SELECT title, filename, hashtags FROM clips WHERE clip_id = ?').get(clipId) as Row
  const previa = (yaPorUrl ?? db.prepare("SELECT id FROM publications WHERE clip_id = ? AND platform = 'tiktok' AND account = ? COLLATE NOCASE").get(clipId, account)) as Row | undefined
  const at = now()
  let id: number
  if (previa) {
    id = previa.id
    db.prepare('UPDATE publications SET url = ?, caption_used = COALESCE(caption_used, ?), updated_at = ? WHERE id = ?').run(v.url, v.description, at, id)
  } else {
    id = savePublication(db, { clipId, platform: 'tiktok', account, url: v.url, publishedAt: v.createdAt, captionUsed: v.description }, now)
  }
  guardarMedicion(db, id, v, at)
  let permitidos: string[] = []
  try {
    permitidos = (JSON.parse(clip.hashtags ?? '[]') as string[]).map((h) => h.toLowerCase())
  } catch {
    permitidos = []
  }
  const usados = v.description.match(/#[\p{L}\p{N}_]+/gu) ?? []
  return { clipId, title: clip.title ?? clip.filename ?? clipId, account, views: v.views, existed: !!previa, extraHashtags: usados.filter((h) => !permitidos.includes(h.toLowerCase())) }
}

export interface TikTokRefreshSummary {
  publications: number
  measured: number
  skippedRecent: number
  withoutUrl: number
  failed: number
  /** Primer error encontrado, para enseñarlo. */
  error: string | null
}

/**
 * Vuelve a leer las cifras de las publicaciones de TikTok con URL. Una a una y con pausa; si TikTok
 * bloquea dos seguidas, se deja para la próxima vez.
 */
export async function refreshTikTokStats(
  db: DB, pedir: TextFetch,
  opts: { now?: () => string; minIntervalMinutes?: number; force?: boolean; pauseMs?: number } = {}
): Promise<TikTokRefreshSummary> {
  const now = opts.now ?? (() => new Date().toISOString())
  const minMs = (opts.minIntervalMinutes ?? 30) * 60_000
  const r: TikTokRefreshSummary = { publications: 0, measured: 0, skippedRecent: 0, withoutUrl: 0, failed: 0, error: null }
  const pubs = db.prepare("SELECT id, url FROM publications WHERE platform = 'tiktok' AND status = 'published' ORDER BY id").all() as Row[]
  r.publications = pubs.length
  const ahora = new Date(now()).getTime()
  let seguidos = 0
  let primero = true
  for (const p of pubs) {
    if (!parseTikTokUrl(p.url)) {
      r.withoutUrl++
      continue
    }
    const ultima = latestSnapshot(db, p.id)
    if (!opts.force && ultima && ahora - new Date(ultima.measuredAt).getTime() < minMs) {
      r.skippedRecent++
      continue
    }
    if (!primero && (opts.pauseMs ?? 1500) > 0) await new Promise((ok) => setTimeout(ok, opts.pauseMs ?? 1500))
    primero = false
    try {
      guardarMedicion(db, p.id, await fetchTikTokVideo(p.url, pedir), now())
      r.measured++
      seguidos = 0
    } catch (e) {
      r.failed++
      r.error ??= (e as Error).message
      if (e instanceof TikTokError && e.code === 'not_found') continue
      if (++seguidos >= 2) break
    }
  }
  return r
}
