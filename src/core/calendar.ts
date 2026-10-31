/**
 * Calendario: qué toca cada día, en un solo sitio.
 *
 * Junta lo que ya sabe la aplicación (lo que sale del plan de «Hoy», lo programado para el fin de semana,
 * lo ya subido, los últimos días de cada campaña, cuándo va una campaña a la Papelera) con dos listas de tareas:
 *   - las que el usuario apunta aquí (tabla calendar_tasks);
 *   - las que le deja Claude en <biblioteca>\..\PLAN\calendario.json (solo se leen; el «hecha» se guarda aquí).
 *
 * Lo automático de días futuros es una previsión con el ritmo de hoy (canales, tope diario y clips pendientes),
 * no una promesa: el plan de cada día lo da «Hoy» ese día.
 */
import fs from 'node:fs'
import type { DB } from './db'
import { PLATFORM_LABEL, type Platform } from './format'
import type { PlanView } from './plan'
import { listCampaigns, today } from './queries'
import type { WeekendPlan } from './weekend'
import { listVyroPending } from './vyro-pending'

type Row = Record<string, any>

export type CalendarKind = 'upload' | 'weekend' | 'vyro' | 'deadline' | 'scheduled' | 'published' | 'purge' | 'task'

export interface CalendarItem {
  /** Único dentro del día. */
  id: string
  kind: CalendarKind
  /** auto = lo calcula la aplicación; mine = apuntada por el usuario; claude = de PLAN\calendario.json. */
  source: 'auto' | 'mine' | 'claude'
  title: string
  detail: string | null
  /** HH:MM local, si tiene hora. */
  time: string | null
  done: boolean
  /** Previsión (día futuro): puede cambiar. */
  forecast: boolean
  /** Adónde lleva al pulsarlo. */
  link: { view: 'today' | 'weekend' | 'vyro' } | { clipId: string } | { campaignId: string } | null
  /** Para marcar/borrar: id de la tarea (mine) o de la nota (claude). */
  taskId: number | string | null
}

export interface CalendarDay {
  date: string
  items: CalendarItem[]
}

export interface CalendarView {
  from: string
  to: string
  today: string
  days: CalendarDay[]
  /** Ruta del archivo de tareas de Claude y si se pudo leer. */
  notesFile: string | null
  notesError: string | null
}

/** Tarea que deja Claude en PLAN\calendario.json. */
export interface CalendarNote {
  id: string
  day: string
  time: string | null
  text: string
  detail: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')
const DIA = /^\d{4}-\d{2}-\d{2}$/
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/
const masDias = (dia: string, n: number) => {
  const [y, m, d] = dia.split('-').map(Number)
  const f = new Date(y, m - 1, d + n)
  return `${f.getFullYear()}-${pad(f.getMonth() + 1)}-${pad(f.getDate())}`
}
const diaSemana = (dia: string) => {
  const [y, m, d] = dia.split('-').map(Number)
  return new Date(y, m - 1, d).getDay() // 0 domingo … 6 sábado
}
const horaLocal = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const nombreDia = (dia: string) => {
  const [y, m, d] = dia.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('es-ES', { weekday: 'long' })
}

/** Lee PLAN\calendario.json: { "tareas": [{ "id", "dia": "AAAA-MM-DD", "hora"?: "HH:MM", "texto", "detalle"? }] }. */
export function loadCalendarNotes(file: string | null): { notes: CalendarNote[]; error: string | null } {
  if (!file || !fs.existsSync(file)) return { notes: [], error: null }
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { tareas?: unknown }
    if (!Array.isArray(v.tareas)) return { notes: [], error: 'calendario.json no tiene la lista "tareas".' }
    const notes: CalendarNote[] = []
    for (const t of v.tareas as Record<string, unknown>[]) {
      if (!t || typeof t !== 'object') continue
      const id = typeof t.id === 'string' ? t.id.trim() : ''
      const dia = typeof t.dia === 'string' ? t.dia.trim() : ''
      const texto = typeof t.texto === 'string' ? t.texto.trim() : ''
      if (!id || !DIA.test(dia) || !texto) continue
      const hora = typeof t.hora === 'string' && HORA.test(t.hora.trim()) ? t.hora.trim() : null
      notes.push({ id, day: dia, time: hora, text: texto, detail: typeof t.detalle === 'string' && t.detalle.trim() ? t.detalle.trim() : null })
    }
    return { notes, error: null }
  } catch (e) {
    return { notes: [], error: `No se pudo leer calendario.json: ${(e as Error).message}` }
  }
}

const claveNota = (id: string) => `cal_done:${id}`

export function getCalendar(
  db: DB, from: string, to: string, now: Date,
  ctx: { plan: PlanView; weekend: WeekendPlan; notes: CalendarNote[]; notesFile?: string | null; notesError?: string | null }
): CalendarView {
  if (!DIA.test(from) || !DIA.test(to) || from > to) throw new Error('Fechas no válidas.')
  const hoy = today(now)
  const dias: string[] = []
  for (let d = from; d <= to && dias.length < 120; d = masDias(d, 1)) dias.push(d)
  const porDia = new Map<string, CalendarItem[]>(dias.map((d) => [d, []]))
  const poner = (dia: string, item: CalendarItem) => porDia.get(dia)?.push(item)

  // ---- lo subido y lo programado
  const pubs = db.prepare(
    `SELECT p.id, p.clip_id, p.platform, p.account, p.published_at, COALESCE(k.title, k.filename, k.clip_id) AS title
     FROM publications p JOIN clips k ON k.clip_id = p.clip_id
     WHERE p.status = 'published' AND p.published_at IS NOT NULL`
  ).all() as Row[]
  for (const p of pubs) {
    const dia = today(new Date(p.published_at))
    if (!porDia.has(dia)) continue
    const futuro = new Date(p.published_at).getTime() > now.getTime()
    const donde = `${PLATFORM_LABEL[p.platform as Platform] ?? p.platform}${p.account ? ` · ${String(p.account).replace(/ · .*$/, '')}` : ''}`
    poner(dia, {
      id: `pub-${p.id}`, kind: futuro ? 'scheduled' : 'published', source: 'auto', title: p.title, detail: futuro ? `Programado · ${donde} · cuando salga, a Vyro` : `Subido · ${donde}`,
      time: horaLocal(p.published_at), done: !futuro, forecast: false, link: { clipId: p.clip_id }, taskId: null,
    })
  }

  // ---- campañas: último día y Papelera
  for (const c of listCampaigns(db, now)) {
    if (c.endsAt && porDia.has(c.endsAt)) {
      const pendientes = c.clips - c.clipsPublished
      poner(c.endsAt, {
        id: `fin-${c.campaignId}`, kind: 'deadline', source: 'auto',
        title: c.endsAt < hoy ? `Acabó: ${c.displayName}` : `Último día: ${c.displayName}`,
        detail: c.endsAt >= hoy && !c.closed && pendientes > 0 ? `Quedan ${pendientes} ${pendientes === 1 ? 'clip' : 'clips'} sin publicar` : null,
        time: null, done: c.endsAt < hoy || c.closed, forecast: false, link: { campaignId: c.campaignId }, taskId: null,
      })
    }
    if (c.presentInSource && c.purgeOn && porDia.has(c.purgeOn) && c.purgeOn >= hoy) {
      poner(c.purgeOn, {
        id: `papelera-${c.campaignId}`, kind: 'purge', source: 'auto', title: `${c.displayName} va a la Papelera`,
        detail: 'Automático: una semana después de acabar. Sus cifras se quedan en la app.', time: null, done: false, forecast: false,
        link: { campaignId: c.campaignId }, taskId: null,
      })
    }
  }

  // ---- subidas: hoy, lo que propone «Hoy»; días futuros entre semana, previsión al ritmo de cada canal
  const plataformas = new Map(ctx.plan.platforms.map((p) => [p.platform, p]))
  for (const a of ctx.plan.accounts) {
    if (a.hold) continue
    const nombre = a.account.name
    const pf = a.account.platform
    if (porDia.has(hoy) && a.suggestions.length) {
      poner(hoy, {
        id: `subir-${a.account.id}`, kind: 'upload', source: 'auto',
        title: `Subir ${a.suggestions.length} en ${nombre}`,
        detail: `${PLATFORM_LABEL[pf]} · ${a.suggestions.map((s) => s.clip.title ?? s.clip.filename ?? s.clip.clipId).join(' · ')}`,
        time: a.nextAt && new Date(a.nextAt).getTime() > now.getTime() ? horaLocal(a.nextAt) : a.window ? `${pad(a.window[0])}:00` : null,
        done: false, forecast: false, link: { view: 'today' }, taskId: null,
      })
    }
    const dura = plataformas.get(pf)?.daysOfContent ?? 0
    for (const d of dias) {
      if (d <= hoy) continue
      const w = diaSemana(d)
      if (w === 0 || w === 6) continue // el fin de semana va programado
      const offset = Math.round((Date.parse(d + 'T12:00:00Z') - Date.parse(hoy + 'T12:00:00Z')) / 86_400_000)
      if (offset >= Math.ceil(dura)) continue // a este ritmo ya no quedaría nada que subir
      poner(d, {
        id: `subir-${a.account.id}`, kind: 'upload', source: 'auto', title: `Subir ${a.account.dailyLimit} en ${nombre}`,
        detail: `${PLATFORM_LABEL[pf]} · previsión con lo pendiente de hoy`, time: a.window ? `${pad(a.window[0])}:00` : null,
        done: false, forecast: true, link: { view: 'today' }, taskId: null,
      })
    }
  }

  // ---- fin de semana: el viernes se prepara; el sábado y el domingo, lo que quede sin programar
  const huecos = ctx.weekend.accounts.flatMap((a) => a.slots.map((s) => ({ a, s })))
  const sinProgramar = huecos.filter((x) => !x.s.scheduled && x.s.clip)
  const viernesDelFinde = ctx.weekend.days.length ? masDias(ctx.weekend.days[0], diaSemana(ctx.weekend.days[0]) === 6 ? -1 : -2) : null
  if (ctx.plan.accounts.length) {
    for (const d of dias) {
      if (diaSemana(d) === 5 && d >= hoy) {
        const esEste = d === viernesDelFinde
        poner(d, {
          id: 'finde', kind: 'weekend', source: 'auto', title: 'Preparar el fin de semana',
          detail: esEste
            ? sinProgramar.length ? `${sinProgramar.length} ${sinProgramar.length === 1 ? 'vídeo' : 'vídeos'} por programar para sábado y domingo` : huecos.length ? 'Todo programado' : 'No hay huecos que llenar'
            : 'Programar los vídeos del sábado y el domingo',
          time: null, done: esEste && huecos.length > 0 && sinProgramar.length === 0, forecast: !esEste, link: { view: 'weekend' }, taskId: null,
        })
      }
      if (diaSemana(d) === 1 && d >= hoy) {
        poner(d, {
          id: 'vyro', kind: 'vyro', source: 'auto', title: 'Enviar a Vyro lo del fin de semana',
          detail: 'Add posts con los enlaces de lo que salió el sábado y el domingo', time: null, done: false, forecast: d > hoy, link: { view: 'vyro' }, taskId: null,
        })
      }
    }
    for (const d of ctx.weekend.days) {
      if (!porDia.has(d) || d <= hoy) continue
      const deDia = sinProgramar.filter((x) => x.s.day === d)
      for (const a of [...new Set(deDia.map((x) => x.a))]) {
        const n = deDia.filter((x) => x.a === a).length
        poner(d, {
          id: `sinprog-${a.account.id}`, kind: 'weekend', source: 'auto', title: `Sin programar: ${n} en ${a.account.name}`,
          detail: `Prepáralo el viernes en «Fin de semana» (${nombreDia(d)})`, time: null, done: false, forecast: false, link: { view: 'weekend' }, taskId: null,
        })
      }
    }
  }

  // ---- lo ya público que falta enviar a Vyro (hoy)
  const porEnviar = listVyroPending(db, now)
  if (porEnviar.length && porDia.has(hoy)) {
    poner(hoy, {
      id: 'vyro-enviar', kind: 'vyro', source: 'auto', title: `Enviar a Vyro: ${porEnviar.length} ${porEnviar.length === 1 ? 'vídeo' : 'vídeos'} ya ${porEnviar.length === 1 ? 'público' : 'públicos'}`,
      detail: porEnviar.slice(0, 4).map((p) => p.title).join(' · '), time: null, done: false, forecast: false, link: { view: 'today' }, taskId: null,
    })
  }

  // ---- tareas apuntadas por el usuario y notas de Claude
  for (const t of db.prepare('SELECT * FROM calendar_tasks WHERE day BETWEEN ? AND ? ORDER BY time IS NULL, time, id').all(from, to) as Row[]) {
    poner(t.day, { id: `t-${t.id}`, kind: 'task', source: 'mine', title: t.text, detail: null, time: t.time, done: t.done === 1, forecast: false, link: null, taskId: t.id })
  }
  const hechas = new Set((db.prepare("SELECT key FROM settings WHERE key LIKE 'cal_done:%'").all() as Row[]).map((r) => String(r.key).slice('cal_done:'.length)))
  for (const n of ctx.notes) {
    poner(n.day, { id: `n-${n.id}`, kind: 'task', source: 'claude', title: n.text, detail: n.detail, time: n.time, done: hechas.has(n.id), forecast: false, link: null, taskId: n.id })
  }

  const ORDEN: Record<CalendarKind, number> = { deadline: 0, upload: 1, weekend: 2, vyro: 3, task: 4, scheduled: 5, published: 6, purge: 7 }
  const days = dias.map((date) => ({
    date,
    items: porDia.get(date)!.sort((a, b) => Number(a.done) - Number(b.done) || ORDEN[a.kind] - ORDEN[b.kind] || (a.time ?? '99').localeCompare(b.time ?? '99')),
  }))
  return { from, to, today: hoy, days, notesFile: ctx.notesFile ?? null, notesError: ctx.notesError ?? null }
}

export interface CalendarTaskInput {
  day: string
  time?: string | null
  text: string
}

export function addCalendarTask(db: DB, input: CalendarTaskInput, now = new Date()): void {
  const day = typeof input?.day === 'string' ? input.day : ''
  const text = typeof input?.text === 'string' ? input.text.trim() : ''
  const time = typeof input?.time === 'string' && input.time ? input.time : null
  if (!DIA.test(day)) throw new Error('Día no válido.')
  if (!text || text.length > 500) throw new Error('Escribe la tarea (máximo 500 letras).')
  if (time !== null && !HORA.test(time)) throw new Error('Hora no válida.')
  db.prepare('INSERT INTO calendar_tasks (day, time, text, done, created_at) VALUES (?, ?, ?, 0, ?)').run(day, time, text, now.toISOString())
}

/** Marca una tarea como hecha (o no). `id` numérico = del usuario; texto = nota de Claude. */
export function setCalendarTaskDone(db: DB, id: unknown, done: boolean): void {
  if (typeof id === 'number' && Number.isInteger(id)) {
    db.prepare('UPDATE calendar_tasks SET done = ? WHERE id = ?').run(done ? 1 : 0, id)
  } else if (typeof id === 'string' && id && id.length <= 200) {
    if (done) db.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(claveNota(id))
    else db.prepare('DELETE FROM settings WHERE key = ?').run(claveNota(id))
  } else throw new Error('Tarea no válida.')
}

/** Borra una tarea apuntada por el usuario (las de Claude se quitan de su archivo). */
export function deleteCalendarTask(db: DB, id: unknown): void {
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('Tarea no válida.')
  db.prepare('DELETE FROM calendar_tasks WHERE id = ?').run(id)
}
