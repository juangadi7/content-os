import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries, type SyncSummary } from '../src/core/importer'
import { listCampaigns, listClips, listLibraries } from '../src/core/queries'
import { loadConfig, saveConfig } from '../src/core/config'
import { CampaignFixture, fingerprint, sha, tmpDir } from './fixtures/builder'

type Row = Record<string, any>

let base: string
let root: string
let data: string
let db: DB
let camp: CampaignFixture
let tick = 0

const now = () => new Date(Date.UTC(2026, 5, 1, 12, 0, tick++)).toISOString()
const sync = (roots = [root]): SyncSummary => syncLibraries(db, { roots, thumbsDir: path.join(data, 'thumbs'), now })
const clip = (id: string) => db.prepare('SELECT * FROM clips WHERE clip_id = ?').get(id) as Row | undefined
const campaign = (id: string) => db.prepare('SELECT * FROM campaigns WHERE campaign_id = ?').get(id) as Row | undefined
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n as number
const events = (runId: number, where = '1=1') =>
  db.prepare(`SELECT * FROM sync_events WHERE sync_run_id = ? AND ${where} ORDER BY id`).all(runId) as Row[]
const types = (runId: number) => events(runId).map((e) => e.type)
const codes = (runId: number) => events(runId).map((e) => e.code).filter(Boolean)

beforeEach(() => {
  tick = 0
  base = tmpDir()
  root = path.join(base, 'CAMPAIGNS')
  data = path.join(base, 'ContentOS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(data, 'content-os.db'))
  camp = new CampaignFixture(root, 'DEMO_2026-01-01', 'demo-2026-01-01', 'Demo')
  camp.addClip({ n: 1, clipId: 'clp_aaa', title: 'Primero', score: 95 })
  camp.addClip({ n: 2, clipId: 'clp_bbb', title: 'Segundo', score: 90 })
  camp.addClip({ n: 3, clipId: 'clp_ccc', title: 'Tercero', score: null, qa: 0.97 })
})

afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('importador', () => {
  it('1. importa una campaña nueva', () => {
    const r = sync()
    expect(r).toMatchObject({ status: 'ok', rootsScanned: 1, campaignsSeen: 1, clipsSeen: 3, created: 4, updated: 0, disappeared: 0, warnings: 0, errors: 0 })
    expect(campaign('demo-2026-01-01')).toMatchObject({ display_name: 'Demo', platform: 'Vyro', language: 'en', campaign_id_origin: 'clip_ids', state: 'ok', present_in_source: 1, clips_rejected: 1 })
    const k = clip('clp_aaa')!
    expect(k).toMatchObject({ campaign_id: 'demo-2026-01-01', title: 'Primero', score: 95, score_origin: 'unknown', prediction: null, selection_reason: null,
      requested_start_time: 100, requested_end_time: 130, file_state: 'ok', resolved_via: 'campaign_clips', present_in_source: 1, status: 'READY' })
    expect(k.file_sha256).toBe(k.sha256)
    expect(k.qa_path).toContain('clip_001.json')
    expect(k.qa_sheet_path).toContain('clip_001.png')
    expect(fs.readFileSync(k.thumb_path, 'utf8')).toBe('portada-1')
    expect(types(r.runId)).toEqual(['campaign_created', 'clip_created', 'clip_created', 'clip_created'])
  })

  it('2. un segundo sync sin cambios no duplica ni actualiza nada', () => {
    const a = sync()
    const antes = { c: campaign('demo-2026-01-01')!, k: clip('clp_aaa')! }
    const b = sync()
    expect(b).toMatchObject({ status: 'ok', created: 0, updated: 0, disappeared: 0, warnings: 0, errors: 0, hashesComputed: 0 })
    expect(b.hashesReused).toBe(3)
    expect(a.hashesComputed).toBe(3)
    expect(count('campaigns')).toBe(1)
    expect(count('clips')).toBe(3)
    expect(events(b.runId)).toHaveLength(0)
    const despues = { c: campaign('demo-2026-01-01')!, k: clip('clp_aaa')! }
    expect(despues.k.updated_at).toBe(antes.k.updated_at)
    expect(despues.c.updated_at).toBe(antes.c.updated_at)
    expect(despues.k.last_sync_at > antes.k.last_sync_at).toBe(true)
    expect(despues.c.last_sync_at > antes.c.last_sync_at).toBe(true)
  })

  it('3. añade un clip nuevo', () => {
    sync()
    camp.addClip({ n: 4, clipId: 'clp_ddd', title: 'Cuarto' })
    const r = sync()
    expect(r).toMatchObject({ created: 1, updated: 0, disappeared: 0 })
    expect(count('clips')).toBe(4)
    expect(types(r.runId)).toEqual(['clip_created'])
  })

  it('4. un cambio de título actualiza el mismo clip', () => {
    sync()
    camp.patchMeta(1, { title: 'Título nuevo', caption: 'Otra descripción' })
    const r = sync()
    expect(r).toMatchObject({ created: 0, updated: 1 })
    expect(count('clips')).toBe(3)
    expect(clip('clp_aaa')).toMatchObject({ title: 'Título nuevo', caption: 'Otra descripción', render_changed_at: null })
    const e = events(r.runId)
    expect(e.map((x) => x.type)).toEqual(['clip_updated'])
    expect(e[0].message).toContain('title')
  })

  it('5. renombrar el archivo (001 -> 007) conserva el clip_id', () => {
    sync()
    const viejo = String(camp.readMeta(1).filename)
    const nuevo = '007_otro-nombre.mp4'
    fs.renameSync(camp.clipPath(viejo), camp.clipPath(nuevo))
    const meta = camp.readMeta(1)
    fs.rmSync(camp.metaPath(1))
    camp.writeMeta(7, { ...meta, filename: nuevo, full_path: camp.clipPath(nuevo) })
    const r = sync()
    expect(r).toMatchObject({ created: 0, updated: 1, disappeared: 0 })
    expect(count('clips')).toBe(3)
    expect(clip('clp_aaa')).toMatchObject({ filename: nuevo, file_state: 'ok', resolved_path: camp.clipPath(nuevo), present_in_source: 1 })
    expect(types(r.runId)).toEqual(['clip_updated'])
  })

  it('6. un full_path distinto se actualiza y el archivo se vuelve a localizar', () => {
    sync()
    // la ficha apunta a una ruta que ya no existe (carpeta movida): se encuentra por la estructura de la campaña
    camp.patchMeta(1, { full_path: 'Z:\\ruta\\antigua\\001_primero.mp4' })
    let r = sync()
    expect(clip('clp_aaa')).toMatchObject({ full_path: 'Z:\\ruta\\antigua\\001_primero.mp4', file_state: 'ok', resolved_via: 'campaign_clips' })
    expect(types(r.runId)).toEqual(['clip_updated'])
    // el archivo vive fuera de CLIPS y solo full_path lo sabe
    const fuera = path.join(base, 'otra', 'movido.mp4')
    fs.mkdirSync(path.dirname(fuera), { recursive: true })
    fs.renameSync(camp.clipPath(String(camp.readMeta(2).filename)), fuera)
    camp.patchMeta(2, { full_path: fuera })
    r = sync()
    expect(clip('clp_bbb')).toMatchObject({ file_state: 'ok', resolved_via: 'full_path', resolved_path: fuera })
    // archivo renombrado a mano dentro de CLIPS: se encuentra por su hash
    const m3 = camp.readMeta(3)
    fs.renameSync(camp.clipPath(String(m3.filename)), camp.clipPath('renombrado-a-mano.mp4'))
    r = sync()
    expect(clip('clp_ccc')).toMatchObject({ file_state: 'ok', resolved_via: 'sha_search', resolved_path: camp.clipPath('renombrado-a-mano.mp4') })
    expect(count('clips')).toBe(3)
  })

  it('7. un sha256 distinto es un render nuevo del mismo clip', () => {
    sync()
    const meta = camp.readMeta(1)
    fs.writeFileSync(camp.clipPath(String(meta.filename)), 'render nuevo')
    camp.patchMeta(1, { sha256: sha('render nuevo'), created_at: '2026-02-02T10:00:00+01:00' })
    const r = sync()
    expect(count('clips')).toBe(3)
    const k = clip('clp_aaa')!
    expect(k.sha256).toBe(sha('render nuevo'))
    expect(k.file_sha256).toBe(sha('render nuevo'))
    expect(k.file_state).toBe('ok')
    expect(k.render_changed_at).not.toBeNull()
    expect(types(r.runId)).toEqual(['clip_updated', 'render_changed'])
    expect(r.hashesComputed).toBe(1)
    expect(r.warnings).toBe(0)
  })

  it('8. un clip que desaparece se marca, no se borra', () => {
    sync()
    camp.removeClip(2)
    const r = sync()
    expect(r).toMatchObject({ disappeared: 1, created: 0 })
    expect(count('clips')).toBe(3)
    const k = clip('clp_bbb')!
    expect(k.present_in_source).toBe(0)
    expect(k.missing_since).not.toBeNull()
    expect(k.title).toBe('Segundo')
    expect(types(r.runId)).toEqual(['clip_disappeared'])
    expect(listCampaigns(db)[0].clips).toBe(2)
  })

  it('9. un clip que reaparece recupera su estado', () => {
    sync()
    camp.removeClip(2)
    sync()
    camp.addClip({ n: 2, clipId: 'clp_bbb', title: 'Segundo', score: 90 })
    const r = sync()
    expect(clip('clp_bbb')).toMatchObject({ present_in_source: 1, missing_since: null })
    expect(types(r.runId)).toContain('clip_reappeared')
    expect(count('clips')).toBe(3)
  })

  it('10. una campaña que desaparece se marca y reaparece sin perder nada', () => {
    sync()
    const fuera = path.join(base, 'fuera')
    fs.renameSync(camp.dir, fuera)
    let r = sync()
    expect(r.disappeared).toBe(1)
    expect(campaign('demo-2026-01-01')).toMatchObject({ present_in_source: 0 })
    expect(campaign('demo-2026-01-01')!.missing_since).not.toBeNull()
    expect(count('clips')).toBe(3)
    expect(clip('clp_aaa')!.present_in_source).toBe(1)
    expect(types(r.runId)).toEqual(['campaign_disappeared'])
    // vuelve con otro nombre de carpeta: misma campaña
    fs.renameSync(fuera, path.join(root, 'DEMO_RENOMBRADA'))
    r = sync()
    expect(count('campaigns')).toBe(1)
    expect(campaign('demo-2026-01-01')).toMatchObject({ present_in_source: 1, missing_since: null, folder_name: 'DEMO_RENOMBRADA' })
    expect(types(r.runId)).toContain('campaign_reappeared')
    expect(clip('clp_aaa')!.file_state).toBe('ok')
  })

  it('10b. una biblioteca inaccesible no da nada por desaparecido', () => {
    sync()
    const r = sync([path.join(base, 'NO_EXISTE')])
    expect(r).toMatchObject({ status: 'error', rootsScanned: 0, disappeared: 0 })
    expect(codes(r.runId)).toEqual(['root_unavailable'])
    expect(campaign('demo-2026-01-01')!.present_in_source).toBe(1)
  })

  it('11. una ficha sin clip_id no se importa ni recibe identidad inventada', () => {
    camp.addClip({ n: 4, clipId: null, title: 'Sin identidad' })
    const r = sync()
    expect(count('clips')).toBe(3)
    expect(r.warnings).toBe(1)
    expect(codes(r.runId)).toEqual(['metadata_without_clip_id'])
    expect(db.prepare("SELECT COUNT(*) AS n FROM clips WHERE title = 'Sin identidad'").get()).toEqual({ n: 0 })
    // y mientras exista, no se marca ningún otro clip como desaparecido
    camp.removeClip(2)
    const r2 = sync()
    expect(r2.disappeared).toBe(0)
    expect(codes(r2.runId)).toContain('disappearance_deferred')
  })

  it('12. clip_id duplicado: ni en otra campaña ni en la misma se sobrescribe', () => {
    sync()
    const otra = new CampaignFixture(root, 'OTRA_2026-02-02', 'otra-2026-02-02', 'Otra')
    otra.addClip({ n: 1, clipId: 'clp_aaa', title: 'Impostor' })
    otra.addClip({ n: 2, clipId: 'clp_zzz', title: 'Legítimo' })
    let r = sync()
    expect(r.errors).toBe(1)
    expect(codes(r.runId)).toContain('duplicate_clip_id')
    expect(clip('clp_aaa')).toMatchObject({ campaign_id: 'demo-2026-01-01', title: 'Primero' })
    expect(clip('clp_zzz')).toMatchObject({ campaign_id: 'otra-2026-02-02' })
    // dos fichas con el mismo clip_id dentro de una campaña: no se toca el clip existente
    camp.writeMeta(9, { ...camp.readMeta(2), title: 'Copia' })
    r = sync()
    expect(events(r.runId, "code = 'duplicate_clip_id' AND campaign_id = 'demo-2026-01-01'")).toHaveLength(2)
    expect(clip('clp_bbb')).toMatchObject({ title: 'Segundo', present_in_source: 1 })
  })

  it('12b. el mismo campaign_id en dos carpetas: se ignora la segunda', () => {
    sync()
    const copia = new CampaignFixture(root, 'ZZ_COPIA', 'demo-2026-01-01', 'Copia')
    copia.addClip({ n: 1, clipId: 'clp_copia', title: 'Copia' })
    const r = sync()
    expect(codes(r.runId)).toEqual(['duplicate_campaign_id'])
    expect(clip('clp_copia')).toBeUndefined()
    expect(campaign('demo-2026-01-01')!.folder_name).toBe('DEMO_2026-01-01')
  })

  it('13. si falta el MP4 el clip se importa con el archivo marcado como ausente', () => {
    fs.rmSync(camp.clipPath(String(camp.readMeta(1).filename)))
    const r = sync()
    expect(count('clips')).toBe(3)
    expect(clip('clp_aaa')).toMatchObject({ file_state: 'missing', resolved_path: null, present_in_source: 1 })
    expect(codes(r.runId)).toEqual(['file_missing'])
    expect(listCampaigns(db)[0].clipsMissingFile).toBe(1)
    expect(sync().warnings).toBe(0) // no se repite el aviso en cada pasada
  })

  it('13b. un MP4 que no coincide con el sha256 de la ficha se detecta', () => {
    sync()
    fs.writeFileSync(camp.clipPath(String(camp.readMeta(1).filename)), 'alguien lo ha tocado')
    const r = sync()
    expect(clip('clp_aaa')).toMatchObject({ file_state: 'hash_mismatch', file_sha256: sha('alguien lo ha tocado') })
    expect(clip('clp_aaa')!.sha256).not.toBe(sha('alguien lo ha tocado'))
    expect(codes(r.runId)).toEqual(['hash_mismatch'])
    expect(r.updated).toBe(0)
  })

  it('14. una ficha corrupta no rompe la campaña ni borra lo que había', () => {
    sync()
    fs.writeFileSync(camp.metaPath(2), '{ "clip_id": "clp_bbb", "title": ')
    const r = sync()
    expect(r.errors).toBe(1)
    expect(codes(r.runId)).toEqual(['metadata_corrupt', 'disappearance_deferred'])
    expect(clip('clp_bbb')).toMatchObject({ title: 'Segundo', present_in_source: 1 })
    expect(clip('clp_aaa')!.present_in_source).toBe(1)
  })

  it('14b. una ficha parcial se importa con lo que tenga y se avisa', () => {
    const m = camp.readMeta(3)
    camp.writeMeta(3, { metadata_version: 2, clip_id: m.clip_id, campaign_id: m.campaign_id, filename: m.filename })
    const r = sync()
    expect(clip('clp_ccc')).toMatchObject({ title: null, sha256: null, file_state: 'unverified', present_in_source: 1 })
    expect(codes(r.runId)).toEqual(['metadata_partial', 'hash_unverified'])
  })

  it('14c. un campaign.json corrupto deja la campaña como estaba', () => {
    sync()
    fs.writeFileSync(path.join(camp.dir, 'campaign.json'), 'no es json')
    const r = sync()
    expect(codes(r.runId)).toEqual(['campaign_json_corrupt'])
    expect(r.disappeared).toBe(0)
    expect(campaign('demo-2026-01-01')).toMatchObject({ present_in_source: 1, state: 'unreadable', display_name: 'Demo' })
    expect(count('clips')).toBe(3)
  })

  it('15. con clip_ids.json corrupto se importa desde las fichas', () => {
    fs.writeFileSync(camp.ledgerPath(), '{{{ roto')
    const r = sync()
    expect(r.warnings).toBe(1)
    expect(codes(r.runId)).toEqual(['clip_ids_corrupt'])
    expect(count('clips')).toBe(3)
    expect(campaign('demo-2026-01-01')).toMatchObject({ campaign_id_origin: 'metadata' })
    expect(clip('clp_aaa')).toMatchObject({ requested_start_time: null })
  })

  it('16. METADATA vacía durante una generación no marca los clips como desaparecidos', () => {
    sync()
    for (const d of ['METADATA', 'CLIPS', 'QA']) for (const f of fs.readdirSync(path.join(camp.dir, d))) fs.rmSync(path.join(camp.dir, d, f))
    const r = sync()
    expect(r.disappeared).toBe(0)
    expect(codes(r.runId)).toEqual(['metadata_empty'])
    expect(campaign('demo-2026-01-01')).toMatchObject({ state: 'generating', present_in_source: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM clips WHERE present_in_source = 1').get()).toEqual({ n: 3 })
    expect(clip('clp_aaa')!.title).toBe('Primero')
    expect(fs.existsSync(clip('clp_aaa')!.thumb_path)).toBe(true) // la portada copiada sobrevive
    expect(sync().warnings).toBe(0)
    // termina la generación: vuelven dos clips, el tercero ya no existe
    camp.addClip({ n: 1, clipId: 'clp_aaa', title: 'Primero', score: 95 })
    camp.addClip({ n: 2, clipId: 'clp_bbb', title: 'Segundo', score: 90 })
    const fin = sync()
    expect(campaign('demo-2026-01-01')!.state).toBe('ok')
    expect(fin.disappeared).toBe(1)
    expect(clip('clp_ccc')!.present_in_source).toBe(0)
  })

  it('16b. CLIPS vacía con fichas presentes: aviso y archivos ausentes', () => {
    for (const f of fs.readdirSync(path.join(camp.dir, 'CLIPS'))) fs.rmSync(path.join(camp.dir, 'CLIPS', f))
    for (let n = 1; n <= 3; n++) camp.patchMeta(n, { full_path: null })
    const r = sync()
    expect(campaign('demo-2026-01-01')!.state).toBe('clips_empty')
    expect(codes(r.runId)).toContain('clips_folder_empty')
    expect(db.prepare("SELECT COUNT(*) AS n FROM clips WHERE file_state = 'missing'").get()).toEqual({ n: 3 })
  })

  it('17. una publicación existente se conserva y se avisa si el render cambia', () => {
    sync()
    const original = clip('clp_aaa')!.sha256
    db.prepare(
      `INSERT INTO publications (clip_id, platform, account, status, url, published_at, sha256_at_publish, created_at, updated_at)
       VALUES ('clp_aaa', 'youtube', 'canal1', 'published', 'https://example.test/v', '2026-01-02T00:00:00Z', ?, 'x', 'x')`
    ).run(original)
    expect(() =>
      db.prepare("INSERT INTO publications (clip_id, platform, account, created_at, updated_at) VALUES ('clp_aaa', 'youtube', 'canal1', 'x', 'x')").run()
    ).toThrow(/UNIQUE/)
    db.prepare("INSERT INTO publications (clip_id, platform, account, created_at, updated_at) VALUES ('clp_aaa', 'youtube', 'canal2', 'x', 'x')").run()

    fs.writeFileSync(camp.clipPath(String(camp.readMeta(1).filename)), 'otro render')
    camp.patchMeta(1, { sha256: sha('otro render') })
    const r = sync()
    expect(types(r.runId)).toEqual(['clip_updated', 'render_changed', 'warning'])
    expect(codes(r.runId)).toEqual(['published_render_differs'])
    expect(count('publications')).toBe(2)
    expect(db.prepare("SELECT sha256_at_publish, url FROM publications WHERE account = 'canal1'").get()).toEqual({ sha256_at_publish: original, url: 'https://example.test/v' })
    expect(listCampaigns(db)[0].clipsPublished).toBe(1)
    // y aunque el clip desaparezca, la publicación sigue ahí
    camp.removeClip(1)
    sync()
    expect(count('publications')).toBe(2)
  })

  it('18. dos bibliotecas', () => {
    const root2 = path.join(base, 'OTRA_BIBLIOTECA')
    fs.mkdirSync(root2)
    const c2 = new CampaignFixture(root2, 'SEGUNDA_2026-03-03', 'segunda-2026-03-03', 'Segunda')
    c2.addClip({ n: 1, clipId: 'clp_s1' })
    const r = sync([root, root2])
    expect(r).toMatchObject({ rootsScanned: 2, campaignsSeen: 2, clipsSeen: 4, status: 'ok' })
    expect(listLibraries(db).map((l) => [l.path, l.enabled, l.campaigns])).toEqual([[root2, true, 1], [root, true, 1]].sort())
    expect(campaign('segunda-2026-03-03')!.root_id).not.toBe(campaign('demo-2026-01-01')!.root_id)
    // quitar una biblioteca de la configuración la desactiva; sus campañas no se tocan
    const r2 = sync([root])
    expect(r2.disappeared).toBe(0)
    expect(listLibraries(db).find((l) => l.path === root2)).toMatchObject({ enabled: false })
    expect(campaign('segunda-2026-03-03')!.present_in_source).toBe(1)
  })

  it('19. campaign_id: clip_ids.json, luego informe, luego fichas; los conflictos no se resuelven en silencio', () => {
    // a) manda clip_ids.json
    expect(sync().errors).toBe(0)
    expect(campaign('demo-2026-01-01')!.campaign_id_origin).toBe('clip_ids')
    // b) sin registro, manda el informe
    const b = new CampaignFixture(root, 'B', 'b-id', 'B')
    b.addClip({ n: 1, clipId: 'clp_b1' })
    fs.rmSync(b.ledgerPath())
    b.writeReport({ campaign_id: 'b-id' })
    // c) registro e informe discrepan: no se importa
    const c = new CampaignFixture(root, 'C', 'c-id', 'C')
    c.addClip({ n: 1, clipId: 'clp_c1' })
    c.writeReport({ campaign_id: 'otro-id' })
    // d) sin registro ni informe y las fichas no se ponen de acuerdo: no se importa
    const d = new CampaignFixture(root, 'D', 'd-id', 'D')
    d.addClip({ n: 1, clipId: 'clp_d1', campaignId: 'd-id' })
    d.addClip({ n: 2, clipId: 'clp_d2', campaignId: 'd-otro' })
    fs.rmSync(d.ledgerPath())
    // e) una ficha con campaign_id distinto al de la campaña: solo esa ficha queda fuera
    const e = new CampaignFixture(root, 'E', 'e-id', 'E')
    e.addClip({ n: 1, clipId: 'clp_e1' })
    e.addClip({ n: 2, clipId: 'clp_e2', campaignId: 'intruso' })
    // f) campaña antigua sin ninguna identidad
    const f = new CampaignFixture(root, 'F', 'f-id', 'F')
    f.addClip({ n: 1, clipId: null, campaignId: null })
    fs.rmSync(f.ledgerPath())

    const r = sync()
    expect(campaign('b-id')).toMatchObject({ campaign_id_origin: 'report' })
    expect(campaign('c-id')).toBeUndefined()
    expect(campaign('otro-id')).toBeUndefined()
    expect(campaign('d-id')).toBeUndefined()
    expect(clip('clp_c1')).toBeUndefined()
    expect(clip('clp_d1')).toBeUndefined()
    expect(clip('clp_e1')).toBeDefined()
    expect(clip('clp_e2')).toBeUndefined()
    expect(campaign('f-id')).toBeUndefined()
    expect(events(r.runId, "code = 'campaign_id_conflict'")).toHaveLength(3)
    expect(codes(r.runId)).toContain('campaign_without_id')
    expect(count('campaigns')).toBe(3)
  })

  it('20. nunca escribe dentro de CAMPAIGNS', () => {
    const root2 = path.join(base, 'R2')
    fs.mkdirSync(root2)
    new CampaignFixture(root2, 'X', 'x-id').addClip({ n: 1, clipId: 'clp_x1' })
    camp.addClip({ n: 4, clipId: null, title: 'Sin identidad' })
    fs.writeFileSync(camp.metaPath(8), 'corrupta')
    fs.rmSync(camp.clipPath(String(camp.readMeta(3).filename)))
    const antes = { a: fingerprint(root), b: fingerprint(root2) }
    sync([root, root2])
    sync([root, root2])
    sync([root])
    listCampaigns(db)
    listClips(db, 'demo-2026-01-01')
    const despues = { a: fingerprint(root), b: fingerprint(root2) }
    expect(despues).toEqual(antes)
    // todo lo que CONTENT OS escribe está en su propia carpeta de datos
    expect(fs.readdirSync(data).sort()).toEqual(['content-os.db', 'content-os.db-shm', 'content-os.db-wal', 'thumbs'].filter((f) => fs.existsSync(path.join(data, f))))
    expect(fs.readdirSync(base).sort()).toEqual(['CAMPAIGNS', 'ContentOS', 'R2'])
  })
})

describe('orden y consultas', () => {
  it('ordena por score DESC, luego qa_score DESC, luego nombre', () => {
    camp.addClip({ n: 4, clipId: 'clp_ddd', title: 'Cuarto', score: null, qa: 0.99 })
    camp.addClip({ n: 5, clipId: 'clp_eee', title: 'Quinto', score: 95, qa: 0.5 })
    sync()
    const lista = listClips(db, 'demo-2026-01-01')
    expect(lista.map((k) => k.clipId)).toEqual(['clp_aaa', 'clp_eee', 'clp_bbb', 'clp_ddd', 'clp_ccc'])
    expect(lista.map((k) => k.position)).toEqual([1, 2, 3, 4, 5])
  })

  it('registra cada sincronización', () => {
    sync()
    sync()
    expect(db.prepare('SELECT status, campaigns_seen, clips_seen, created FROM sync_runs ORDER BY id').all()).toEqual([
      { status: 'ok', campaigns_seen: 1, clips_seen: 3, created: 4 },
      { status: 'ok', campaigns_seen: 1, clips_seen: 3, created: 0 }
    ])
  })
})

describe('configuración y base de datos', () => {
  it('crea la configuración editable la primera vez y la respeta después', () => {
    const dir = path.join(data, 'config')
    const a = loadConfig(dir, () => [root])
    expect(a).toMatchObject({ created: true, error: null, config: { library_roots: [root] } })
    saveConfig(dir, { library_roots: [root, path.join(base, 'otra')] })
    const b = loadConfig(dir, () => ['no se usa'])
    expect(b.created).toBe(false)
    expect(b.config.library_roots).toEqual([root, path.join(base, 'otra')])
    fs.writeFileSync(a.path, 'roto')
    const c = loadConfig(dir, () => [root])
    expect(c.error).toContain('ilegible')
    expect(fs.readFileSync(a.path, 'utf8')).toBe('roto') // no se sobrescribe un archivo que no se entiende
  })

  it('reabre la base sin perder datos y con las claves foráneas activas', () => {
    sync()
    db.close()
    db = openDatabase(path.join(data, 'content-os.db'))
    expect(count('clips')).toBe(3)
    expect(() => db.prepare("INSERT INTO publications (clip_id, platform, created_at, updated_at) VALUES ('no_existe', 'tiktok', 'x', 'x')").run()).toThrow(/FOREIGN KEY/)
    expect(() => db.prepare("INSERT INTO publications (clip_id, platform, created_at, updated_at) VALUES ('clp_aaa', 'facebook', 'x', 'x')").run()).toThrow(/CHECK/)
  })
})
