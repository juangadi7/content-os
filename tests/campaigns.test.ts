/** Cierre de campañas: dato propio de CONTENT OS que saca sus clips de «Pendientes». */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCampaignStatus } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { filterClips } from '../src/core/format'
import { syncLibraries } from '../src/core/importer'
import { savePublication } from '../src/core/publications'
import { counts, getCampaign, getClip, listCampaigns, listClips, today } from '../src/core/queries'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

let base: string
let root: string
let db: DB
const HOY = new Date(2026, 9, 8, 15, 0) // 8 de octubre de 2026, hora local
const sync = () => syncLibraries(db, { roots: [root] })

beforeEach(() => {
  base = tmpDir('cos_camp_')
  root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const a = new CampaignFixture(root, 'ABIERTA', 'abierta', 'Abierta')
  a.addClip({ n: 1, clipId: 'clp_a1', score: 90 })
  a.addClip({ n: 2, clipId: 'clp_a2', score: 80 })
  const v = new CampaignFixture(root, 'VIEJA', 'vieja', 'Vieja')
  v.addClip({ n: 1, clipId: 'clp_v1', score: 99 })
  v.addClip({ n: 2, clipId: 'clp_v2', score: 70 })
  v.writeReport({ date: '2026-12-31' }) // más reciente: iría primero si no estuviera cerrada
  sync()
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('cierre de campañas', () => {
  it('por defecto todas están abiertas y sin plazo', () => {
    expect(listCampaigns(db, HOY).map((c) => [c.campaignId, c.closed, c.endsAt, c.daysLeft])).toEqual([['vieja', false, null, null], ['abierta', false, null, null]])
    expect(counts(db, HOY).pending).toBe(4)
  })

  it('cerrar una campaña saca sus clips de pendientes y la manda al final', () => {
    setCampaignStatus(db, { campaignId: 'vieja', closed: true })
    expect(listCampaigns(db, HOY).map((c) => [c.campaignId, c.closed, c.closedManually])).toEqual([['abierta', false, false], ['vieja', true, true]])
    // «Todos los clips» solo cuenta los de campañas activas
    expect(counts(db, HOY)).toMatchObject({ clips: 2, pending: 2 })
    const todos = listClips(db, null, HOY)
    expect(todos.map((k) => [k.clipId, k.campaignClosed])).toEqual([['clp_v1', true], ['clp_a1', false], ['clp_a2', false], ['clp_v2', true]])
    expect(filterClips(todos, 'pending').map((k) => k.clipId)).toEqual(['clp_a1', 'clp_a2'])
    // los clips siguen ahí, con todos sus datos, y se pueden abrir y marcar como publicados
    expect(getClip(db, 'clp_v1')).toMatchObject({ score: 99, campaignClosed: true })
    savePublication(db, { clipId: 'clp_v1', platform: 'youtube' })
    expect(filterClips(listClips(db, null, HOY), 'published').map((k) => k.clipId)).toEqual(['clp_v1'])
  })

  it('reabrir la devuelve a su sitio', () => {
    setCampaignStatus(db, { campaignId: 'vieja', closed: true })
    setCampaignStatus(db, { campaignId: 'vieja', closed: false })
    expect(getCampaign(db, 'vieja', HOY)).toMatchObject({ closed: false, closedManually: false })
    expect(counts(db, HOY).pending).toBe(4)
  })

  it('con fecha de fin: cuenta los días y se cierra sola al pasar el último', () => {
    expect(today(HOY)).toBe('2026-10-08')
    setCampaignStatus(db, { campaignId: 'abierta', endsAt: '2026-10-19' })
    expect(getCampaign(db, 'abierta', HOY)).toMatchObject({ closed: false, endsAt: '2026-10-19', daysLeft: 12 })
    expect(getCampaign(db, 'abierta', new Date(2026, 9, 19, 23, 0))).toMatchObject({ closed: false, daysLeft: 1 })
    expect(getCampaign(db, 'abierta', new Date(2026, 9, 20, 0, 5))).toMatchObject({ closed: true, closedManually: false, daysLeft: null })
    expect(counts(db, new Date(2026, 9, 20, 0, 5)).pending).toBe(2)
    // quitar la fecha la deja abierta sin plazo
    setCampaignStatus(db, { campaignId: 'abierta', endsAt: null })
    expect(getCampaign(db, 'abierta', new Date(2026, 9, 20, 0, 5))).toMatchObject({ closed: false, endsAt: null, daysLeft: null })
  })

  it('sincronizar no toca el cierre ni la fecha', () => {
    setCampaignStatus(db, { campaignId: 'vieja', closed: true, endsAt: '2026-10-07' })
    fs.writeFileSync(path.join(root, 'VIEJA', 'campaign.json'), JSON.stringify({ name: 'Vieja renombrada', platform: 'Vyro', language: 'en' }))
    sync()
    expect(getCampaign(db, 'vieja', HOY)).toMatchObject({ displayName: 'Vieja renombrada', closed: true, closedManually: true, endsAt: '2026-10-07' })
  })

  it('las reglas para publicar se leen de campaign.json y llegan a la campaña y a cada clip', () => {
    expect(getCampaign(db, 'vieja', HOY)!.checklist).toEqual([])
    const cfg = path.join(root, 'VIEJA', 'campaign.json')
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), publish_checklist: ['Activa «colaboración de pago»', '  Sin hashtags  ', '', 7] }))
    sync()
    expect(getCampaign(db, 'vieja', HOY)!.checklist).toEqual(['Activa «colaboración de pago»', 'Sin hashtags'])
    expect(getClip(db, 'clp_v1')!.checklist).toEqual(['Activa «colaboración de pago»', 'Sin hashtags'])
    expect(getClip(db, 'clp_a1')!.checklist).toEqual([])
    // si se quitan del archivo, desaparecen
    fs.writeFileSync(cfg, JSON.stringify({ name: 'Vieja', platform: 'Vyro', language: 'en' }))
    sync()
    expect(getCampaign(db, 'vieja', HOY)!.checklist).toEqual([])
  })

  it('valida y no escribe nada en CAMPAIGNS', () => {
    const antes = fingerprint(root)
    expect(() => setCampaignStatus(db, { campaignId: 'no_existe', closed: true })).toThrow(/no existe/)
    expect(() => setCampaignStatus(db, { campaignId: 'vieja', endsAt: '08/10/2026' })).toThrow(/Fecha/)
    expect(() => setCampaignStatus(db, { campaignId: 'vieja', endsAt: '2026-13-45' })).toThrow(/Fecha/)
    setCampaignStatus(db, { campaignId: 'vieja', closed: true, endsAt: '2026-10-01' })
    expect(fingerprint(root)).toEqual(antes)
  })
})
