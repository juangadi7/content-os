/**
 * Panel de un canal de YouTube y su «estudio»: cómo va, qué vídeos funcionan y cuáles no.
 *
 * Todo sale de datos PÚBLICOS ya guardados (visitas, likes, comentarios, suscriptores); aquí no hay red
 * ni se escribe nada. El estudio son comparaciones sencillas de medianas con su tamaño de muestra a la
 * vista: no adivina causas, y cuando hay pocos vídeos lo dice en vez de sacar conclusiones.
 */
import type { DB } from './db'
import { formatCount } from './format'
import { localDay } from './stats-series'
import { shortUrl } from './youtube'
import type { ChannelKind } from './youtube-channels'

export interface ChannelVideo {
  videoId: string
  url: string
  title: string | null
  publishedAt: string | null
  durationSeconds: number | null
  /** null = sin medir (no es un cero). */
  views: number | null
  likes: number | null
  comments: number | null
  statsAt: string | null
  /** Visitas ganadas entre dos mediciones reales separadas alrededor de un día; null si no hay con qué comparar. */
  gain: { views: number; hours: number } | null
  /** Mediciones guardadas, de la más antigua a la más reciente. */
  series: { t: string; views: number }[]
  clipId: string | null
  campaignId: string | null
  campaignName: string | null
  score: number | null
  hasThumb: boolean
  thumbVersion: number | null
}

export type StudyLevel = 'sin_datos' | 'pocos_datos' | 'sin_despegar' | 'frenado' | 'baja' | 'estable' | 'sube'

export interface StudyFinding {
  tone: 'good' | 'bad' | 'info'
  title: string
  detail: string
  /** true = sale de menos de 5 vídeos por grupo: es un indicio, no una prueba. */
  weak: boolean
}

export interface ChannelStudy {
  level: StudyLevel
  headline: string
  summary: string
  facts: { label: string; value: string }[]
  findings: StudyFinding[]
  /** Identificadores de vídeo, de más a menos visitas / de menos a más. */
  best: string[]
  worst: string[]
  steps: string[]
  limits: string[]
  /** El estudio en texto plano, para copiarlo. */
  text: string
}

/** Un día con al menos una medición del canal. Los días sin medir no existen: no se rellenan ni se interpolan. */
export interface ChannelDay {
  /** Día local, AAAA-MM-DD. */
  day: string
  /** Última cifra del día según YouTube. */
  totalViews: number | null
  subscribers: number | null
  videoCount: number | null
  /** Diferencia con el día medido anterior; null en el primero o si falta la cifra. */
  viewsGain: number | null
  subscribersGain: number | null
  /** Días naturales desde el día medido anterior (1 = consecutivos). Con más de 1, la diferencia cubre varios días. */
  daysSincePrevious: number | null
  /** Vídeos públicos del canal publicados ese día. */
  uploads: number
}

export interface ChannelDashboard {
  channelId: string
  kind: ChannelKind
  handle: string | null
  title: string | null
  /** null si el canal los oculta o aún no se han pedido. YouTube los da redondeados. */
  subscribers: number | null
  /** Variación de suscriptores entre la medición más antigua de los últimos 7 días y la última. */
  subscribersChange: { delta: number; since: string } | null
  /** Visitas totales del canal según YouTube (incluye vídeos que ya no son públicos). */
  totalViews: number | null
  videoCount: number | null
  statsAt: string | null
  lastScanAt: string | null
  /** Del más reciente al más antiguo. */
  videos: ChannelVideo[]
  totals: { videos: number; measured: number; views: number; likes: number; comments: number; median: number | null; gain: number | null; gainVideos: number }
  /** Día a día, del más antiguo al más reciente. Empieza el día que se añadió el canal. */
  daily: ChannelDay[]
  study: ChannelStudy
}

type Row = Record<string, any>
const HORA = 3600_000
/** Un vídeo con menos horas que estas aún está recibiendo su primer reparto: no entra en las comparaciones. */
export const MATURE_HOURS = 48
/** Menos visitas que estas tras 48 horas = YouTube apenas lo enseñó. */
export const DEAD_VIEWS = 10

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const o = [...xs].sort((a, b) => a - b)
  const m = Math.floor(o.length / 2)
  return o.length % 2 ? o[m] : Math.round((o[m - 1] + o[m]) / 2)
}

/**
 * Visitas ganadas en torno al último día: la cifra actual menos la de la medición más reciente que tenga
 * al menos 20 horas (y no más de 52). Un vídeo con menos de 20 horas parte de cero al publicarse.
 */
export function recentGain(v: { views: number | null; publishedAt: string | null; series: { t: string; views: number }[] }, now: Date): { views: number; hours: number } | null {
  if (v.views == null) return null
  const ahora = now.getTime()
  const edad = v.publishedAt ? (ahora - new Date(v.publishedAt).getTime()) / HORA : null
  if (edad != null && edad >= 0 && edad < 20) return { views: v.views, hours: Math.max(1, Math.round(edad)) }
  const ref = [...v.series].reverse().find((p) => ahora - new Date(p.t).getTime() >= 20 * HORA)
  if (!ref) return null
  const horas = (ahora - new Date(ref.t).getTime()) / HORA
  return horas <= 52 ? { views: Math.max(0, v.views - ref.views), hours: Math.round(horas) } : null
}

// ------------------------------------------------------------------ estudio

const n = (v: number | null) => formatCount(v)
const plural = (c: number, uno: string, varios: string) => `${c} ${c === 1 ? uno : varios}`
const visitas = (v: number) => `${n(v)} ${v === 1 ? 'visita' : 'visitas'}`
const diaLocal = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const comillas = (t: string | null) => `«${(t ?? 'sin título').replace(/\s+/g, ' ').trim().slice(0, 70)}»`
/** Cuántas veces más (con +1 para que un cero no rompa la cuenta). */
const veces = (a: number, b: number) => (a + 1) / (b + 1)
const DIFERENCIA = 1.5

interface Grupo { nombre: string; vs: ChannelVideo[]; med: number }
const grupo = (nombre: string, vs: ChannelVideo[]): Grupo => ({ nombre, vs, med: median(vs.map((v) => v.views!)) ?? 0 })
const ficha = (g: Grupo) => `${g.nombre}: mediana de ${visitas(g.med)} (${plural(g.vs.length, 'vídeo', 'vídeos')})`

/** De varios grupos, el mejor y el peor si hay al menos dos con muestra suficiente y se diferencian de verdad. */
function extremos(grupos: Grupo[], minimo: number): { mejor: Grupo; peor: Grupo; todos: Grupo[] } | null {
  const validos = grupos.filter((g) => g.vs.length >= minimo).sort((a, b) => b.med - a.med)
  if (validos.length < 2) return null
  const mejor = validos[0]
  const peor = validos[validos.length - 1]
  return veces(mejor.med, peor.med) >= DIFERENCIA ? { mejor, peor, todos: validos } : null
}

const FRANJAS: [number, number, string][] = [[0, 7, 'de madrugada (0–7 h)'], [7, 12, 'por la mañana (7–12 h)'], [12, 16, 'a mediodía (12–16 h)'], [16, 21, 'por la tarde (16–21 h)'], [21, 24, 'por la noche (21–24 h)']]
const DURACIONES: [number, number, string][] = [[0, 20, 'menos de 20 s'], [20, 35, 'de 20 a 35 s'], [35, 60, 'de 35 a 60 s'], [60, Infinity, 'más de 60 s']]

/** Estudio de un canal a partir de sus vídeos públicos. Función pura: mismos datos, mismo resultado. */
export function studyChannel(canal: { name: string; subscribers: number | null; videos: ChannelVideo[] }, now: Date): ChannelStudy {
  const ahora = now.getTime()
  const conFecha = canal.videos.filter((v) => v.publishedAt).sort((a, b) => a.publishedAt!.localeCompare(b.publishedAt!))
  const edad = (v: ChannelVideo) => (ahora - new Date(v.publishedAt!).getTime()) / HORA
  const maduros = conFecha.filter((v) => v.views != null && edad(v) >= MATURE_HOURS)
  const recientes = conFecha.filter((v) => edad(v) < MATURE_HOURS)
  const med = median(maduros.map((v) => v.views!))
  const porVisitas = [...maduros].sort((a, b) => b.views! - a.views!)
  const findings: StudyFinding[] = []
  const steps: string[] = []
  const debil = (...gs: Grupo[]) => Math.min(...gs.map((g) => g.vs.length)) < 5

  // ---- veredicto
  let level: StudyLevel
  let headline: string
  let summary: string
  if (conFecha.length === 0) {
    level = 'sin_datos'
    headline = 'Sin vídeos públicos todavía'
    summary = 'YouTube no devuelve ningún vídeo público de este canal.'
    steps.push('Sube el primer vídeo y vuelve a estudiar el canal a las 48 horas.')
  } else if (maduros.length < 4) {
    level = 'pocos_datos'
    headline = 'Pocos datos todavía'
    summary = maduros.length === 0
      ? `Ningún vídeo lleva ${MATURE_HOURS} horas publicado: es pronto para juzgar.`
      : `Solo ${plural(maduros.length, 'vídeo lleva', 'vídeos llevan')} más de ${MATURE_HOURS} horas (${maduros.map((v) => n(v.views)).join(', ')} visitas). Hacen falta al menos 4 para comparar.`
    steps.push('Sigue con un vídeo al día. Con 4 vídeos de más de 48 horas ya se puede comparar.')
  } else {
    const k = Math.min(5, Math.floor(maduros.length / 2))
    const ultimos = maduros.slice(-k)
    // se compara con TODO lo anterior, no solo con los k previos: si el freno dura ya más de k vídeos,
    // comparar dos tramos frenados entre sí diría que «se mantiene»
    const previos = maduros.slice(0, -k)
    const buenos = maduros.filter((v) => v.views! >= 500).length
    const mU = median(ultimos.map((v) => v.views!))!
    const mP = median(previos.map((v) => v.views!))!
    const cifras = `Los últimos ${k} vídeos: mediana de ${visitas(mU)}. Los ${previos.length} anteriores: ${n(mP)}.`
    if (porVisitas[0].views! < 500 && med! < 50) {
      level = 'sin_despegar'
      headline = 'El canal todavía no ha despegado'
      summary = `Ningún vídeo con más de ${MATURE_HOURS} horas pasa de 500 visitas (el mejor, ${n(porVisitas[0].views)}; mediana, ${n(med)}).`
      steps.push('Un vídeo al día, sin tandas. Lo que se busca ahora es el primer vídeo que YouTube reparta.')
    } else if (mU < 30 && ((mP >= 100 && veces(mP, mU) >= 5) || buenos >= 3)) {
      level = 'frenado'
      headline = 'Canal frenado: los últimos vídeos casi no reciben visitas'
      summary = `${cifras} El canal tiene ${buenos} ${buenos === 1 ? 'vídeo' : 'vídeos'} por encima de 500 visitas, así que sabe llegar: YouTube ha dejado de repartir los nuevos.`
      steps.push('No subas más de un vídeo al día mientras siga así: subir más no lo arregla.')
      steps.push('Cambia una sola cosa por vídeo (tipo de clip, hora, duración) para ver qué mueve la cifra.')
    } else if (veces(mP, mU) >= 2) {
      level = 'baja'
      headline = 'El canal va a menos'
      summary = cifras
      steps.push('Compara abajo los mejores con los peores: qué tenían los anteriores que no tienen los últimos.')
    } else if (veces(mU, mP) >= DIFERENCIA && mU >= 50) {
      level = 'sube'
      headline = 'El canal va a más'
      summary = cifras
      steps.push('Mantén lo que estás haciendo: mismo ritmo y mismo tipo de clip.')
    } else {
      level = 'estable'
      headline = 'El canal se mantiene'
      summary = cifras
      steps.push('Ritmo estable. Para mejorar, prueba un solo cambio cada vez.')
    }
  }

  // ---- hallazgos (solo con vídeos de más de 48 horas)
  if (maduros.length >= 4) {
    // vídeos que YouTube apenas enseñó
    const muertos = maduros.filter((v) => v.views! < DEAD_VIEWS)
    if (muertos.length > 0) {
      let seguidos = 0
      for (let i = maduros.length - 1; i >= 0 && maduros[i].views! < DEAD_VIEWS; i--) seguidos++
      findings.push({
        tone: 'bad', weak: false,
        title: `${muertos.length} de ${maduros.length} vídeos se quedaron por debajo de ${DEAD_VIEWS} visitas`,
        detail: seguidos >= 2 ? `Entre ellos, los últimos ${seguidos} seguidos. Cuando pasa con vídeos distintos, el freno es del canal, no del vídeo.` : 'YouTube apenas los enseñó. Mira si tienen algo en común (campaña, hora, día de varias subidas).'
      })
    }

    // un vídeo que se lo lleva todo
    const total = maduros.reduce((s, v) => s + v.views!, 0)
    if (total > 0 && porVisitas[0].views! / total >= 0.5) {
      findings.push({
        tone: 'info', weak: false,
        title: `Un solo vídeo concentra el ${Math.round((porVisitas[0].views! / total) * 100)} % de las visitas`,
        detail: `${comillas(porVisitas[0].title)}, con ${n(porVisitas[0].views)}. El resto del canal vive de vídeos mucho más pequeños: por eso aquí se compara con medianas y no con medias.`
      })
    }

    // varios el mismo día frente a uno solo
    const porDia = new Map<string, number>()
    for (const v of conFecha) porDia.set(diaLocal(new Date(v.publishedAt!)), (porDia.get(diaLocal(new Date(v.publishedAt!))) ?? 0) + 1)
    const delDia = (v: ChannelVideo) => porDia.get(diaLocal(new Date(v.publishedAt!)))!
    const solos = grupo('Subidos solos ese día', maduros.filter((v) => delDia(v) === 1))
    const tanda = grupo('En días de 3 o más subidas', maduros.filter((v) => delDia(v) >= 3))
    if (solos.vs.length >= 3 && tanda.vs.length >= 3) {
      if (veces(solos.med, tanda.med) >= DIFERENCIA) {
        findings.push({ tone: 'bad', weak: debil(solos, tanda), title: 'Subir varios el mismo día rinde peor', detail: `${ficha(solos)}. ${ficha(tanda)}.` })
        steps.push('Un vídeo al día en este canal, no varios.')
      } else if (veces(tanda.med, solos.med) >= DIFERENCIA) {
        findings.push({ tone: 'info', weak: debil(solos, tanda), title: 'Los días de varias subidas no rindieron peor', detail: `${ficha(tanda)}. ${ficha(solos)}.` })
      }
    } else if (tanda.vs.length >= 3 && solos.vs.length < 3) {
      findings.push({ tone: 'info', weak: true, title: 'Casi todo se subió en tandas', detail: `${plural(tanda.vs.length, 'vídeo', 'vídeos')} en días de 3 o más subidas y solo ${solos.vs.length} en días de una. Aún no hay con qué comparar si subir de uno en uno va mejor.` })
    }

    // campaña
    const porCampaña = new Map<string, ChannelVideo[]>()
    for (const v of maduros) if (v.campaignName) porCampaña.set(v.campaignName, [...(porCampaña.get(v.campaignName) ?? []), v])
    const camp = extremos([...porCampaña].map(([nombre, vs]) => grupo(nombre, vs)), 2)
    if (camp) {
      findings.push({ tone: 'good', weak: debil(camp.mejor, camp.peor), title: `Lo que mejor funciona aquí: ${camp.mejor.nombre}`, detail: camp.todos.map(ficha).join('. ') + '.' })
      steps.push(`Da prioridad en este canal a clips de «${camp.mejor.nombre}» (o parecidos) frente a «${camp.peor.nombre}».`)
    }

    // hora de subida
    const hora = extremos(FRANJAS.map(([a, b, nombre]) => grupo(nombre, maduros.filter((v) => { const h = new Date(v.publishedAt!).getHours(); return h >= a && h < b }))), 3)
    if (hora) {
      findings.push({ tone: 'good', weak: debil(hora.mejor, hora.peor), title: `Mejor hora de subida: ${hora.mejor.nombre}`, detail: hora.todos.map((g) => ficha({ ...g, nombre: g.nombre[0].toUpperCase() + g.nombre.slice(1) })).join('. ') + '.' })
      steps.push(`Sube ${hora.mejor.nombre}.`)
    }

    // duración
    const conDuracion = maduros.filter((v) => v.durationSeconds != null)
    const dur = extremos(DURACIONES.map(([a, b, nombre]) => grupo(nombre, conDuracion.filter((v) => v.durationSeconds! >= a && v.durationSeconds! < b))), 3)
    if (dur) {
      findings.push({ tone: 'good', weak: debil(dur.mejor, dur.peor), title: `Duración que mejor rinde: ${dur.mejor.nombre}`, detail: dur.todos.map((g) => ficha({ ...g, nombre: g.nombre[0].toUpperCase() + g.nombre.slice(1) })).join('. ') + '.' })
    }

    // ¿acierta el score del generador?
    const conScore = maduros.filter((v) => v.score != null)
    const alto = grupo('Score de 90 o más', conScore.filter((v) => v.score! >= 90))
    const bajo = grupo('Score por debajo de 90', conScore.filter((v) => v.score! < 90))
    if (alto.vs.length >= 3 && bajo.vs.length >= 3) {
      if (veces(alto.med, bajo.med) >= DIFERENCIA) findings.push({ tone: 'good', weak: debil(alto, bajo), title: 'El score acierta en este canal', detail: `${ficha(alto)}. ${ficha(bajo)}.` })
      else if (veces(bajo.med, alto.med) >= DIFERENCIA) findings.push({ tone: 'info', weak: debil(alto, bajo), title: 'El score no está prediciendo las visitas en este canal', detail: `${ficha(bajo)}. ${ficha(alto)}.` })
    }

    // likes
    const conLikes = maduros.filter((v) => v.views! >= 100 && v.likes != null)
    if (conLikes.length >= 3) {
      const tasa = (v: ChannelVideo) => v.likes! / v.views!
      const mejor = [...conLikes].sort((a, b) => tasa(b) - tasa(a))[0]
      const pct = (x: number) => (x * 100).toFixed(1).replace('.', ',') + ' %'
      const orden = conLikes.map(tasa).sort((a, b) => a - b)
      findings.push({ tone: 'info', weak: conLikes.length < 5, title: `Likes: ${pct(orden[Math.floor(orden.length / 2)])} de las visitas`, detail: `Mediana de ${conLikes.length} vídeos con 100 visitas o más. El que más gusta: ${comillas(mejor.title)} (${pct(tasa(mejor))}).` })
    }
  }
  if (recientes.length > 0 && conFecha.length > recientes.length) {
    findings.push({ tone: 'info', weak: false, title: `${plural(recientes.length, 'vídeo lleva', 'vídeos llevan')} menos de ${MATURE_HOURS} horas`, detail: 'Todavía están recibiendo su primer reparto: no entran en las comparaciones.' })
  }
  if (level !== 'sin_datos' && level !== 'pocos_datos') steps.push('Vuelve a estudiar el canal cuando haya 3 vídeos nuevos con más de 48 horas.')

  // ---- datos y extremos
  const semana = conFecha.filter((v) => edad(v) < 7 * 24).length
  const facts = [
    { label: 'Vídeos públicos', value: String(canal.videos.length) },
    { label: `Con más de ${MATURE_HOURS} h`, value: String(maduros.length) },
    { label: 'Visitas por vídeo (mediana)', value: med == null ? '—' : n(med) },
    { label: 'Mejor vídeo', value: porVisitas[0] ? n(porVisitas[0].views) : '—' },
    { label: 'Subidas en 7 días', value: String(semana) },
    { label: 'Suscriptores', value: canal.subscribers == null ? '—' : n(canal.subscribers) }
  ]
  const cuantos = Math.min(3, Math.floor(maduros.length / 2))
  const best = maduros.length >= 4 ? porVisitas.slice(0, cuantos).map((v) => v.videoId) : []
  const worst = maduros.length >= 4 ? porVisitas.slice(-cuantos).reverse().map((v) => v.videoId) : []
  const limits = [
    'Solo datos públicos de YouTube: visitas, likes, comentarios y suscriptores. La retención, el porcentaje que desliza y las impresiones solo se ven en YouTube Studio.',
    `Se comparan medianas de vídeos con más de ${MATURE_HOURS} horas. Con pocos vídeos son indicios, no pruebas, y dos causas pueden coincidir (por ejemplo, una campaña que siempre se subió a la misma hora).`,
    'Los vídeos privados o borrados no aparecen.'
  ]

  const porId = new Map(canal.videos.map((v) => [v.videoId, v]))
  const linea = (id: string) => { const v = porId.get(id)!; return `  - ${n(v.views)} visitas · ${comillas(v.title)}${v.campaignName ? ` · ${v.campaignName}` : ''}` }
  const text = [
    `ESTUDIO DEL CANAL ${canal.name} · ${now.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    '',
    `${headline}. ${summary}`,
    '',
    ...facts.map((f) => `${f.label}: ${f.value}`),
    ...(findings.length ? ['', 'Hallazgos:', ...findings.map((f) => `  - ${f.title}${f.weak ? ' (indicio, pocos vídeos)' : ''}. ${f.detail}`)] : []),
    ...(best.length ? ['', 'Mejores:', ...best.map(linea), 'Peores:', ...worst.map(linea)] : []),
    '',
    'Siguientes pasos:',
    ...steps.map((s) => `  - ${s}`),
    '',
    'Vídeos, del más reciente al más antiguo:',
    ...[...conFecha].reverse().map((v) => `  - ${new Date(v.publishedAt!).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${v.views == null ? 'sin medir' : n(v.views) + ' visitas'} · ${v.likes == null ? '—' : v.likes} likes · ${v.durationSeconds == null ? '—' : Math.round(v.durationSeconds) + ' s'} · ${comillas(v.title)}${v.campaignName ? ` · ${v.campaignName}` : ''}`)
  ].join('\n')

  return { level, headline, summary, facts, findings, best, worst, steps, limits, text }
}

// ------------------------------------------------------------------ panel

/** Día a día de un canal: la última medición de cada día local y su diferencia con el día medido anterior. */
export function dailyStats(mediciones: { t: string; totalViews: number | null; subscribers: number | null; videoCount: number | null }[], subidas: (string | null)[]): ChannelDay[] {
  const porDia = new Map<string, (typeof mediciones)[number]>()
  for (const m of [...mediciones].sort((a, b) => a.t.localeCompare(b.t))) porDia.set(localDay(m.t), m)
  const subidasPorDia = new Map<string, number>()
  for (const s of subidas) if (s) subidasPorDia.set(localDay(s), (subidasPorDia.get(localDay(s)) ?? 0) + 1)
  const dias = [...porDia.keys()].sort()
  const resta = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : a - b)
  return dias.map((day, i) => {
    const m = porDia.get(day)!
    const previo = i > 0 ? porDia.get(dias[i - 1])! : null
    return {
      day, totalViews: m.totalViews, subscribers: m.subscribers, videoCount: m.videoCount,
      viewsGain: previo ? resta(m.totalViews, previo.totalViews) : null, subscribersGain: previo ? resta(m.subscribers, previo.subscribers) : null,
      daysSincePrevious: previo ? Math.round((new Date(day + 'T12:00:00').getTime() - new Date(dias[i - 1] + 'T12:00:00').getTime()) / (24 * HORA)) : null,
      uploads: subidasPorDia.get(day) ?? 0
    }
  })
}

/** Panel de cada canal seguido de ese tipo, con sus vídeos del más reciente al más antiguo. Solo lectura. */
export function getChannelDashboards(db: DB, now: Date = new Date(), kind: ChannelKind = 'clips'): ChannelDashboard[] {
  const canales = db.prepare('SELECT * FROM youtube_channels WHERE kind = ? ORDER BY added_at').all(kind) as Row[]
  return canales.map((c) => {
    const filas = db.prepare(
      `SELECT y.video_id, y.title, y.published_at, y.duration_seconds, y.views, y.likes, y.comments, y.stats_at,
         p.clip_id, k.score, k.thumb_path, k.cover_mtime_ms, k.campaign_id, COALESCE(g.display_name, g.folder_name) AS campaign_name
       FROM youtube_videos y
       LEFT JOIN publications p ON p.id = y.publication_id
       LEFT JOIN clips k ON k.clip_id = p.clip_id
       LEFT JOIN campaigns g ON g.campaign_id = k.campaign_id
       WHERE y.channel_id = ? ORDER BY y.published_at DESC, y.video_id`
    ).all(c.channel_id) as Row[]
    const series = new Map<string, { t: string; views: number }[]>()
    const medidas = db.prepare(
      `SELECT s.video_id, s.measured_at, s.views FROM youtube_video_snapshots s JOIN youtube_videos y ON y.video_id = s.video_id
       WHERE y.channel_id = ? AND s.views IS NOT NULL ORDER BY s.measured_at, s.id`
    ).all(c.channel_id) as Row[]
    for (const m of medidas) series.set(m.video_id, [...(series.get(m.video_id) ?? []), { t: m.measured_at, views: m.views }])

    const videos: ChannelVideo[] = filas.map((f) => {
      const base = { views: f.views as number | null, publishedAt: f.published_at as string | null, series: series.get(f.video_id) ?? [] }
      return {
        videoId: f.video_id, url: shortUrl(f.video_id), title: f.title, publishedAt: base.publishedAt, durationSeconds: f.duration_seconds,
        views: base.views, likes: f.likes, comments: f.comments, statsAt: f.stats_at, gain: recentGain(base, now), series: base.series,
        clipId: f.clip_id ?? null, campaignId: f.campaign_id ?? null, campaignName: f.campaign_name ?? null, score: f.score ?? null,
        hasThumb: !!f.thumb_path, thumbVersion: f.cover_mtime_ms ?? null
      }
    })
    const medidos = videos.filter((v) => v.views != null)
    const conGanancia = videos.filter((v) => v.gain)
    const desde = new Date(now.getTime() - 7 * 24 * HORA).toISOString()
    const subs = db.prepare(
      'SELECT measured_at, subscribers FROM youtube_channel_snapshots WHERE channel_id = ? AND subscribers IS NOT NULL AND measured_at >= ? ORDER BY measured_at, id'
    ).all(c.channel_id, desde) as Row[]
    const mediciones = (db.prepare(
      'SELECT measured_at, total_views, subscribers, video_count FROM youtube_channel_snapshots WHERE channel_id = ? ORDER BY measured_at, id'
    ).all(c.channel_id) as Row[]).map((m) => ({ t: m.measured_at as string, totalViews: m.total_views as number | null, subscribers: m.subscribers as number | null, videoCount: m.video_count as number | null }))
    return {
      channelId: c.channel_id, kind: c.kind, handle: c.handle, title: c.title, subscribers: c.subscribers ?? null,
      subscribersChange: subs.length >= 2 ? { delta: subs[subs.length - 1].subscribers - subs[0].subscribers, since: subs[0].measured_at } : null,
      totalViews: c.total_views ?? null, videoCount: c.video_count ?? null, statsAt: c.stats_at ?? null, lastScanAt: c.last_scan_at,
      videos,
      totals: {
        videos: videos.length, measured: medidos.length,
        views: medidos.reduce((s, v) => s + v.views!, 0), likes: medidos.reduce((s, v) => s + (v.likes ?? 0), 0), comments: medidos.reduce((s, v) => s + (v.comments ?? 0), 0),
        median: median(medidos.map((v) => v.views!)), gain: conGanancia.length ? conGanancia.reduce((s, v) => s + v.gain!.views, 0) : null, gainVideos: conGanancia.length
      },
      daily: dailyStats(mediciones, videos.map((v) => v.publishedAt)),
      study: studyChannel({ name: c.handle ?? c.title ?? c.channel_id, subscribers: c.subscribers ?? null, videos }, now)
    }
  })
}
