/** Recomendaciones del operador para el plan de «Hoy»: qué no proponer, cada cuánto y cuándo toca la siguiente subida. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clipNumber, loadAdvice, nextUploadAt, NO_ADVICE, parseCampaignAdvice, parseChannelsAdvice } from '../src/core/advice'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getPlan, saveAccount } from '../src/core/plan'
import { savePublication } from '../src/core/publications'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

let base: string
let root: string
let canales: string
let db: DB
const HOY = new Date(2026, 9, 13, 10, 0) // martes 13 de octubre de 2026, 10:00
const at = (dia: number, h: number, m = 0) => new Date(2026, 9, dia, h, m)
const consejo = () => loadAdvice(db, canales)
const reparto = (cuando = HOY) => Object.fromEntries(getPlan(db, cuando, consejo()).accounts.map((c) => [`${c.account.platform}:${c.account.name}`, c.suggestions.map((s) => s.clip.clipId)]))
const ponerPlan = (carpeta: string, plan: unknown) => {
  const f = path.join(root, carpeta, 'campaign.json')
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), plan }))
}

beforeEach(() => {
  base = tmpDir('cos_advice_')
  root = path.join(base, 'CAMPAIGNS')
  canales = path.join(base, 'PLAN', 'canales.json')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const banco = new CampaignFixture(root, 'BANCO', 'banco', 'Banco sin editar')
  ;[99, 98].forEach((score, i) => banco.addClip({ n: i + 1, clipId: `clp_b${i + 1}`, score }))
  const pod = new CampaignFixture(root, 'PODCAST', 'podcast', 'Podcast')
  ;[90, 85, 80, 75].forEach((score, i) => pod.addClip({ n: i + 1, clipId: `clp_p${i + 1}`, score }))
  syncLibraries(db, { roots: [root] })
  saveAccount(db, { platform: 'youtube', name: '@yt', dailyLimit: 1 })
  saveAccount(db, { platform: 'tiktok', name: '@tk', dailyLimit: 1 })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('leer las recomendaciones', () => {
  it('sin archivos no hay recomendaciones y el plan es el de siempre', () => {
    const a = consejo()
    expect([a.campaigns.size, a.channels.size, a.defaults, a.errors]).toEqual([0, 0, NO_ADVICE.defaults, []])
    expect(reparto()).toEqual({ 'youtube:@yt': ['clp_b1'], 'tiktok:@tk': ['clp_b1'] })
    const p = getPlan(db, HOY, a)
    expect(p).toMatchObject({ skipped: [], adviceUpdatedAt: null, adviceErrors: [] })
    expect(p.accounts[0]).toMatchObject({ note: null, hold: false, waiting: false, nextAt: null, upNext: null })
    expect(getPlan(db, HOY)).toEqual(p) // sin pasar recomendaciones, lo mismo
  })

  it('entiende el plan de una campaña e ignora lo que no entiende', () => {
    expect(parseCampaignAdvice({
      no_subir_a: [{ plataforma: 'youtube', motivo: ' repetido ' }, { plataforma: 'facebook', motivo: 'x' }, 'basura'],
      clips_no_subir: [{ plataforma: 'youtube', clips: [28, '29', 0, 'x'], motivo: 'bloqueados' }, { plataforma: 'tiktok', clips: [] }]
    })).toEqual({ avoidPlatforms: [{ platform: 'youtube', reason: 'repetido' }], avoidClips: [{ platform: 'youtube', clips: [28, 29], reason: 'bloqueados' }] })
    expect(parseCampaignAdvice(null)).toEqual({ avoidPlatforms: [], avoidClips: [] })
    expect([clipNumber('028_titulo.mp4'), clipNumber('5-x.mp4'), clipNumber('titulo.mp4'), clipNumber(null)]).toEqual([28, 5, null, null])
  })

  it('entiende el archivo de canales: valores por defecto, por canal y sin distinguir mayúsculas', () => {
    const a = parseChannelsAdvice({ actualizado: '2026-10-13', por_defecto: { horas_minimas: 20, franja: [12, 15] },
      canales: { 'youtube:@YT': { nota: ' canal nuevo ' }, 'tiktok:@tk': { horas_minimas: 4, franja: null, en_reposo: true }, 'facebook:x': {}, sinplataforma: {} } })
    expect(a.updatedAt).toBe('2026-10-13')
    expect(a.defaults).toEqual({ minHours: 20, window: [12, 15], note: null, hold: false })
    expect([...a.channels]).toEqual([
      ['youtube:@yt', { minHours: 20, window: [12, 15], note: 'canal nuevo', hold: false }],
      ['tiktok:@tk', { minHours: 4, window: null, note: null, hold: true }]
    ])
  })

  it('un archivo de canales roto se avisa y no rompe el plan', () => {
    fs.mkdirSync(path.dirname(canales), { recursive: true })
    fs.writeFileSync(canales, '{ esto no es json')
    const a = consejo()
    expect(a.errors).toHaveLength(1)
    expect(getPlan(db, HOY, a).adviceErrors[0]).toMatch(/canales\.json/)
    expect(reparto()['youtube:@yt']).toEqual(['clp_b1'])
  })
})

describe('el plan sigue las recomendaciones', () => {
  it('no propone en YouTube una campaña marcada, pero sí en TikTok, y dice por qué', () => {
    ponerPlan('BANCO', { no_subir_a: [{ plataforma: 'youtube', motivo: 'Vídeos sin editar.' }] })
    expect(reparto()).toEqual({ 'youtube:@yt': ['clp_p1'], 'tiktok:@tk': ['clp_b1'] })
    expect(getPlan(db, HOY, consejo()).skipped).toEqual([{ platform: 'youtube', campaignId: 'banco', campaignName: 'Banco sin editar', clips: 2, whole: true, reason: 'Vídeos sin editar.' }])
    // los clips excluidos tampoco cuentan como pendientes de esa plataforma
    expect(getPlan(db, HOY, consejo()).platforms.find((p) => p.platform === 'youtube')!.pending).toBe(4)
  })

  it('salta solo los clips señalados, por su número', () => {
    ponerPlan('BANCO', { no_subir_a: [{ plataforma: 'youtube', motivo: 'x' }] })
    ponerPlan('PODCAST', { clips_no_subir: [{ plataforma: 'youtube', clips: [1, 2], motivo: 'Bloqueados por derechos.' }] })
    expect(reparto()['youtube:@yt']).toEqual(['clp_p3'])
    expect(getPlan(db, HOY, consejo()).skipped.find((s) => s.campaignId === 'podcast')).toMatchObject({ clips: 2, whole: false, reason: 'Bloqueados por derechos.' })
  })

  it('respeta las horas mínimas: tras subir de madrugada no propone hasta el día siguiente en la franja', () => {
    fs.mkdirSync(path.dirname(canales), { recursive: true })
    fs.writeFileSync(canales, JSON.stringify({ por_defecto: { horas_minimas: 20, franja: [12, 15] }, canales: { 'youtube:@yt': { nota: 'Canal nuevo.' } } }))
    savePublication(db, { clipId: 'clp_b1', platform: 'youtube', account: '@yt', publishedAt: at(13, 1, 19).toISOString() })
    // martes 13 a las 12:00: cupo del día gastado (se subió a la 01:19) -> mañana en la franja
    let yt = getPlan(db, at(13, 12), consejo()).accounts.find((a) => a.account.name === '@yt')!
    expect(yt).toMatchObject({ suggestions: [], note: 'Canal nuevo.', window: [12, 15], waiting: true })
    expect(new Date(yt.nextAt!)).toEqual(at(14, 12))
    expect(yt.upNext!.clip.clipId).toBe('clp_p1') // y enseña cuál será (de otra campaña: lo último subido fue de Banco)
    // miércoles 14 a las 09:00: ya han pasado 20 h y hay cupo -> se puede, aunque conviene esperar a la franja
    yt = getPlan(db, at(14, 9), consejo()).accounts.find((a) => a.account.name === '@yt')!
    expect(yt).toMatchObject({ waiting: false, nextAt: null })
    expect(yt.suggestions.map((s) => s.clip.clipId)).toEqual(['clp_p1']) // el que había anunciado como siguiente
    // el canal sin subidas no espera a nada
    expect(getPlan(db, at(13, 12), consejo()).accounts.find((a) => a.account.name === '@tk')).toMatchObject({ waiting: false, nextAt: null })
    // lo que espera no cuenta en «por subir hoy»
    expect(getPlan(db, at(13, 12), consejo()).left).toBe(1)
  })

  it('un canal en reposo no recibe propuestas', () => {
    fs.mkdirSync(path.dirname(canales), { recursive: true })
    fs.writeFileSync(canales, JSON.stringify({ canales: { 'youtube:@yt': { en_reposo: true, nota: 'Descansando.' } } }))
    expect(getPlan(db, HOY, consejo()).accounts.find((a) => a.account.name === '@yt')).toMatchObject({ hold: true, suggestions: [], upNext: null, nextAt: null, note: 'Descansando.' })
    expect(reparto()['tiktok:@tk']).toEqual(['clp_b1'])
  })

  it('cuándo toca la siguiente subida', () => {
    const c = { minHours: 20, window: [12, 15] as [number, number], note: null, hold: false }
    const libre = { minHours: null, window: null, note: null, hold: false }
    expect(nextUploadAt(at(13, 13), { quotaDone: false, lastUploadAt: null, advice: c })).toBeNull() // nunca se ha subido: ya
    expect(nextUploadAt(at(13, 13), { quotaDone: true, lastUploadAt: at(13, 12, 30).toISOString(), advice: c })).toEqual(at(14, 12)) // subido hoy en la franja
    expect(nextUploadAt(at(13, 2), { quotaDone: true, lastUploadAt: at(13, 1, 19).toISOString(), advice: c })).toEqual(at(14, 12)) // subido de madrugada
    expect(nextUploadAt(at(13, 10), { quotaDone: false, lastUploadAt: at(12, 22).toISOString(), advice: c })).toEqual(at(14, 12)) // 20 h después serían las 18:00, fuera de la franja: se pasa al día siguiente
    expect(nextUploadAt(at(13, 10), { quotaDone: false, lastUploadAt: at(12, 22).toISOString(), advice: { ...c, window: [12, 24] } })).toEqual(at(13, 18))
    expect(nextUploadAt(at(13, 13), { quotaDone: true, lastUploadAt: at(13, 9).toISOString(), advice: libre })).toEqual(at(14, 0)) // sin consejo: mañana
  })

  it('leer las recomendaciones no escribe nada', () => {
    ponerPlan('BANCO', { no_subir_a: [{ plataforma: 'youtube', motivo: 'x' }] })
    const antes = fingerprint(root)
    getPlan(db, HOY, consejo())
    expect(fingerprint(root)).toEqual(antes)
  })
})
