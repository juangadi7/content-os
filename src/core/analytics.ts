/**
 * Mediciones de publicaciones. Cada medición es una fila nueva en analytics_snapshots: nunca se
 * sobrescribe una anterior, así queda la evolución (24 h, 7 días...). Datos propios de CONTENT OS.
 */
import type { DB } from './db'
import { fetchVideoStats, parseYouTubeVideoId, type FetchLike } from './youtube'

export interface SnapshotView {
  measuredAt: string
  views: number | null
  likes: number | null
  comments: number | null
  origin: string
}

export interface RefreshSummary {
  /** Publicaciones de YouTube marcadas como publicadas. */
  publications: number
  /** Mediciones nuevas guardadas. */
  measured: number
  /** Medidas hace poco: no se vuelve a preguntar. */
  skippedRecent: number
  /** Sin URL, o con una URL que no es de un vídeo de YouTube. */
  withoutUrl: number
  /** YouTube no devuelve el vídeo: privado, borrado o URL equivocada. */
  notFound: number
}

export interface RefreshOptions {
  now?: () => string
  /** No volver a medir una publicación medida hace menos de estos minutos (por defecto 15). */
  minIntervalMinutes?: number
  /** Ignorar el intervalo mínimo. */
  force?: boolean
}

type Row = Record<string, any>

export function latestSnapshot(db: DB, publicationId: number): SnapshotView | null {
  const s = db.prepare(
    'SELECT measured_at, views, likes, comments, origin FROM analytics_snapshots WHERE publication_id = ? ORDER BY measured_at DESC, id DESC LIMIT 1'
  ).get(publicationId) as Row | undefined
  return s ? { measuredAt: s.measured_at, views: s.views, likes: s.likes, comments: s.comments, origin: s.origin } : null
}

/** Todas las mediciones de una publicación, de la más antigua a la más reciente. */
export function listSnapshots(db: DB, publicationId: number): SnapshotView[] {
  const filas = db.prepare(
    'SELECT measured_at, views, likes, comments, origin FROM analytics_snapshots WHERE publication_id = ? ORDER BY measured_at, id'
  ).all(publicationId) as Row[]
  return filas.map((s) => ({ measuredAt: s.measured_at, views: s.views, likes: s.likes, comments: s.comments, origin: s.origin }))
}

/**
 * Pide a YouTube las cifras públicas de todas las publicaciones de YouTube con URL y guarda una
 * medición nueva por cada una. No toca clips, publicaciones ni nada del generador.
 */
export async function refreshYouTubeStats(db: DB, apiKey: string, fetchImpl: FetchLike, opts: RefreshOptions = {}): Promise<RefreshSummary> {
  const now = opts.now ?? (() => new Date().toISOString())
  const minMs = (opts.minIntervalMinutes ?? 15) * 60_000
  const r: RefreshSummary = { publications: 0, measured: 0, skippedRecent: 0, withoutUrl: 0, notFound: 0 }
  const pubs = db.prepare("SELECT id, url FROM publications WHERE platform = 'youtube' AND status = 'published' ORDER BY id").all() as Row[]
  r.publications = pubs.length

  const pendientes: { id: number; videoId: string }[] = []
  const ahora = new Date(now()).getTime()
  for (const p of pubs) {
    const videoId = parseYouTubeVideoId(p.url)
    if (!videoId) {
      r.withoutUrl++
      continue
    }
    const ultima = latestSnapshot(db, p.id)
    if (!opts.force && ultima && ahora - new Date(ultima.measuredAt).getTime() < minMs) {
      r.skippedRecent++
      continue
    }
    pendientes.push({ id: p.id, videoId })
  }
  if (pendientes.length === 0) return r

  const stats = await fetchVideoStats(pendientes.map((p) => p.videoId), apiKey, fetchImpl)
  const medidoEn = now()
  const insertar = db.prepare(
    `INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, origin, raw_json)
     VALUES (?, ?, ?, ?, ?, 'youtube_api', ?)`
  )
  db.transaction(() => {
    for (const p of pendientes) {
      const s = stats.get(p.videoId)
      if (!s) {
        r.notFound++
        continue
      }
      insertar.run(p.id, medidoEn, s.views, s.likes, s.comments, JSON.stringify(s.raw))
      r.measured++
    }
  })()
  return r
}
