/** Ganancia estimada y pedidos «hacer esta campaña». */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCampaignTerms } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { estimateEarning, formatMoney } from '../src/core/money'
import { attachMaterial, cancelOrder, createOrder, getOrder, hasWaitingOrders, updateOrder } from '../src/core/orders'
import { savePublication } from '../src/core/publications'
import { getCampaign } from '../src/core/queries'
import { getStats } from '../src/core/stats'
import { getVyro, linkVyroCampaign, syncVyro, type VyroCampaign } from '../src/core/vyro'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

let base: string
let root: string
let pedidos: string
let descargas: string
let db: DB

const vy = (n: number, extra: Partial<VyroCampaign> = {}): VyroCampaign => ({
  vyroId: `id${n}`, slug: `campaña nueva/${n}`, brand: `Marca${n}`, name: `Otra cosa distinta ${n}`, payRate: 1.5, budgetTotal: 1000, budgetRemaining: 800, minViews: 5000,
  minLength: 30, platforms: ['youtube', 'tiktok'], languages: ['en'], hashtags: ['#x'], disclosure: ['#ad'], materialLinks: ['https://f.io/abc'], status: 'active', locked: false,
  startsAt: '2026-10-08T10:00:00.000Z', endsAt: '2026-10-20T13:00:00.000Z', createdAt: '2026-10-07T10:00:00.000Z', ...extra
})
const medir = (clipId: string, views: number) => {
  const id = savePublication(db, { clipId, platform: 'youtube', account: '@c' })
  db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, origin) VALUES (?, ?, ?, 1, 0, 'prueba')").run(id, new Date().toISOString(), views)
}

beforeEach(() => {
  base = tmpDir('cos_money_')
  root = path.join(base, 'CAMPAIGNS')
  pedidos = path.join(base, 'PEDIDOS')
  descargas = path.join(base, 'Descargas')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(descargas)
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const p = new CampaignFixture(root, 'DLTM', 'dltm', "Don't Lie To Me - iHeart podcast")
  ;[1, 2, 3].forEach((n) => p.addClip({ n, clipId: `clp_d${n}` }))
  new CampaignFixture(root, 'OTRA', 'otra', 'Sin condiciones').addClip({ n: 1, clipId: 'clp_o1' })
  syncLibraries(db, { roots: [root] })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('ganancia estimada', () => {
  it('la cuenta: nada por debajo del mínimo, visitas × pago por encima, y tope por vídeo', () => {
    const t = { payRate: 1.5, minViews: 5000, maxPayout: 1000 }
    expect(estimateEarning(4200, t)).toEqual({ amount: 0, state: 'below_min', missingViews: 800 })
    expect(estimateEarning(5180, t)).toEqual({ amount: 7.77, state: 'earning', missingViews: null })
    expect(estimateEarning(2_000_000, t)).toEqual({ amount: 1000, state: 'capped', missingViews: null })
    expect(estimateEarning(null, t)).toMatchObject({ amount: null, state: 'unmeasured' })
    expect(estimateEarning(9000, { payRate: null, minViews: null, maxPayout: null })).toMatchObject({ amount: null, state: 'no_terms' })
    expect(estimateEarning(100, { payRate: 2, minViews: null, maxPayout: null }).amount).toBe(0.2)
    expect([formatMoney(7.77), formatMoney(1234.5), formatMoney(0), formatMoney(null)]).toEqual(['7,77 $', '1.234,50 $', '0,00 $', '—'])
  })

  it('las condiciones llegan de Vyro al enlazar, no pisan lo puesto a mano, y las estadísticas suman', () => {
    setCampaignTerms(db, { campaignId: 'dltm', payRate: null, minViews: 1000, maxPayout: 10 })
    syncVyro(db, [vy(1, { brand: 'iHeartPodcasts', name: "Don't Lie To Me" })])
    expect(getCampaign(db, 'dltm')).toMatchObject({ payRate: 1.5, minViews: 1000, maxPayout: 10 }) // el mínimo era tuyo: se respeta
    expect(getCampaign(db, 'otra')).toMatchObject({ payRate: null, minViews: null, maxPayout: null })
    medir('clp_d1', 4000) // 6,00 $
    medir('clp_d2', 900) // no llega a 1.000
    medir('clp_d3', 50_000) // 75 $ -> tope 10
    medir('clp_o1', 9000) // campaña sin condiciones
    const s = getStats(db)
    expect(s.totals).toMatchObject({ earning: 16, belowMin: 1 })
    expect(Object.fromEntries(s.videos.map((v) => [v.clipId, [v.earning, v.earningState, v.missingViews]]))).toEqual({
      clp_d1: [6, 'earning', null], clp_d2: [0, 'below_min', 100], clp_d3: [10, 'capped', null], clp_o1: [null, 'no_terms', null]
    })
    expect(s.campaigns.map((c) => [c.campaignId, c.earning, c.belowMin])).toEqual([['dltm', 16, 1], ['otra', null, 0]])
    expect(() => setCampaignTerms(db, { campaignId: 'dltm', payRate: -1, minViews: null, maxPayout: null })).toThrow(/no válida/)
    expect(() => setCampaignTerms(db, { campaignId: 'nada', payRate: 1, minViews: null, maxPayout: null })).toThrow(/no existe/)
  })
})

describe('pedidos «hacer esta campaña»', () => {
  const HACE_UN_RATO = () => new Date(Date.now() - 60_000).toISOString()
  const descargar = (nombre: string, contenido = 'video') => fs.writeFileSync(path.join(descargas, nombre), contenido)

  it('crea el pedido.json con las reglas de Vyro y tus notas, fuera de CAMPAIGNS', () => {
    const antes = fingerprint(root)
    syncVyro(db, [vy(1)])
    const p = createOrder(db, { vyroId: 'id1', notes: '  Caption: "Don\'t lie" + #ad. Máx 1000 $ por vídeo.  ' }, pedidos, HACE_UN_RATO)
    expect(p).toMatchObject({ status: 'waiting', files: [], folder: path.join(pedidos, 'campa-a-nueva-1'), notes: 'Caption: "Don\'t lie" + #ad. Máx 1000 $ por vídeo.' })
    expect(p.prompt).toBe(`Haz la campaña del pedido "${path.join(pedidos, 'campa-a-nueva-1', 'pedido.json')}"`)
    const j = JSON.parse(fs.readFileSync(p.file, 'utf8'))
    expect(j).toMatchObject({
      pedido_version: 1, estado: 'esperando_material', material: [], reglas_extra_del_usuario: p.notes,
      vyro: { marca: 'Marca1', pago_por_1000_visitas_usd: 1.5, visitas_minimas_por_clip: 5000, duracion_minima_s: 30, termina: '2026-10-20T13:00:00.000Z',
        hashtags_obligatorios: ['#x'], hashtags_publicidad: ['#ad'], plataformas: ['youtube', 'tiktok'], material_enlaces: ['https://f.io/abc'] }
    })
    expect(getVyro(db).campaigns[0].order).toMatchObject({ vyroId: 'id1', status: 'waiting' })
    expect(() => createOrder(db, { vyroId: 'id1' }, pedidos)).toThrow(/Ya hay un pedido/)
    expect(() => createOrder(db, { vyroId: 'nada' }, pedidos)).toThrow(/no existe/)
    expect(fingerprint(root)).toEqual(antes)
  })

  it('apunta solo las descargas terminadas y posteriores al pedido', async () => {
    syncVyro(db, [vy(1)])
    descargar('viejo.mp4') // ya estaba en Descargas antes del pedido
    await new Promise((r) => setTimeout(r, 60))
    createOrder(db, { vyroId: 'id1' }, pedidos)
    await new Promise((r) => setTimeout(r, 60))
    expect(attachMaterial(db, descargas)).toBe(false)
    descargar('Episodio 1.mp4', 'x'.repeat(500))
    descargar('Episodio 2.mov.crdownload', 'a medias')
    descargar('notas.pdf')
    descargar('lote.zip', 'zzz')
    descargar('vacio.mp4', '')
    expect(attachMaterial(db, descargas)).toBe(true)
    const p = getOrder(db, 'id1')!
    expect(p.files.map((f) => [f.name, f.kind, f.size, f.exists])).toEqual([['Episodio 1.mp4', 'video', 500, true], ['lote.zip', 'zip', 3, true]])
    expect(p.totalBytes).toBe(503)
    expect(attachMaterial(db, descargas)).toBe(false) // no repite
    // la descarga a medias termina
    fs.renameSync(path.join(descargas, 'Episodio 2.mov.crdownload'), path.join(descargas, 'Episodio 2.mov'))
    expect(attachMaterial(db, descargas)).toBe(true)
    expect(JSON.parse(fs.readFileSync(getOrder(db, 'id1')!.file, 'utf8')).material.map((m: { ruta: string }) => path.basename(m.ruta))).toEqual(['Episodio 1.mp4', 'lote.zip', 'Episodio 2.mov'])
  })

  it('quitar un archivo no lo borra ni lo vuelve a apuntar; «material completo» deja de mirar Descargas', () => {
    syncVyro(db, [vy(1)])
    createOrder(db, { vyroId: 'id1' }, pedidos, HACE_UN_RATO)
    descargar('bueno.mp4')
    descargar('ajeno.mp4')
    attachMaterial(db, descargas)
    updateOrder(db, 'id1', { removeFile: path.join(descargas, 'ajeno.mp4') })
    expect(fs.existsSync(path.join(descargas, 'ajeno.mp4'))).toBe(true)
    expect(attachMaterial(db, descargas)).toBe(false)
    expect(getOrder(db, 'id1')!.files.map((f) => f.name)).toEqual(['bueno.mp4'])
    const p = updateOrder(db, 'id1', { status: 'ready', notes: 'tope 500' })
    expect(p).toMatchObject({ status: 'ready', notes: 'tope 500' })
    expect(JSON.parse(fs.readFileSync(p.file, 'utf8'))).toMatchObject({ estado: 'material_completo', reglas_extra_del_usuario: 'tope 500' })
    expect(hasWaitingOrders(db)).toBe(false)
    descargar('tarde.mp4')
    expect(attachMaterial(db, descargas)).toBe(false)
    // un archivo que desaparece se marca, no rompe
    fs.rmSync(path.join(descargas, 'bueno.mp4'))
    expect(getOrder(db, 'id1')!.files[0]).toMatchObject({ exists: false, size: 0 })
  })

  it('anular borra solo el pedido.json; y al existir la campaña local, el pedido se da por cumplido', () => {
    syncVyro(db, [vy(1), vy(2)])
    const p1 = createOrder(db, { vyroId: 'id1' }, pedidos, HACE_UN_RATO)
    descargar('a.mp4')
    attachMaterial(db, descargas)
    cancelOrder(db, 'id1')
    expect(getOrder(db, 'id1')).toBeNull()
    expect(fs.existsSync(p1.folder)).toBe(false)
    expect(fs.existsSync(path.join(descargas, 'a.mp4'))).toBe(true)
    const p2 = createOrder(db, { vyroId: 'id2' }, pedidos, HACE_UN_RATO)
    linkVyroCampaign(db, 'id2', 'otra') // la campaña ya está hecha
    expect(getOrder(db, 'id2')).toBeNull()
    expect(fs.existsSync(p2.file)).toBe(true) // el pedido.json se conserva como registro
    expect(getVyro(db).campaigns.find((c) => c.vyroId === 'id2')).toMatchObject({ campaignId: 'otra', order: null })
    expect(() => createOrder(db, { vyroId: 'id2' }, pedidos)).toThrow(/ya la tienes hecha/)
  })
})
