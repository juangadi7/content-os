/** Plan del fin de semana: huecos de sábado y domingo por canal, con su hora y su clip, y lo ya programado. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_ADVICE, type Advice, type ChannelAdvice } from '../src/core/advice'
import { setCampaignStatus } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getPlan, saveAccount } from '../src/core/plan'
import { savePublication } from '../src/core/publications'
import { getWeekendPlan, slotTimes, weekendDays } from '../src/core/weekend'
import { CampaignFixture, tmpDir } from './fixtures/builder'

let base: string
let db: DB
const VIERNES = new Date(2026, 9, 16, 18, 0)
const hm = (d: Date | string) => { const x = new Date(d); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}` }
const consejo = (c: Partial<ChannelAdvice>): ChannelAdvice => ({ minHours: null, window: null, note: null, hold: false, ...c })
// como PLAN\canales.json: por defecto 20 h y franja 12–15; el canal bueno, 6 h y franja 12–22
const ADVICE: Advice = {
  ...NO_ADVICE,
  defaults: consejo({ minHours: 20, window: [12, 15] }),
  channels: new Map([['youtube:@clipsparatodos', consejo({ minHours: 6, window: [12, 22], note: 'dos al día' })]]),
}

beforeEach(() => {
  base = tmpDir('cos_finde_')
  const root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const p = new CampaignFixture(root, 'PODCAST', 'podcast', 'Podcast')
  ;[95, 90, 85, 80, 75, 70].forEach((score, i) => p.addClip({ n: i + 1, clipId: `clp_p${i + 1}`, score }))
  new CampaignFixture(root, 'CORTA', 'corta', 'Corta').addClip({ n: 1, clipId: 'clp_c1', score: 99 })
  syncLibraries(db, { roots: [root] })
  saveAccount(db, { platform: 'youtube', name: '@democlips', dailyLimit: 1 })
  saveAccount(db, { platform: 'youtube', name: '@clipsparatodos', dailyLimit: 2 })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('días y horas', () => {
  it('el viernes (o antes) mira el sábado y el domingo que vienen; el sábado, hoy y mañana; el domingo, solo hoy', () => {
    expect(weekendDays(new Date(2026, 9, 13, 10))).toEqual(['2026-10-17', '2026-10-18'])
    expect(weekendDays(VIERNES)).toEqual(['2026-10-17', '2026-10-18'])
    expect(weekendDays(new Date(2026, 9, 17, 9))).toEqual(['2026-10-17', '2026-10-18'])
    expect(weekendDays(new Date(2026, 9, 18, 9))).toEqual(['2026-10-18'])
  })

  it('el primer hueco al abrir la franja y los siguientes separados por las horas mínimas, sin salirse de ella', () => {
    expect(slotTimes('2026-10-17', 1, consejo({ minHours: 20, window: [12, 15] })).map(hm)).toEqual(['12:30'])
    expect(slotTimes('2026-10-17', 2, consejo({ minHours: 6, window: [12, 22] })).map(hm)).toEqual(['12:30', '18:30'])
    // tres al día con 20 horas entre subidas no caben: uno
    expect(slotTimes('2026-10-17', 3, consejo({ minHours: 20, window: [12, 15] })).map(hm)).toEqual(['12:30'])
    // sin horas mínimas, repartidos en la franja
    expect(slotTimes('2026-10-17', 3, consejo({ window: [12, 22] })).map(hm)).toEqual(['12:30', '17:00', '21:30'])
  })
})

describe('plan del fin de semana', () => {
  /** Lo que «Hoy» propone el viernes: queda para el viernes. */
  const deHoy = () => new Set(getPlan(db, VIERNES, ADVICE).accounts.flatMap((a) => a.suggestions.map((s) => s.clip.clipId)))

  it('cada canal recibe sus huecos de sábado y domingo con clips distintos, los mejores que quedan primero', () => {
    const hoy = deHoy()
    const p = getWeekendPlan(db, VIERNES, ADVICE)
    const de = (n: string) => p.accounts.find((a) => a.account.name === n)!.slots
    expect(de('@democlips').map((s) => [s.day, hm(s.at)])).toEqual([['2026-10-17', '12:30'], ['2026-10-18', '12:30']])
    expect(de('@clipsparatodos').map((s) => [s.day, hm(s.at)])).toEqual([['2026-10-17', '12:30'], ['2026-10-17', '18:30'], ['2026-10-18', '12:30'], ['2026-10-18', '18:30']])
    const finde = p.accounts.flatMap((a) => a.slots.map((s) => s.clip?.clipId)).filter((c): c is string => !!c)
    expect(new Set(finde).size).toBe(finde.length)
    // por orden de calidad entre lo que queda (los de «Hoy» fuera)
    const orden = ['clp_c1', 'clp_p1', 'clp_p2', 'clp_p3', 'clp_p4', 'clp_p5', 'clp_p6'].filter((c) => !hoy.has(c))
    expect([...finde].sort((a, b) => orden.indexOf(a) - orden.indexOf(b))).toEqual(orden.slice(0, finde.length))
  })

  it('lo que «Hoy» propone el viernes no sale también el fin de semana (antes salía en los dos)', () => {
    const hoy = deHoy()
    expect(hoy.size).toBeGreaterThan(0)
    const p = getWeekendPlan(db, VIERNES, ADVICE)
    expect(p.accounts.flatMap((a) => a.slots).filter((s) => s.clip && hoy.has(s.clip.clipId))).toEqual([])
    expect(p.accounts.flatMap((a) => a.options).filter((o) => hoy.has(o.clip.clipId))).toEqual([])
    // ya en sábado, lo de hoy es lo del fin de semana: no se reserva nada
    const sab = getWeekendPlan(db, new Date(2026, 9, 17, 9, 0), ADVICE)
    expect(sab.accounts.flatMap((a) => a.slots).some((s) => s.clip)).toBe(true)
  })

  it('no propone para el domingo un clip de una campaña que acaba el sábado', () => {
    setCampaignStatus(db, { campaignId: 'corta', endsAt: '2026-10-17' })
    const p = getWeekendPlan(db, VIERNES, ADVICE)
    const todos = p.accounts.flatMap((a) => a.slots).filter((s) => s.clip?.clipId === 'clp_c1')
    // nunca el domingo; el sábado solo si «Hoy» no lo ha dado ya para el viernes
    expect(todos.filter((s) => s.day === '2026-10-18')).toEqual([])
    for (const s of todos) expect(s.daysLeft).toBe(1)
    expect(p.accounts.flatMap((a) => a.options).filter((o) => o.clip.clipId === 'clp_c1').every((o) => o.endsAt === '2026-10-17')).toBe(true)
  })

  it('lo programado ocupa su hueco, no se vuelve a proponer y no bloquea el plan de hoy', () => {
    savePublication(db, { clipId: 'clp_p1', platform: 'youtube', account: '@clipsparatodos', publishedAt: new Date(2026, 9, 17, 12, 30).toISOString() })
    const p = getWeekendPlan(db, VIERNES, ADVICE)
    const bueno = p.accounts.find((a) => a.account.name === '@clipsparatodos')!
    expect(bueno.slots[0].scheduled).toMatchObject({ clipId: 'clp_p1' })
    expect(p.accounts.flatMap((a) => a.slots).filter((s) => s.clip?.clipId === 'clp_p1')).toEqual([])
    // el viernes, ese canal sigue pudiendo subir: lo programado para mañana no cuenta como «última subida»
    const hoy = getPlan(db, VIERNES, ADVICE).accounts.find((a) => a.account.name === '@clipsparatodos')!
    expect(hoy.waiting).toBe(false)
    expect(hoy.suggestions.length).toBeGreaterThan(0)
  })

  it('un canal en reposo no tiene huecos', () => {
    const p = getWeekendPlan(db, VIERNES, { ...ADVICE, channels: new Map([['youtube:@democlips', consejo({ hold: true })]]) })
    expect(p.accounts.find((a) => a.account.name === '@democlips')!.slots).toEqual([])
  })
})

describe('tope diario y elegir otro clip', () => {
  it('«maximo_al_dia» por plataforma (o por canal) baja los huecos, en el fin de semana y en «Hoy»', async () => {
    const { parseChannelsAdvice } = await import('../src/core/advice')
    const leido = parseChannelsAdvice({ por_plataforma: { youtube: { maximo_al_dia: 1 } }, canales: { 'youtube:@clipsparatodos': { horas_minimas: 6, franja: [12, 22] } } })
    const conTope: Advice = { ...ADVICE, ...leido, channels: leido.channels }
    const fila = getWeekendPlan(db, VIERNES, conTope).accounts.find((a) => a.account.name === '@clipsparatodos')!
    expect(fila.slots.filter((s) => s.day === '2026-10-17')).toHaveLength(1)
    expect(fila.account.dailyLimit).toBe(1)
    // en «Hoy», igual; lo que puso el usuario en «Canales…» no cambia
    const hoy = getPlan(db, new Date(2026, 9, 16, 13, 0), conTope)
    expect(hoy.accounts.find((a) => a.account.name === '@clipsparatodos')!.account.dailyLimit).toBe(1)
    expect(hoy.allAccounts.find((a) => a.name === '@clipsparatodos')!.dailyLimit).toBe(2)
    // el del canal manda sobre el de la plataforma
    const propio = parseChannelsAdvice({ por_plataforma: { youtube: { maximo_al_dia: 1 } }, canales: { 'youtube:@clipsparatodos': { maximo_al_dia: 2 } } })
    expect(getWeekendPlan(db, VIERNES, { ...ADVICE, ...propio }).accounts.find((a) => a.account.name === '@clipsparatodos')!.slots.filter((s) => s.day === '2026-10-17').length).toBeGreaterThanOrEqual(1)
  })

  it('cada canal trae todo lo que puede subir, para elegir otro en un hueco (con el último día de su campaña)', () => {
    setCampaignStatus(db, { campaignId: 'corta', endsAt: '2026-10-17' })
    const fila = getWeekendPlan(db, VIERNES, ADVICE).accounts.find((a) => a.account.name === '@democlips')!
    const hoy = new Set(getPlan(db, VIERNES, ADVICE).accounts.flatMap((a) => a.suggestions.map((s) => s.clip.clipId)))
    expect(fila.options.map((o) => o.clip.clipId)).toEqual(['clp_c1', 'clp_p1', 'clp_p2', 'clp_p3', 'clp_p4', 'clp_p5', 'clp_p6'].filter((c) => !hoy.has(c)))
    for (const o of fila.options) expect(o.endsAt).toBe(o.clip.campaignId === 'corta' ? '2026-10-17' : null)
  })
})

it('el sábado por la tarde no propone huecos de hoy a horas que ya han pasado', () => {
  const sabTarde = new Date(2026, 9, 17, 16, 0)
  const p = getWeekendPlan(db, sabTarde, ADVICE)
  const hoy = p.accounts.flatMap((a) => a.slots).filter((s) => s.day === '2026-10-17' && !s.scheduled)
  expect(hoy.every((s) => new Date(s.at).getTime() > sabTarde.getTime())).toBe(true)
  // el canal de 12:30–18:30 aún tiene el de las 18:30; el de franja 12–15 ya no tiene nada hoy
  expect(p.accounts.find((a) => a.account.name === '@clipsparatodos')!.slots.filter((s) => s.day === '2026-10-17').map((s) => hm(s.at))).toEqual(['18:30'])
  expect(p.accounts.find((a) => a.account.name === '@democlips')!.slots.filter((s) => s.day === '2026-10-17')).toEqual([])
})
