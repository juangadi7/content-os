/** Dónde está publicado cada clip: plataforma y canal, para verlo en las listas sin abrir el clip. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { listClips } from '../src/core/queries'
import { CampaignFixture, tmpDir } from './fixtures/builder'

let base: string
let db: DB
beforeEach(() => {
  base = tmpDir('cos_pubon_')
  const root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const c = new CampaignFixture(root, 'PODCAST', 'podcast', 'Podcast')
  c.addClip({ n: 1, clipId: 'clp_1', score: 90 })
  c.addClip({ n: 2, clipId: 'clp_2', score: 80, content: 'otro' })
  syncLibraries(db, { roots: [root] })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})
const pub = (clipId: string, platform: string, account: string) =>
  db.prepare("INSERT INTO publications (clip_id, platform, account, status, published_at, created_at, updated_at) VALUES (?, ?, ?, 'published', 't', 't', 't')").run(clipId, platform, account)

it('cada clip dice en qué canal de cada plataforma está, sin repetir y en orden', () => {
  pub('clp_1', 'tiktok', '@democlipss')
  pub('clp_1', 'youtube', '@democlips')
  pub('clp_1', 'youtube', '@democlips · abc123') // segundo vídeo del mismo canal: mismo canal
  pub('clp_2', 'youtube', '') // marcado a mano sin canal
  const k = Object.fromEntries(listClips(db, null).map((c) => [c.clipId, c.publishedOn]))
  expect(k.clp_1).toEqual([{ platform: 'youtube', account: '@democlips' }, { platform: 'tiktok', account: '@democlipss' }])
  expect(k.clp_2).toEqual([{ platform: 'youtube', account: '' }])
})

it('sin publicar, lista vacía', () => {
  expect(listClips(db, null).every((c) => c.publishedOn.length === 0)).toBe(true)
})
