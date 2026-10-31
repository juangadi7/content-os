/** Calendario: lo automático (subidas, fin de semana, plazos, lo subido) y las tareas, día a día. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_ADVICE } from '../src/core/advice'
import { addCalendarTask, deleteCalendarTask, getCalendar, loadCalendarNotes, setCalendarTaskDone, type CalendarNote } from '../src/core/calendar'
import { setCampaignStatus } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getPlan, saveAccount } from '../src/core/plan'
import { getWeekendPlan } from '../src/core/weekend'
import { CampaignFixture, tmpDir } from './fixtures/builder'

// miércoles 14 de octubre de 2026, 13:00
const HOY = new Date(2026, 9, 14, 13, 0)
let base: string
let db: DB
const cal = (notes: CalendarNote[] = [], from = '2026-10-12', to = '2026-10-25') =>
  getCalendar(db, from, to, HOY, { plan: getPlan(db, HOY), weekend: getWeekendPlan(db, HOY, NO_ADVICE), notes })
const del = (c: ReturnType<typeof cal>, dia: string) => c.days.find((d) => d.date === dia)!.items

beforeEach(() => {
  base = tmpDir('cos_cal_')
  const root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const c = new CampaignFixture(root, 'PODCAST', 'podcast', 'Podcast')
  for (let n = 1; n <= 12; n++) c.addClip({ n, clipId: `clp_${n}`, score: 100 - n, content: `clip ${n}` })
  syncLibraries(db, { roots: [root] })
  setCampaignStatus(db, { campaignId: 'podcast', endsAt: '2026-10-20' })
  saveAccount(db, { platform: 'youtube', name: '@democlips', dailyLimit: 1 })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('lo automático', () => {
  it('hoy: lo que propone «Hoy»; entre semana, previsión; el fin de semana no se prevé subida (va programado)', () => {
    const c = cal()
    expect(del(c, '2026-10-14').filter((i) => i.kind === 'upload').map((i) => [i.title, i.forecast])).toEqual([['Subir 1 en @democlips', false]])
    expect(del(c, '2026-10-15').find((i) => i.kind === 'upload')).toMatchObject({ forecast: true, title: 'Subir 1 en @democlips' })
    expect(del(c, '2026-10-17').some((i) => i.kind === 'upload')).toBe(false)
    expect(del(c, '2026-10-13').some((i) => i.kind === 'upload')).toBe(false) // el pasado no se prevé
  })

  it('el viernes, preparar el fin de semana con lo que falta; el lunes, Vyro; el último día de la campaña', () => {
    const c = cal()
    expect(del(c, '2026-10-16').find((i) => i.kind === 'weekend')).toMatchObject({ title: 'Preparar el fin de semana', detail: '2 vídeos por programar para sábado y domingo', done: false })
    expect(del(c, '2026-10-17').find((i) => i.kind === 'weekend')?.title).toBe('Sin programar: 1 en @democlips')
    expect(del(c, '2026-10-19').some((i) => i.kind === 'vyro')).toBe(true)
    expect(del(c, '2026-10-20').find((i) => i.kind === 'deadline')).toMatchObject({ title: 'Último día: Podcast', detail: 'Quedan 12 clips sin publicar' })
  })

  it('lo programado sale en su día y hora; lo subido, como hecho', () => {
    const pub = (clip: string, cuando: Date) =>
      db.prepare("INSERT INTO publications (clip_id, platform, account, status, published_at, created_at, updated_at) VALUES (?, 'youtube', '@democlips', 'published', ?, 't', 't')").run(clip, cuando.toISOString())
    pub('clp_1', new Date(2026, 9, 13, 18, 30))
    pub('clp_2', new Date(2026, 9, 17, 12, 30))
    const c = cal()
    expect(del(c, '2026-10-13').find((i) => i.kind === 'published')).toMatchObject({ time: '18:30', done: true, link: { clipId: 'clp_1' } })
    expect(del(c, '2026-10-17').find((i) => i.kind === 'scheduled')).toMatchObject({ time: '12:30', done: false, detail: 'Programado · YouTube · @democlips · cuando salga, a Vyro' })
    // lo ya subido que falta enviar a Vyro sale hoy
    expect(del(c, '2026-10-14').find((i) => i.kind === 'vyro' && i.id === 'vyro-enviar')).toMatchObject({ title: 'Enviar a Vyro: 1 vídeo ya público', link: { view: 'today' } })
  })
})

describe('tareas', () => {
  it('las apuntadas se ven en su día, se marcan, se borran; y validan día, hora y texto', () => {
    addCalendarTask(db, { day: '2026-10-15', time: '10:00', text: 'Grabar intro' })
    let t = del(cal(), '2026-10-15').find((i) => i.kind === 'task')!
    expect(t).toMatchObject({ title: 'Grabar intro', time: '10:00', source: 'mine', done: false })
    setCalendarTaskDone(db, t.taskId!, true)
    t = del(cal(), '2026-10-15').find((i) => i.kind === 'task')!
    expect(t.done).toBe(true)
    deleteCalendarTask(db, t.taskId as number)
    expect(del(cal(), '2026-10-15').some((i) => i.kind === 'task')).toBe(false)
    expect(() => addCalendarTask(db, { day: '15-10-2026', text: 'x' })).toThrow('Día no válido')
    expect(() => addCalendarTask(db, { day: '2026-10-15', time: '25:00', text: 'x' })).toThrow('Hora no válida')
    expect(() => addCalendarTask(db, { day: '2026-10-15', text: '  ' })).toThrow('Escribe la tarea')
  })

  it('las de Claude se leen de calendario.json y su «hecha» se guarda en la app', () => {
    const f = path.join(base, 'calendario.json')
    fs.writeFileSync(f, JSON.stringify({ tareas: [
      { id: 'roblox', dia: '2026-10-18', hora: '17:00', texto: 'Subir el clip de Roblox a TikTok', detalle: 'Fuera de campaña' },
      { id: 'mal', dia: 'mañana', texto: 'no vale' },
    ] }))
    const { notes, error } = loadCalendarNotes(f)
    expect(error).toBeNull()
    expect(notes.map((n) => n.id)).toEqual(['roblox'])
    let n = del(cal(notes), '2026-10-18').find((i) => i.source === 'claude')!
    expect(n).toMatchObject({ title: 'Subir el clip de Roblox a TikTok', time: '17:00', done: false })
    setCalendarTaskDone(db, 'roblox', true)
    n = del(cal(notes), '2026-10-18').find((i) => i.source === 'claude')!
    expect(n.done).toBe(true)
    expect(loadCalendarNotes(path.join(base, 'no-existe.json'))).toEqual({ notes: [], error: null })
  })
})
