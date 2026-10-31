/** Funciones puras compartidas por la interfaz y las pruebas. Sin Node ni Electron. */

export const PLATFORMS = ['youtube', 'instagram', 'tiktok'] as const
export type Platform = (typeof PLATFORMS)[number]
export const PLATFORM_LABEL: Record<Platform, string> = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' }

export const isPlatform = (v: unknown): v is Platform => typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v)

/** 43.4 -> "0:43" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Un score ausente no es un cero: se dice que no hay. */
export function scoreLabel(score: number | null | undefined): string {
  return score == null ? 'Sin score' : String(Math.round(score * 10) / 10)
}

/** qa_score va de 0 a 1 en las fichas; se enseña sobre 100. */
export function qaLabel(qa: number | null | undefined): string {
  if (qa == null) return '—'
  const v = Math.round(qa * 1000) / 10
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** Hashtags tal como están en la ficha, separados por un espacio. */
export function hashtagsText(hashtags: string[] | null | undefined): string {
  return (hashtags ?? []).join(' ')
}

export function parseHashtags(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'nunca'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000))
  if (s < 45) return 'ahora mismo'
  if (s < 3600) return `hace ${Math.max(1, Math.round(s / 60))} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  const d = Math.round(s / 86400)
  return d === 1 ? 'ayer' : `hace ${d} días`
}

/** 12345 -> "12.345" */
export function formatCount(n: number | null | undefined): string {
  return n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** 39728447488 -> "37 GB" */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1024 ** 3) {
    const gb = n / 1024 ** 3
    return (gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1).replace('.', ',')) + ' GB'
  }
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB'
  return n > 0 ? '< 1 MB' : '0 MB'
}

/**
 * Estado de un clip, deducido de lo que ya se sabe de él. Cada clip tiene exactamente uno.
 * (No es un dato nuevo ni cambia el significado de «pendiente» o «publicado».)
 */
export const CLIP_STATES = ['pending', 'published', 'closed', 'missing', 'retired'] as const
export type ClipStateKey = (typeof CLIP_STATES)[number]
export const CLIP_STATE_LABEL: Record<ClipStateKey, string> = { pending: 'Pendiente', published: 'Publicado', closed: 'Campaña cerrada', missing: 'Falta el archivo', retired: 'Retirado' }

interface ConEstado { presentInSource: boolean; fileState: string; published: string[]; campaignClosed?: boolean }

export function clipStateKey(k: ConEstado): ClipStateKey {
  if (!k.presentInSource) return 'retired'
  if (k.fileState === 'missing') return 'missing'
  if (k.published.length > 0) return 'published'
  return k.campaignClosed ? 'closed' : 'pending'
}

export interface LibraryFilter {
  campaignId?: string
  /** Solo los clips publicados en esta plataforma. */
  platform?: string
  state?: ClipStateKey | ''
  search?: string
}

/** Filtra la biblioteca sin tocar la lista original. Cada clip sale como mucho una vez: la lista ya trae uno por clip. */
export function filterLibrary<T extends ConEstado & { campaignId: string; title: string | null; filename: string | null }>(clips: T[], f: LibraryFilter): T[] {
  const q = (f.search ?? '').trim().toLowerCase()
  return clips.filter((k) =>
    (!f.campaignId || k.campaignId === f.campaignId) &&
    (!f.platform || k.published.includes(f.platform)) &&
    (!f.state || clipStateKey(k) === f.state) &&
    (!q || (k.title ?? k.filename ?? '').toLowerCase().includes(q)))
}

export type ClipSort = 'score' | 'date' | 'name'

/**
 * Ordena una lista de clips sin tocar la original. 'score' deja el orden de calidad con el que llega
 * (score, QA, identificador); 'date' pone primero los más recientes; 'name' es alfabético por título.
 * Los que no tienen el dato van al final, nunca como si valiera cero.
 */
export function sortClips<T extends { title: string | null; filename: string | null; createdAt?: string | null }>(clips: T[], sort: ClipSort): T[] {
  if (sort === 'score') return clips
  const copia = [...clips]
  if (sort === 'name') {
    // las comillas iniciales («'I am…») no cuentan para el orden alfabético
    const nombre = (k: T) => (k.title ?? k.filename ?? '').replace(/^[^\p{L}\p{N}]+/u, '')
    return copia.sort((a, b) => nombre(a).localeCompare(nombre(b), 'es', { sensitivity: 'base', numeric: true }))
  }
  const t = (k: T) => (k.createdAt ? Date.parse(k.createdAt) : NaN)
  return copia.sort((a, b) => {
    const x = t(a), y = t(b)
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1
    return y - x
  })
}

/** Un clip publicado con todas sus publicaciones (una por plataforma y cuenta). */
export interface PublishedGroup<P, C> {
  clip: C
  /** Sus publicaciones, la más reciente primero. */
  publications: P[]
  /** Fecha de la publicación más reciente (ISO), si consta. */
  lastPublishedAt: string | null
  /** Suma de las visitas medidas. null si ninguna publicación tiene cifras: no es un cero. */
  views: number | null
  /** Cuántas publicaciones tienen cifras. */
  measured: number
}

interface PubLike { publishedAt: string | null; latest: { views: number | null } | null }

/**
 * Junta las filas «una por publicación» en «una por clip», sin perder ninguna publicación.
 * Conserva el orden de llegada (publicación más reciente primero).
 */
export function groupPublished<P extends PubLike, C extends { clipId: string }>(rows: { publication: P; clip: C }[]): PublishedGroup<P, C>[] {
  const porClip = new Map<string, PublishedGroup<P, C>>()
  for (const { publication, clip } of rows) {
    let g = porClip.get(clip.clipId)
    if (!g) {
      g = { clip, publications: [], lastPublishedAt: null, views: null, measured: 0 }
      porClip.set(clip.clipId, g)
    }
    g.publications.push(publication)
    if (publication.publishedAt && (!g.lastPublishedAt || publication.publishedAt > g.lastPublishedAt)) g.lastPublishedAt = publication.publishedAt
    if (publication.latest?.views != null) {
      g.views = (g.views ?? 0) + publication.latest.views
      g.measured++
    }
  }
  return [...porClip.values()]
}

export type PublishedSort = 'recent' | 'views' | 'score' | 'name'

/** Ordena clips publicados sin tocar la lista original. Los que no tienen el dato van al final. */
export function sortPublished<P, C extends { title: string | null; filename: string | null; score: number | null }>(grupos: PublishedGroup<P, C>[], sort: PublishedSort): PublishedGroup<P, C>[] {
  if (sort === 'recent') return grupos
  if (sort === 'name') {
    const orden = sortClips(grupos.map((g) => g.clip), 'name')
    return [...grupos].sort((a, b) => orden.indexOf(a.clip) - orden.indexOf(b.clip))
  }
  const valor = (g: PublishedGroup<P, C>) => (sort === 'views' ? g.views : g.clip.score)
  return [...grupos].sort((a, b) => {
    const x = valor(a), y = valor(b)
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
    return y - x
  })
}

export type ClipFilter = 'all' | 'top5' | 'published' | 'pending'

interface Filtrable {
  title: string | null
  filename: string | null
  published: string[]
  presentInSource: boolean
  campaignClosed?: boolean
}

/**
 * Filtros de la lista de clips. La lista llega ya ordenada; aquí solo se recorta.
 * Pendiente = sin ninguna publicación y con la campaña todavía abierta. Top 5 = los cinco primeros que siguen en el generador.
 */
export function filterClips<T extends Filtrable>(clips: T[], filter: ClipFilter, search = ''): T[] {
  let out = clips
  if (filter === 'top5') out = clips.filter((k) => k.presentInSource).slice(0, 5)
  else if (filter === 'published') out = clips.filter((k) => k.published.length > 0)
  else if (filter === 'pending') out = clips.filter((k) => k.published.length === 0 && k.presentInSource && !k.campaignClosed)
  const q = search.trim().toLowerCase()
  if (q) out = out.filter((k) => (k.title ?? k.filename ?? '').toLowerCase().includes(q))
  return out
}

/** "YouTube · @canal" (o solo la plataforma si no se sabe el canal). */
export const dondeTexto = (d: { platform: string; account: string }) => (PLATFORM_LABEL[d.platform as Platform] ?? d.platform) + (d.account ? ` · ${d.account}` : '')
