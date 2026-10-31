/** Limpieza de campañas terminadas: a la Papelera una semana después de acabar, y solo su carpeta. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCampaignStatus } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { purgeCandidates, purgeEndedCampaigns, purgeOn, trashCampaign } from '../src/core/purge'
import { getCampaign } from '../src/core/queries'
import { CampaignFixture, tmpDir } from './fixtures/builder'

let base: string
let root: string
let papelera: string
let db: DB
const HOY = new Date(2026, 9, 15, 12, 0)
const aPapelera = async (carpeta: string) => {
  fs.renameSync(carpeta, path.join(papelera, path.basename(carpeta)))
}
const campana = (folder: string, id: string) => {
  new CampaignFixture(root, folder, id).addClip({ n: 1, clipId: `${id}_c1`, score: 80 })
}

beforeEach(() => {
  base = tmpDir('cos_purge_')
  root = path.join(base, 'CAMPAIGNS')
  papelera = path.join(base, 'Papelera')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(papelera)
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  campana('A_TERMINADA', 'camp_a')
  campana('B_RECIENTE', 'camp_b')
  campana('C_SIN_FIN', 'camp_c')
  campana('D_CERRADA', 'camp_d')
  syncLibraries(db, { roots: [root] })
  setCampaignStatus(db, { campaignId: 'camp_a', endsAt: '2026-10-07' })   // acabó el 8: a la Papelera el 15
  setCampaignStatus(db, { campaignId: 'camp_b', endsAt: '2026-10-08' })   // acabó el 9: el 16
  setCampaignStatus(db, { campaignId: 'camp_d', closed: true }, () => new Date(2026, 9, 5, 10).toISOString())  // cerrada a mano el 5: el 12
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('cuándo va a la Papelera', () => {
  it('una semana después de acabar: el día siguiente al último día de plazo, o el día en que se cerró', () => {
    expect(purgeOn('2026-10-07', null)).toBe('2026-10-15')
    expect(purgeOn(null, new Date(2026, 9, 5, 23, 30).toISOString())).toBe('2026-10-12')
    // lo que llegue antes
    expect(purgeOn('2026-10-20', new Date(2026, 9, 5, 9).toISOString())).toBe('2026-10-12')
    expect(purgeOn(null, null)).toBeNull()
  })

  it('la ficha de la campaña lo dice', () => {
    expect(getCampaign(db, 'camp_a', HOY)).toMatchObject({ purgeOn: '2026-10-15', purgedAt: null })
    expect(getCampaign(db, 'camp_c', HOY)).toMatchObject({ purgeOn: null })
  })

  it('solo las que ya les toca; nunca una sin fin ni una que se está generando', () => {
    expect(purgeCandidates(db, [root], HOY).map((c) => c.campaignId).sort()).toEqual(['camp_a', 'camp_d'])
    db.prepare("UPDATE campaigns SET state = 'generating' WHERE campaign_id = 'camp_a'").run()
    expect(purgeCandidates(db, [root], HOY).map((c) => c.campaignId)).toEqual(['camp_d'])
  })

  it('solo carpetas que están justo dentro de la biblioteca y llevan su campaign.json', () => {
    expect(purgeCandidates(db, [path.join(base, 'otra')], HOY)).toEqual([])
    fs.rmSync(path.join(root, 'A_TERMINADA', 'campaign.json'))
    expect(purgeCandidates(db, [root], HOY).map((c) => c.campaignId)).toEqual(['camp_d'])
  })
})

describe('mandar a la Papelera', () => {
  it('mueve la carpeta entera, lo apunta y conserva lo que sabe la aplicación', async () => {
    db.prepare("INSERT INTO publications (clip_id, platform, account, status, published_at, created_at, updated_at) VALUES ('camp_a_c1', 'youtube', '@yo', 'published', 't', 't', 't')").run()
    const r = await purgeEndedCampaigns(db, [root], aPapelera, { now: HOY })
    expect(r.trashed.map((c) => c.campaignId).sort()).toEqual(['camp_a', 'camp_d'])
    expect(r.errors).toEqual([])
    expect(fs.readdirSync(papelera).sort()).toEqual(['A_TERMINADA', 'D_CERRADA'])
    expect(fs.readdirSync(root).sort()).toEqual(['B_RECIENTE', 'C_SIN_FIN'])
    expect(getCampaign(db, 'camp_a', HOY)?.purgedAt).toBe(HOY.toISOString())
    expect(db.prepare("SELECT COUNT(*) AS n FROM publications WHERE clip_id = 'camp_a_c1'").get()).toEqual({ n: 1 })
    // no se vuelve a intentar
    expect(purgeCandidates(db, [root], HOY)).toEqual([])
  })

  it('al día siguiente le toca a la siguiente', async () => {
    await purgeEndedCampaigns(db, [root], aPapelera, { now: HOY })
    const r = await purgeEndedCampaigns(db, [root], aPapelera, { now: new Date(2026, 9, 16, 9) })
    expect(r.trashed.map((c) => c.campaignId)).toEqual(['camp_b'])
  })

  it('si una carpeta no se puede mover, sigue con las demás y lo cuenta', async () => {
    const r = await purgeEndedCampaigns(db, [root], async (c) => {
      if (c.endsWith('A_TERMINADA')) throw new Error('en uso')
      await aPapelera(c)
    }, { now: HOY })
    expect(r.trashed.map((c) => c.campaignId)).toEqual(['camp_d'])
    expect(r.errors).toEqual([{ campaignId: 'camp_a', name: 'A_TERMINADA', error: 'en uso' }])
    expect(getCampaign(db, 'camp_a', HOY)?.purgedAt).toBeNull()
  })

  it('quita los accesos del escritorio que apuntan a ella, sin tocar los demás', async () => {
    const accesos = path.join(base, 'Escritorio', 'Campañas clips')
    fs.mkdirSync(accesos, { recursive: true })
    fs.symlinkSync(path.join(root, 'A_TERMINADA', 'CLIPS'), path.join(accesos, 'A'), 'junction')
    fs.symlinkSync(path.join(root, 'B_RECIENTE', 'CLIPS'), path.join(accesos, 'B'), 'junction')
    fs.mkdirSync(path.join(accesos, 'carpeta normal'))
    await purgeEndedCampaigns(db, [root], aPapelera, { now: HOY, linksDir: accesos })
    expect(fs.readdirSync(accesos).sort()).toEqual(['B', 'carpeta normal'])
    // lo que había dentro de la campaña se ha movido entero, no se ha borrado a través del enlace
    expect(fs.existsSync(path.join(papelera, 'A_TERMINADA', 'CLIPS'))).toBe(true)
    expect(fs.readdirSync(path.join(papelera, 'A_TERMINADA', 'CLIPS')).length).toBeGreaterThan(0)
  })
})

describe('mandar una campaña a la Papelera con el botón', () => {
  it('va ya, aunque siga activa: su carpeta a la Papelera, queda cerrada y marcada', async () => {
    await trashCampaign(db, [root], 'camp_c', aPapelera, { now: HOY })
    expect(fs.existsSync(path.join(root, 'C_SIN_FIN'))).toBe(false)
    expect(fs.existsSync(path.join(papelera, 'C_SIN_FIN', 'campaign.json'))).toBe(true)
    expect(getCampaign(db, 'camp_c', HOY)).toMatchObject({ closed: true, purgedAt: HOY.toISOString() })
    // las demás no se tocan
    expect(fs.readdirSync(root).sort()).toEqual(['A_TERMINADA', 'B_RECIENTE', 'D_CERRADA'])
  })

  it('no la manda dos veces, ni una que se está generando, ni una carpeta fuera de la biblioteca', async () => {
    await trashCampaign(db, [root], 'camp_c', aPapelera, { now: HOY })
    // la carpeta ya no está en la biblioteca: no hay nada que mandar
    await expect(trashCampaign(db, [root], 'camp_c', aPapelera)).rejects.toThrow('No encuentro la carpeta')
    db.prepare("UPDATE campaigns SET state = 'generating' WHERE campaign_id = 'camp_b'").run()
    await expect(trashCampaign(db, [root], 'camp_b', aPapelera)).rejects.toThrow('se está generando')
    await expect(trashCampaign(db, [path.join(base, 'OTRA')], 'camp_a', aPapelera)).rejects.toThrow('No encuentro la carpeta')
    await expect(trashCampaign(db, [root], 'no_existe', aPapelera)).rejects.toThrow('no existe')
    expect(fs.readdirSync(root).sort()).toEqual(['A_TERMINADA', 'B_RECIENTE', 'D_CERRADA'])
  })
})
