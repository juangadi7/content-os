/** Vyro: leer la lista pública de campañas, detectar las nuevas y reflejar cierres y plazos. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCampaignStatus } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getCampaign } from '../src/core/queries'
import {
  acknowledgeVyro, fetchVyroCampaigns, getVyro, linkVyroCampaign, matchLocalCampaign, parseVyroCampaigns, recordVyroError, syncVyro, vyroNewCount,
  VyroError, type VyroCampaign
} from '../src/core/vyro'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

const PAGINA = fs.readFileSync(path.join(__dirname, 'fixtures', 'vyro-campaigns.html'), 'utf8')
const HOY = new Date(2026, 9, 8, 19, 0)
const at = () => HOY.toISOString()

let base: string
let root: string
let db: DB

const vy = (n: number, extra: Partial<VyroCampaign> = {}): VyroCampaign => ({
  vyroId: `id${n}`, slug: `slug-${n}`, brand: `Marca${n}`, name: `Campaña número ${n}`, payRate: 1.5, budgetTotal: 1000, budgetRemaining: 800, minViews: 5000,
  minLength: 30, platforms: ['youtube'], languages: ['en'], hashtags: ['#x'], disclosure: ['#ad'], materialLinks: [], status: 'active', locked: false,
  startsAt: '2026-10-08T10:00:00.000Z', endsAt: '2026-10-20T13:00:00.000Z', createdAt: '2026-10-07T10:00:00.000Z', ...extra
})

beforeEach(() => {
  base = tmpDir('cos_vyro_')
  root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  new CampaignFixture(root, 'DLTM', 'dltm', "Don't Lie To Me - iHeart podcast").addClip({ n: 1, clipId: 'clp_d1' })
  new CampaignFixture(root, 'ST1', 'st1', 'Shark Tank - S18E01 (Episode 1)').addClip({ n: 1, clipId: 'clp_s1' })
  new CampaignFixture(root, 'ST2', 'st2', 'Shark Tank - S18E02 (Episode 2)').addClip({ n: 1, clipId: 'clp_s2' })
  new CampaignFixture(root, 'MB', 'mb', 'MrBeast - Eat Everything In A Grocery Store').addClip({ n: 1, clipId: 'clp_m1' })
  new CampaignFixture(root, 'KL', 'kl', 'Kevin Langue - 5 Guys Face Their Crush').addClip({ n: 1, clipId: 'clp_k1' })
  syncLibraries(db, { roots: [root] })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('página pública de Vyro', () => {
  it('lee las campañas de la página real guardada', () => {
    const cs = parseVyroCampaigns(PAGINA)
    expect(cs).toHaveLength(7)
    expect(cs.find((c) => c.slug === 'dont-lie-to-me-GTxkrmk_')).toEqual({
      vyroId: '6ac554680e4e326345b65fdd', slug: 'dont-lie-to-me-GTxkrmk_', brand: 'iHeartPodcasts', name: "Don't Lie To Me", payRate: 1.5,
      budgetTotal: 4375, budgetRemaining: 4375, minViews: 5000, minLength: 30, platforms: ['youtube', 'tiktok', 'instagram'], languages: ['en'],
      hashtags: ['#DontLieToMe'], disclosure: ['#ad'], materialLinks: ['https://f.io/ZXenIDI5'], status: 'active', locked: false,
      startsAt: '2026-10-08T01:49:28.757Z', endsAt: '2026-10-20T13:00:00.000Z', createdAt: '2026-10-06T20:04:56.194Z'
    })
    expect(cs.filter((c) => c.locked).map((c) => c.brand).sort()).toEqual(['MrBeast', 'Shark Tank'])
    expect(cs.every((c) => c.payRate != null && c.name && c.brand)).toBe(true)
  })

  it('si Vyro cambia su web, da un error claro en vez de una lista vacía', () => {
    expect(() => parseVyroCampaigns('<html><body>Mantenimiento</body></html>')).toThrow(VyroError)
    expect(() => parseVyroCampaigns(PAGINA.replace(/"slug"/g, '"otra_cosa"').replace(/\\"slug\\"/g, '\\"otra_cosa\\"'))).toThrow(/No reconozco/)
  })

  it('pide solo la página pública, sin credenciales, y traduce los fallos de red', async () => {
    const vistas: { url: string; headers: Record<string, string> }[] = []
    const cs = await fetchVyroCampaigns(async (url, init) => {
      vistas.push({ url, headers: init.headers })
      return { ok: true, status: 200, text: async () => PAGINA }
    })
    expect(cs).toHaveLength(7)
    expect(vistas).toHaveLength(1)
    expect(vistas[0].url).toBe('https://vyro.com/campaigns')
    expect(Object.keys(vistas[0].headers).map((h) => h.toLowerCase()).sort()).toEqual(['accept', 'user-agent'])
    await expect(fetchVyroCampaigns(async () => ({ ok: false, status: 503, text: async () => '' }))).rejects.toThrow(/503/)
    await expect(fetchVyroCampaigns(async () => { throw new Error('sin red') })).rejects.toThrow(/sin red/)
  })
})

describe('campañas de Vyro en la base', () => {
  it('empareja cada campaña real con la tuya, sin confundir los dos episodios de Shark Tank', () => {
    const locales = getVyro(db).localOptions
    const por = Object.fromEntries(parseVyroCampaigns(PAGINA).map((c) => [`${c.brand}|${c.name}`, matchLocalCampaign(c, locales)]))
    expect(por).toEqual({
      'Valorant|Microdrama series - Episode 1': null,
      "iHeartPodcasts|Don't Lie To Me": 'dltm',
      'Shark Tank|Season 18, Episode 2: Guest Sharks - Erin & Sara Foster': 'st2',
      'Shark Tank|Season 18, Episode 1: Guest Sharks - Team Beast': 'st1',
      'Ketone-IQ|Cinematic edits': null,
      'Kevin Langue|5 Guys Face Their Crush': 'kl',
      'MrBeast|Eat Everything In A Grocery Store, Win $1,000,000': 'mb'
    })
  })

  it('la primera lectura no avisa de nada, enlaza, pone plazos y cierra las bloqueadas', () => {
    const r = syncVyro(db, parseVyroCampaigns(PAGINA), at)
    expect(r.fresh).toEqual([])
    expect(r.closedLocal.sort()).toEqual(['mb', 'st1'])
    expect(r.datedLocal).toContain('dltm')
    expect(getCampaign(db, 'dltm', HOY)).toMatchObject({ closed: false, endsAt: '2026-10-20', daysLeft: 13 })
    expect(getCampaign(db, 'st1', HOY)).toMatchObject({ closed: true, closedManually: true })
    const v = getVyro(db, HOY)
    expect(v).toMatchObject({ newCount: 0, lastError: null, lastCheckAt: at() })
    expect(v.campaigns.filter((c) => c.open).map((c) => [c.brand, c.campaignId, c.daysLeft])).toEqual([
      ['Valorant', null, 17], ['iHeartPodcasts', 'dltm', 13], ['Shark Tank', 'st2', expect.any(Number)], ['Ketone-IQ', null, expect.any(Number)], ['Kevin Langue', 'kl', expect.any(Number)]
    ])
    expect(v.campaigns.filter((c) => !c.open).map((c) => c.campaignId).sort()).toEqual(['mb', 'st1'])
    expect(v.campaigns[0].url).toBe('https://vyro.com/campaigns/valorant-champions-shanghai-opening-day-2qB4koW6')
  })

  it('una campaña que aparece después es nueva hasta que la ves', () => {
    syncVyro(db, [vy(1)], at)
    const r = syncVyro(db, [vy(1), vy(2)], at)
    expect(r.fresh.map((c) => c.vyroId)).toEqual(['id2'])
    expect(vyroNewCount(db)).toBe(1)
    expect(getVyro(db, HOY).campaigns.map((c) => [c.vyroId, c.isNew])).toEqual([['id2', true], ['id1', false]])
    expect(syncVyro(db, [vy(1), vy(2)], at).fresh).toEqual([]) // no vuelve a avisar
    acknowledgeVyro(db, at)
    expect(vyroNewCount(db)).toBe(0)
  })

  it('no pisa una fecha de fin puesta a mano y respeta que reabras una campaña bloqueada', () => {
    setCampaignStatus(db, { campaignId: 'dltm', endsAt: '2026-10-15' })
    const dltm = vy(1, { brand: 'iHeartPodcasts', name: "Don't Lie To Me" })
    expect(syncVyro(db, [dltm], at)).toMatchObject({ datedLocal: [], closedLocal: [] })
    expect(getCampaign(db, 'dltm', HOY)!.endsAt).toBe('2026-10-15')
    // Vyro la bloquea: se cierra una vez
    expect(syncVyro(db, [{ ...dltm, locked: true }], at).closedLocal).toEqual(['dltm'])
    expect(getCampaign(db, 'dltm', HOY)!.closed).toBe(true)
    // la reabres a mano: las siguientes lecturas no la vuelven a cerrar
    setCampaignStatus(db, { campaignId: 'dltm', closed: false, endsAt: null })
    expect(syncVyro(db, [{ ...dltm, locked: true }], at).closedLocal).toEqual([])
    expect(getCampaign(db, 'dltm', HOY)!.closedManually).toBe(false)
  })

  it('si Vyro pausa una campaña y luego la reactiva, se reabre sola; un cierre a mano no se toca', () => {
    setCampaignStatus(db, { campaignId: 'dltm', endsAt: null })
    const dltm = vy(1, { brand: 'iHeartPodcasts', name: "Don't Lie To Me" })
    syncVyro(db, [dltm], at)
    // Vyro la pausa (Kevin Langue, 19-oct): la app la cierra
    expect(syncVyro(db, [{ ...dltm, status: 'paused' }], at).closedLocal).toEqual(['dltm'])
    expect(getCampaign(db, 'dltm', HOY)!.closedManually).toBe(true)
    // Vyro la vuelve a activar: se reabre
    expect(syncVyro(db, [dltm], at).reopenedLocal).toEqual(['dltm'])
    expect(getCampaign(db, 'dltm', HOY)!.closedManually).toBe(false)
    // otra pausa, pero esta vez la cierras tú a mano después de reabrirla: la reactivación no la reabre
    syncVyro(db, [{ ...dltm, status: 'paused' }], at)
    setCampaignStatus(db, { campaignId: 'dltm', closed: false })
    setCampaignStatus(db, { campaignId: 'dltm', closed: true })
    expect(syncVyro(db, [dltm], at).reopenedLocal ?? []).toEqual([])
    expect(getCampaign(db, 'dltm', HOY)!.closedManually).toBe(true)
  })

  it('una campaña que deja de salir en la lista se conserva como «ya no aparece», sin cerrar la tuya', () => {
    syncVyro(db, [vy(1, { brand: 'Kevin Langue', name: '5 Guys Face Their Crush' }), vy(2)], at)
    syncVyro(db, [vy(2)], at)
    const v = getVyro(db, HOY)
    expect(v.campaigns.map((c) => [c.vyroId, c.present, c.open])).toEqual([['id2', true, true], ['id1', false, false]])
    expect(getCampaign(db, 'kl', HOY)!.closed).toBe(false)
  })

  it('enlazar a mano: cambia, quita y no se vuelve a adivinar lo que rechazaste', () => {
    syncVyro(db, [vy(1, { brand: 'iHeartPodcasts', name: "Don't Lie To Me" }), vy(2, { locked: true })], at)
    expect(getVyro(db, HOY).campaigns.map((c) => [c.vyroId, c.campaignId, c.linkState])).toEqual([['id1', 'dltm', 'auto'], ['id2', null, 'none']])
    linkVyroCampaign(db, 'id2', 'kl', at)
    expect(getCampaign(db, 'kl', HOY)).toMatchObject({ closed: true, endsAt: '2026-10-20' }) // estaba bloqueada al enlazarla
    linkVyroCampaign(db, 'id2', 'dltm', at) // una local solo puede estar en una de Vyro
    expect(getVyro(db, HOY).campaigns.map((c) => [c.vyroId, c.campaignId, c.linkState]).sort()).toEqual([['id1', null, 'none'], ['id2', 'dltm', 'manual']])
    linkVyroCampaign(db, 'id2', null)
    syncVyro(db, [vy(2, { brand: 'iHeartPodcasts', name: "Don't Lie To Me" })], at)
    expect(getVyro(db, HOY).campaigns.find((c) => c.vyroId === 'id2')).toMatchObject({ campaignId: null, linkState: 'rejected' })
    expect(() => linkVyroCampaign(db, 'nada', 'kl')).toThrow(/no existe/)
    expect(() => linkVyroCampaign(db, 'id2', 'nada')).toThrow(/no existe/)
  })

  it('un fallo de lectura se apunta y no borra lo que ya había; nada se escribe en CAMPAIGNS', () => {
    const antes = fingerprint(root)
    syncVyro(db, parseVyroCampaigns(PAGINA), at)
    recordVyroError(db, 'Vyro respondió con un error (503).', at)
    const v = getVyro(db, HOY)
    expect(v.lastError).toMatch(/503/)
    expect(v.campaigns).toHaveLength(7)
    syncVyro(db, parseVyroCampaigns(PAGINA), at)
    expect(getVyro(db, HOY).lastError).toBeNull()
    expect(fingerprint(root)).toEqual(antes)
  })
})

it('dos campañas locales parecidas: enlaza la que tiene exactamente el mismo nombre; si ninguna, no se arriesga', async () => {
  const { matchLocalCampaign } = await import('../src/core/vyro')
  const locales = [{ campaignId: 'vieja', name: "Don't Lie To Me - iHeart podcast" }, { campaignId: 'nueva', name: "iHeartPodcasts - Don't Lie To Me Podcast" }]
  expect(matchLocalCampaign({ brand: '', name: "Don't Lie To Me - iHeart podcast" }, locales)).toBe('vieja')
  expect(matchLocalCampaign({ brand: 'iHeartPodcasts', name: "Don't Lie To Me Podcast" }, locales)).toBe('nueva')
})
