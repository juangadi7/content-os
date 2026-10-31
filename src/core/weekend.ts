/**
 * Plan del fin de semana: se prepara el viernes y deja programado el sábado y el domingo.
 *
 * Para cada canal de publicación (los de «Hoy»), cuántos huecos tiene cada día y a qué hora, y qué clip
 * va en cada uno. Mismas reglas que «Hoy»: tope diario, franja y horas mínimas de PLAN\canales.json,
 * campañas asignadas, reglas de no subir, un clip una sola vez por plataforma (regla de Vyro)
 * y nunca un clip de una campaña que ya habrá acabado ese día.
 *
 * Programar un clip = guardar su publicación con la fecha y hora a la que saldrá. Cuando YouTube lo
 * publica, la sincronización de canales lo enlaza solo con esa publicación (la que no tiene enlace).
 */
import { capAccounts, channelKey, clipNumber, type Advice, type ChannelAdvice } from './advice'
import type { DB } from './db'
import { withChannelVideos } from './youtube-channels'
import { PLATFORMS } from './format'
import { accountTakesCampaign, compareCampaignPriority, lastCampaignByChannel, pickAlternating, URGENTE_DIAS, withAdviceAssignments, getPlan, listAccounts, withLiveAssignments, type AccountView } from './plan'
import { listCampaigns, listClips, today, type ClipView } from './queries'

type Row = Record<string, any>

export interface WeekendSlot {
  /** AAAA-MM-DD */
  day: string
  /** Hora a la que conviene que salga (ISO). */
  at: string
  /** Ya programado: la publicación guardada para ese hueco. */
  scheduled: { publicationId: number; clipId: string; title: string | null; caption: string | null; at: string } | null
  /** Propuesta para el hueco (si no está programado). */
  clip: ClipView | null
  caption: string | null
  daysLeft: number | null
}

export interface WeekendOption {
  clip: ClipView
  caption: string | null
  /** Último día de su campaña (AAAA-MM-DD), para no elegirlo para un día en que ya habrá acabado. */
  endsAt: string | null
}

export interface WeekendAccount {
  account: AccountView
  note: string | null
  slots: WeekendSlot[]
  /** Todo lo que vale para este canal (para elegir otro en un hueco), en el mismo orden que el plan. */
  options: WeekendOption[]
}

export interface WeekendPlan {
  /** Los días que cubre: sábado y domingo (o solo el domingo si hoy ya es domingo). */
  days: string[]
  accounts: WeekendAccount[]
  /** Huecos sin clip porque no queda nada que subir en esa plataforma. */
  empty: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const dia = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Sábado y domingo que vienen; si hoy es sábado, hoy y mañana; si es domingo, solo hoy. */
export function weekendDays(now: Date): string[] {
  const w = now.getDay() // 0 domingo … 6 sábado
  if (w === 0) return [dia(now)]
  const sab = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (6 - w))
  const dom = new Date(sab.getFullYear(), sab.getMonth(), sab.getDate() + 1)
  return [dia(sab), dia(dom)]
}

/**
 * Horas de los huecos de un día: el primero media hora después de abrir la franja y los siguientes separados
 * por las horas mínimas del canal (o repartidos en la franja). Los que no caben antes de cerrar la franja no se dan.
 */
export function slotTimes(day: string, n: number, c: ChannelAdvice): Date[] {
  const [desde, hasta] = c.window ?? [12, 15]
  const [y, m, d] = day.split('-').map(Number)
  const fin = hasta - 0.5
  const primero = Math.min(desde + 0.5, fin)
  // con horas mínimas, justo esas horas después del anterior; sin ellas, repartidos en la franja
  const paso = c.minHours ? c.minHours : n > 1 ? (fin - primero) / (n - 1) : 0
  const out: Date[] = []
  for (let i = 0; i < n; i++) {
    const h = primero + i * paso
    if (i > 0 && (h > fin + 1e-9 || paso <= 0)) break
    out.push(new Date(y, m - 1, d, Math.floor(h), Math.round((h % 1) * 60)))
  }
  return out
}

export function getWeekendPlan(db: DB, now: Date, advice: Advice): WeekendPlan {
  const days = weekendDays(now)
  const campañas = new Map(listCampaigns(db, now).map((c) => [c.campaignId, c]))
  // solo cuentan las asignaciones a campañas abiertas (como en «Hoy»)
  const todas = capAccounts(withLiveAssignments(withAdviceAssignments(listAccounts(db), advice), campañas), advice)
  const cuentas = todas.filter((a) => a.active)
  const captions = new Map((db.prepare('SELECT clip_id, caption FROM clips').all() as Row[]).map((r) => [r.clip_id as string, r.caption as string | null]))
  // días que le quedan a la campaña contando el día del hueco (null = sin fecha de fin)
  const quedan = (k: ClipView, d: string) => {
    const fin = campañas.get(k.campaignId)?.endsAt
    return fin ? Math.round((Date.parse(fin + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86_400_000) + 1 : null
  }

  // clips que se pueden subir, en el mismo orden que «Hoy» (compareCampaignPriority) y dentro el orden de calidad
  // regla nº1: lo que ya está en cualquiera de tus canales de YouTube no se vuelve a proponer
  const subibles = withChannelVideos(db, listClips(db, null, now))
    .filter((k) => k.presentInSource && !k.campaignClosed && k.fileState !== 'missing' && campañas.get(k.campaignId)?.state !== 'generating')
    .map((k, i) => ({ k, i }))
    .sort((a, b) => compareCampaignPriority(campañas.get(a.k.campaignId), campañas.get(b.k.campaignId)) || a.i - b.i)
    .map((x) => x.k)

  // campaña del último vídeo de cada canal, para alternar campañas (como en «Hoy»)
  const anteriores = lastCampaignByChannel(db, now)

  // publicaciones: las del fin de semana ocupan su hueco
  const pubs = db.prepare(
    `SELECT p.id, p.clip_id, p.platform, p.account, p.published_at, p.url, COALESCE(k.title, k.filename, k.clip_id) AS title, k.caption
     FROM publications p JOIN clips k ON k.clip_id = p.clip_id WHERE p.status = 'published' AND p.published_at IS NOT NULL`
  ).all() as Row[]

  // si el fin de semana aún no ha empezado, lo que «Hoy» propone para hoy queda para hoy: no se repite el sábado
  const reservados = new Map<string, Set<string>>()
  if (!days.includes(today(now))) {
    for (const a of getPlan(db, now, advice).accounts) {
      const r = reservados.get(a.account.platform) ?? new Set<string>()
      for (const s of a.suggestions) r.add(s.clip.clipId)
      reservados.set(a.account.platform, r)
    }
  }

  const accounts: WeekendAccount[] = []
  let empty = 0
  for (const pf of PLATFORMS) {
    const canales = cuentas.filter((a) => a.platform === pf)
    if (!canales.length) continue
    const evitado = (k: ClipView) => {
      const a = advice.campaigns.get(k.campaignId)
      const n = clipNumber(k.filename)
      return !!a?.avoidPlatforms.some((x) => x.platform === pf) || !!a?.avoidClips.some((x) => x.platform === pf && n != null && x.clips.includes(n))
    }
    const usados = new Set<string>()
    const deHoy = reservados.get(pf) ?? new Set<string>()
    const frescos = subibles.filter((k) => !k.published.includes(pf) && !evitado(k) && !deHoy.has(k.clipId))

    const filas = canales.map((account): WeekendAccount => {
      const consejo = advice.channels.get(channelKey(pf, account.name)) ?? advice.defaults
      const options = frescos.filter((k) => accountTakesCampaign(account, k.campaignId, todas))
        .map((k) => ({ clip: k, caption: captions.get(k.clipId) ?? null, endsAt: campañas.get(k.campaignId)?.endsAt ?? null }))
      return { account, note: consejo.note, slots: [], options }
    })
    // por días y por rondas (1.º de cada canal, 2.º de cada canal…), igual que «Hoy»
    for (const d of days) {
      const huecos: { fila: WeekendAccount; at: Date }[] = []
      const porFila = filas.map((fila) => {
        const consejo = advice.channels.get(channelKey(pf, fila.account.name)) ?? advice.defaults
        if (consejo.hold) return { fila, horas: [] as Date[], ya: [] as Row[] }
        const ya = pubs.filter((p) => p.platform === pf && String(p.account).toLowerCase() === fila.account.name.toLowerCase() && today(new Date(p.published_at)) === d)
        const horas = slotTimes(d, fila.account.dailyLimit, consejo)
        return { fila, horas, ya }
      })
      const rondas = Math.max(0, ...porFila.map((x) => x.horas.length))
      for (let r = 0; r < rondas; r++) {
        for (const { fila, horas, ya } of porFila) {
          if (r >= horas.length) continue
          // lo ya programado ese día ocupa los primeros huecos
          if (r < ya.length) {
            const p = ya.sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)))[r]
            usados.add(p.clip_id)
            fila.slots.push({ day: d, at: p.published_at, scheduled: { publicationId: p.id, clipId: p.clip_id, title: p.title, caption: p.caption, at: p.published_at }, clip: null, caption: null, daysLeft: null })
            continue
          }
          // un hueco de hoy cuya hora ya pasó no se puede programar: lo de ahora lo lleva «Hoy»
          if (horas[r].getTime() <= now.getTime()) continue
          huecos.push({ fila, at: horas[r] })
        }
      }
      for (const { fila, at } of huecos) {
        const vale = (k: ClipView) => !usados.has(k.clipId) && accountTakesCampaign(fila.account, k.campaignId, todas) && (quedan(k, d) ?? 1) >= 1
        // como en «Hoy»: no dos seguidos de la misma campaña en un canal si hay otra disponible
        const clave = channelKey(pf, fila.account.name)
        const clip = pickAlternating(frescos.filter(vale), anteriores.get(clave), (k) => (campañas.get(k.campaignId)?.daysLeft ?? Infinity) <= URGENTE_DIAS) ?? null
        if (clip) {
          usados.add(clip.clipId)
          anteriores.set(clave, clip.campaignId)
        }
        else empty++
        fila.slots.push({ day: d, at: at.toISOString(), scheduled: null, clip, caption: clip ? captions.get(clip.clipId) ?? null : null, daysLeft: clip ? quedan(clip, d) : null })
      }
    }
    for (const f of filas) f.slots.sort((a, b) => a.at.localeCompare(b.at))
    accounts.push(...filas)
  }
  return { days, accounts, empty }
}
