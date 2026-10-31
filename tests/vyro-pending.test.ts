/** Recordatorio de Vyro: lo ya público que falta enviar, también lo programado en cuanto llega su hora. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setCampaignStatus } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { listVyroPending, setVyroSent } from '../src/core/vyro-pending'
import { CampaignFixture, tmpDir } from './fixtures/builder'

const AHORA = new Date(2026, 9, 16, 13, 0)
let base: string
let db: DB
const pub = (clip: string, platform: string, account: string, cuando: Date, url: string | null = null) =>
  Number(db.prepare("INSERT INTO publications (clip_id, platform, account, status, url, published_at, created_at, updated_at) VALUES (?, ?, ?, 'published', ?, ?, 't', 't')")
    .run(clip, platform, account, url, cuando.toISOString()).lastInsertRowid)

beforeEach(() => {
  base = tmpDir('cos_vyropend_')
  const root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const c = new CampaignFixture(root, 'DRAMA', 'drama', 'Total Drama')
  for (let n = 1; n <= 3; n++) c.addClip({ n, clipId: `clp_${n}`, score: 90 - n, content: `clip ${n}` })
  syncLibraries(db, { roots: [root] })
  setCampaignStatus(db, { campaignId: 'drama', endsAt: '2026-10-29' })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

it('lo publicado entra; lo programado, solo cuando llega su hora; marcar enviado lo quita', () => {
  const ya = pub('clp_1', 'youtube', '@Shortsdemo', new Date(2026, 9, 16, 12, 30), 'https://youtu.be/aaaaaaaaaaa')
  pub('clp_2', 'youtube', '@Shortsdemo', new Date(2026, 9, 16, 15, 0))
  expect(listVyroPending(db, AHORA).map((p) => [p.clipId, p.account, p.url, p.campaignName, p.endsAt]))
    .toEqual([['clp_1', '@Shortsdemo', 'https://youtu.be/aaaaaaaaaaa', 'Total Drama', '2026-10-29']])
  // a las 15:01 ya ha salido el programado
  expect(listVyroPending(db, new Date(2026, 9, 16, 15, 1)).map((p) => p.clipId)).toEqual(['clp_1', 'clp_2'])
  setVyroSent(db, ya, true, AHORA)
  expect(listVyroPending(db, new Date(2026, 9, 16, 15, 1)).map((p) => p.clipId)).toEqual(['clp_2'])
  setVyroSent(db, ya, false)
  expect(listVyroPending(db, new Date(2026, 9, 16, 15, 1)).map((p) => p.clipId)).toEqual(['clp_1', 'clp_2'])
  expect(() => setVyroSent(db, 999, true)).toThrow('no existe')
  expect(() => setVyroSent(db, 'x', true)).toThrow('no válida')
})

it('pasado el último día de la campaña ya no se pide; una campaña que no es de Vyro tampoco', () => {
  pub('clp_1', 'tiktok', '@democlipss', new Date(2026, 9, 16, 10, 0))
  expect(listVyroPending(db, new Date(2026, 9, 29, 20, 0))).toHaveLength(1)   // el último día aún vale
  expect(listVyroPending(db, new Date(2026, 9, 30, 9, 0))).toHaveLength(0)
  db.prepare("UPDATE campaigns SET platform = 'Whop'").run()
  expect(listVyroPending(db, AHORA)).toHaveLength(0)
})

it('«Ignorar» lo quita de la lista; y una campaña bloqueada en Vyro o cerrada a mano tampoco sale', async () => {
  const { setControlIgnored } = await import('../src/core/video-control')
  const a = pub('clp_1', 'youtube', '@democlips', new Date(2026, 9, 16, 10, 0), 'https://youtu.be/aaaaaaaaaaa')
  pub('clp_2', 'youtube', '@democlips', new Date(2026, 9, 16, 11, 0), 'https://youtu.be/bbbbbbbbbbb')
  expect(listVyroPending(db, AHORA)).toHaveLength(2)
  setControlIgnored(db, `p${a}`, true)
  expect(listVyroPending(db, AHORA).map((p) => p.clipId)).toEqual(['clp_2'])
  db.prepare(`INSERT INTO vyro_campaigns (vyro_id, slug, name, first_seen_at, last_seen_at, campaign_id, link_state, locked) VALUES ('v1', 's', 'n', 't', 't', 'drama', 'auto', 1)`).run()
  expect(listVyroPending(db, AHORA)).toEqual([])
  db.prepare('UPDATE vyro_campaigns SET locked = 0').run()
  db.prepare('UPDATE campaigns SET closed = 1').run()
  expect(listVyroPending(db, AHORA)).toEqual([])
})
