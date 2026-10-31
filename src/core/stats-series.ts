/**
 * Evolución temporal de las mediciones. Solo lectura sobre analytics_snapshots.
 *
 * Reglas de honestidad: aquí no se inventa ni se interpola nada. Cada punto es una medición real.
 * El total de un día es la suma de la ÚLTIMA medición conocida de cada vídeo hasta el final de ese día
 * (una medición sigue siendo cierta hasta que llega otra); los días sin ninguna medición no existen.
 * Este archivo no importa nada de Node: lo usa también la interfaz.
 */
import type { DB } from './db'

/** Una medición real de un vídeo publicado. */
export interface SeriesPoint {
  publicationId: number
  /** ISO 8601. */
  t: string
  views: number
}

export interface DailyTotal {
  /** Día local, AAAA-MM-DD. */
  day: string
  /** Suma de la última medición conocida de cada vídeo hasta el final de ese día. */
  views: number
  /** Vídeos que entran en esa suma. */
  videos: number
  /** true si el día anterior de la lista no es el día natural anterior (hay días sin mediciones entre medias). */
  gapBefore: boolean
}

export interface ComparableDelta {
  fromDay: string
  toDay: string
  /** Visitas ganadas entre los dos días, contando solo los vídeos medidos en ambos. */
  delta: number
  videos: number
}

type Row = Record<string, any>

/** Día local de una fecha ISO, AAAA-MM-DD. */
export function localDay(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Mediciones con cifra de visitas de las publicaciones activas. Como la aplicación mide cada pocos
 * minutos, se devuelve como mucho una por vídeo y hora: la última de esa hora (una medición real, no una media).
 */
export function getStatsSeries(db: DB): SeriesPoint[] {
  const filas = db.prepare(
    `SELECT s.publication_id, s.measured_at, s.views
     FROM analytics_snapshots s JOIN publications p ON p.id = s.publication_id
     WHERE s.views IS NOT NULL AND p.status = 'published'
     ORDER BY s.publication_id, s.measured_at, s.id`
  ).all() as Row[]
  const out: SeriesPoint[] = []
  let clave = ''
  for (const f of filas) {
    const t = new Date(f.measured_at)
    if (Number.isNaN(t.getTime())) continue
    const k = `${f.publication_id}|${t.toISOString().slice(0, 13)}`
    const punto = { publicationId: f.publication_id as number, t: t.toISOString(), views: f.views as number }
    if (k === clave) out[out.length - 1] = punto
    else out.push(punto)
    clave = k
  }
  return out
}

/** Las mediciones de cada vídeo, en orden de tiempo. */
export function seriesByPublication(points: SeriesPoint[]): Map<number, SeriesPoint[]> {
  const m = new Map<number, SeriesPoint[]>()
  for (const p of points) m.set(p.publicationId, [...(m.get(p.publicationId) ?? []), p])
  for (const lista of m.values()) lista.sort((a, b) => a.t.localeCompare(b.t))
  return m
}

const diaSiguiente = (day: string): string => {
  const d = new Date(day + 'T12:00:00')
  d.setDate(d.getDate() + 1)
  return localDay(d.toISOString())
}

/** Última medición de cada vídeo hasta el final de un día local (incluido). */
function ultimasHasta(porVideo: Map<number, SeriesPoint[]>, day: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const [id, lista] of porVideo) {
    let ultima: number | null = null
    for (const p of lista) {
      if (localDay(p.t) > day) break
      ultima = p.views
    }
    if (ultima != null) out.set(id, ultima)
  }
  return out
}

/** Total de visitas medidas por día. Solo aparecen los días en los que hubo al menos una medición. */
export function dailyTotals(points: SeriesPoint[], only?: Set<number>): DailyTotal[] {
  const usados = only ? points.filter((p) => only.has(p.publicationId)) : points
  const porVideo = seriesByPublication(usados)
  const dias = [...new Set(usados.map((p) => localDay(p.t)))].sort()
  return dias.map((day, i) => {
    const ultimas = ultimasHasta(porVideo, day)
    return { day, views: [...ultimas.values()].reduce((s, v) => s + v, 0), videos: ultimas.size, gapBefore: i > 0 && diaSiguiente(dias[i - 1]) !== day }
  })
}

/**
 * Visitas ganadas entre los dos últimos días con mediciones, contando SOLO los vídeos que ya estaban
 * medidos el primero (si no, un vídeo que se mide por primera vez parecería una subida). null si no hay
 * dos días o ningún vídeo en común.
 */
export function comparableDelta(points: SeriesPoint[], only?: Set<number>): ComparableDelta | null {
  const usados = only ? points.filter((p) => only.has(p.publicationId)) : points
  const dias = [...new Set(usados.map((p) => localDay(p.t)))].sort()
  if (dias.length < 2) return null
  const [fromDay, toDay] = dias.slice(-2)
  const porVideo = seriesByPublication(usados)
  const antes = ultimasHasta(porVideo, fromDay)
  const ahora = ultimasHasta(porVideo, toDay)
  if (antes.size === 0) return null
  let delta = 0
  for (const [id, v] of antes) delta += (ahora.get(id) ?? v) - v
  return { fromDay, toDay, delta, videos: antes.size }
}

export interface DailyGain {
  /** Día local, AAAA-MM-DD: el día en que se midió la ganancia. */
  day: string
  /** Día con mediciones anterior con el que se compara. */
  fromDay: string
  /** Días naturales que cubre la comparación (1 = de ayer a hoy; más si la aplicación estuvo cerrada). */
  span: number
  /** Visitas ganadas, contando solo los vídeos ya medidos el día anterior. */
  gain: number
  /** Vídeos que entran en la comparación. */
  videos: number
  /** Ganancia de cada vídeo ese día, de mayor a menor (solo los que ganaron algo). */
  top: { publicationId: number; gain: number }[]
}

const diasEntre = (a: string, b: string) => Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86_400_000)

/**
 * Visitas ganadas en cada día con mediciones, frente al día con mediciones anterior. Igual que
 * comparableDelta, solo cuentan los vídeos ya medidos el día anterior: un vídeo que se mide por
 * primera vez no es una subida. Si entre los dos días hubo días sin mediciones, span lo dice.
 */
export function dailyGains(points: SeriesPoint[], only?: Set<number>): DailyGain[] {
  const usados = only ? points.filter((p) => only.has(p.publicationId)) : points
  const porVideo = seriesByPublication(usados)
  const dias = [...new Set(usados.map((p) => localDay(p.t)))].sort()
  const out: DailyGain[] = []
  let antes = dias.length ? ultimasHasta(porVideo, dias[0]) : new Map<number, number>()
  for (let i = 1; i < dias.length; i++) {
    const ahora = ultimasHasta(porVideo, dias[i])
    const top: { publicationId: number; gain: number }[] = []
    let gain = 0
    for (const [id, v] of antes) {
      const g = (ahora.get(id) ?? v) - v
      gain += g
      if (g > 0) top.push({ publicationId: id, gain: g })
    }
    top.sort((a, b) => b.gain - a.gain)
    out.push({ day: dias[i], fromDay: dias[i - 1], span: diasEntre(dias[i - 1], dias[i]), gain, videos: antes.size, top })
    antes = ahora
  }
  return out
}

/** Suma de lo ganado en los días [desde, hasta] (AAAA-MM-DD, ambos incluidos). */
export function gainBetween(gains: DailyGain[], desde: string, hasta: string): number {
  return gains.filter((g) => g.day >= desde && g.day <= hasta).reduce((s, g) => s + g.gain, 0)
}
