/** Datos que alimentan la interfaz: orden, publicaciones, pendientes, textos para copiar, estados vacíos. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { filterClips, formatDuration, hashtagsText, qaLabel, relativeTime, scoreLabel } from '../src/core/format'
import { syncLibraries } from '../src/core/importer'
import { deletePublication, savePublication } from '../src/core/publications'
import { clipPaths, counts, getCampaign, getClip, listCampaigns, listClips, listPublished } from '../src/core/queries'
import { CampaignFixture, sha, tmpDir } from './fixtures/builder'

type Row = Record<string, any>

let base: string
let root: string
let data: string
let db: DB
let camp: CampaignFixture
let tick = 0
const now = () => new Date(Date.UTC(2026, 5, 1, 12, 0, tick++)).toISOString()
const sync = () => syncLibraries(db, { roots: [root], thumbsDir: path.join(data, 'thumbs'), now })
const ids = (campaignId: string | null = 'demo') => listClips(db, campaignId).map((k) => k.clipId)

beforeEach(() => {
  tick = 0
  base = tmpDir('cos_ui_')
  root = path.join(base, 'CAMPAIGNS')
  data = path.join(base, 'ContentOS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(data, 'content-os.db'))
  camp = new CampaignFixture(root, 'DEMO', 'demo', 'Demo')
})

afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('ranking', () => {
  it('con score: de mayor a menor', () => {
    camp.addClip({ n: 1, clipId: 'clp_b', score: 90 })
    camp.addClip({ n: 2, clipId: 'clp_a', score: 97 })
    camp.addClip({ n: 3, clipId: 'clp_c', score: 93 })
    sync()
    expect(ids()).toEqual(['clp_a', 'clp_c', 'clp_b'])
    expect(listClips(db, 'demo').map((k) => k.position)).toEqual([1, 2, 3])
    expect(getClip(db, 'clp_c')!.position).toBe(2)
  })

  it('con score null: van después de los que tienen score y nunca valen 0', () => {
    camp.addClip({ n: 1, clipId: 'clp_null_alto', score: null, qa: 1 })
    camp.addClip({ n: 2, clipId: 'clp_cero', score: 0, qa: 0.5 })
    camp.addClip({ n: 3, clipId: 'clp_uno', score: 1, qa: 0.5 })
    sync()
    expect(ids()).toEqual(['clp_uno', 'clp_cero', 'clp_null_alto'])
    const sin = listClips(db, 'demo')[2]
    expect(sin.score).toBeNull()
    expect(scoreLabel(sin.score)).toBe('Sin score')
    expect(scoreLabel(0)).toBe('0')
    expect(listCampaigns(db)[0].bestScore).toBe(1)
  })

  it('todos sin score (Shark Tank histórico): manda el QA y la campaña no tiene «mejor score»', () => {
    camp.addClip({ n: 1, clipId: 'clp_x', score: null, qa: 0.991 })
    camp.addClip({ n: 2, clipId: 'clp_y', score: null, qa: 0.999 })
    sync()
    expect(ids()).toEqual(['clp_y', 'clp_x'])
    expect(listCampaigns(db)[0].bestScore).toBeNull()
    expect(scoreLabel(listCampaigns(db)[0].bestScore)).toBe('Sin score')
  })

  it('desempate: mismo score -> QA DESC; mismo QA -> clip_id ASC', () => {
    camp.addClip({ n: 1, clipId: 'clp_z', score: 95, qa: 0.98 })
    camp.addClip({ n: 2, clipId: 'clp_m', score: 95, qa: 0.99 })
    camp.addClip({ n: 3, clipId: 'clp_b', score: 95, qa: 0.98, title: 'Zzz, el último por título' })
    camp.addClip({ n: 4, clipId: 'clp_a', score: 95, qa: 0.98, title: 'Otro' })
    sync()
    expect(ids()).toEqual(['clp_m', 'clp_a', 'clp_b', 'clp_z'])
  })

  it('«Todos los clips» ordena igual entre campañas', () => {
    camp.addClip({ n: 1, clipId: 'clp_1', score: 90 })
    const otra = new CampaignFixture(root, 'OTRA', 'otra', 'Otra')
    otra.addClip({ n: 1, clipId: 'clp_2', score: 99 })
    otra.addClip({ n: 2, clipId: 'clp_3', score: null })
    sync()
    const todos = listClips(db, null)
    expect(todos.map((k) => k.clipId)).toEqual(['clp_2', 'clp_1', 'clp_3'])
    expect(todos.map((k) => k.campaignName)).toEqual(['Otra', 'Demo', 'Otra'])
  })
})

describe('publicaciones', () => {
  beforeEach(() => {
    camp.addClip({ n: 1, clipId: 'clp_a', title: 'Primero', score: 95, content: 'render-1' })
    camp.addClip({ n: 2, clipId: 'clp_b', title: 'Segundo', score: 90 })
    camp.addClip({ n: 3, clipId: 'clp_c', title: 'Tercero', score: 80 })
    sync()
  })

  it('marcar publicado guarda todos los datos', () => {
    const id = savePublication(db, {
      clipId: 'clp_a', platform: 'tiktok', account: ' @canal ', url: 'https://example.test/v/1', publishedAt: '2026-03-04T18:30:00+01:00',
      titleUsed: 'Título usado', captionUsed: 'Caption usado', notes: 'nota'
    }, now)
    expect(db.prepare('SELECT * FROM publications WHERE id = ?').get(id)).toMatchObject({
      clip_id: 'clp_a', platform: 'tiktok', account: '@canal', status: 'published', url: 'https://example.test/v/1',
      published_at: '2026-03-04T17:30:00.000Z', title_used: 'Título usado', caption_used: 'Caption usado', notes: 'nota'
    })
    const d = getClip(db, 'clp_a')!
    expect(d.published).toEqual(['tiktok'])
    expect(d.publications).toHaveLength(1)
    expect(d.knownAccounts.tiktok).toEqual(['@canal'])
  })

  it('sha256_at_publish = hash del MP4 en ese momento, y no cambia al editar ni al regenerar', () => {
    const id = savePublication(db, { clipId: 'clp_a', platform: 'youtube' }, now)
    const fila = () => db.prepare('SELECT * FROM publications WHERE id = ?').get(id) as Row
    expect(fila().sha256_at_publish).toBe(sha('render-1'))
    expect(fila().published_at).toBeTruthy() // sin fecha: ahora

    // el clip se vuelve a generar
    fs.writeFileSync(camp.clipPath(String(camp.readMeta(1).filename)), 'render-2')
    camp.patchMeta(1, { sha256: sha('render-2') })
    sync()
    savePublication(db, { id, clipId: 'clp_a', platform: 'youtube', notes: 'editada después' }, now)
    expect(fila()).toMatchObject({ sha256_at_publish: sha('render-1'), notes: 'editada después' })
    expect(getClip(db, 'clp_a')!.publications[0].renderChangedSince).toBe(true)
    // una publicación nueva sí toma el hash del render actual
    const id2 = savePublication(db, { clipId: 'clp_a', platform: 'instagram' }, now)
    expect((db.prepare('SELECT sha256_at_publish FROM publications WHERE id = ?').get(id2) as Row).sha256_at_publish).toBe(sha('render-2'))
  })

  it('publicación duplicada: mismo clip + plataforma + cuenta no crea otra fila', () => {
    const a = savePublication(db, { clipId: 'clp_a', platform: 'tiktok', account: '@uno', url: 'https://example.test/1', notes: 'primera' }, now)
    expect(() => savePublication(db, { clipId: 'clp_a', platform: 'tiktok', account: '@uno', notes: 'segunda' }, now)).toThrow(/Ya hay una publicación/)
    expect(() => savePublication(db, { clipId: 'clp_a', platform: 'tiktok', account: ' @uno ' }, now)).toThrow(/Ya hay una publicación/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM publications').get()).toEqual({ n: 1 })
    // la existente queda intacta; para cambiarla se edita por su id
    expect(db.prepare('SELECT notes, url FROM publications').get()).toEqual({ notes: 'primera', url: 'https://example.test/1' })
    expect(savePublication(db, { id: a, clipId: 'clp_a', platform: 'tiktok', account: '@uno', url: 'https://example.test/1', notes: 'editada' }, now)).toBe(a)
    expect((db.prepare('SELECT notes FROM publications').get() as Row).notes).toBe('editada')
    // otra cuenta u otra plataforma sí son publicaciones distintas
    savePublication(db, { clipId: 'clp_a', platform: 'tiktok', account: '@dos' }, now)
    savePublication(db, { clipId: 'clp_a', platform: 'youtube', account: '@uno' }, now)
    expect(db.prepare('SELECT COUNT(*) AS n FROM publications').get()).toEqual({ n: 3 })
    // cambiar la cuenta de una a la de otra ya existente se rechaza con un mensaje claro
    expect(() => savePublication(db, { id: a, clipId: 'clp_a', platform: 'tiktok', account: '@dos' }, now)).toThrow(/Ya hay una publicación/)
    expect(() => db.prepare("INSERT INTO publications (clip_id, platform, account, created_at, updated_at) VALUES ('clp_a', 'tiktok', '@uno', 'x', 'x')").run()).toThrow(/UNIQUE/)
  })

  it('valida los datos', () => {
    expect(() => savePublication(db, { clipId: 'no_existe', platform: 'tiktok' }, now)).toThrow(/no existe/)
    expect(() => savePublication(db, { clipId: 'clp_a', platform: 'facebook' as never }, now)).toThrow(/Plataforma/)
    expect(() => savePublication(db, { clipId: 'clp_a', platform: 'tiktok', url: 'javascript:alert(1)' }, now)).toThrow(/URL/)
    expect(() => savePublication(db, { clipId: 'clp_a', platform: 'tiktok', publishedAt: 'ayer' }, now)).toThrow(/Fecha/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM publications').get()).toEqual({ n: 0 })
  })

  it('clip pendiente / clip publicado', () => {
    expect(counts(db)).toEqual({ campaigns: 1, clips: 3, published: 0, pending: 3 })
    expect(listPublished(db)).toEqual([])
    savePublication(db, { clipId: 'clp_b', platform: 'instagram', publishedAt: '2026-02-01T10:00:00Z' }, now)
    savePublication(db, { clipId: 'clp_b', platform: 'youtube', publishedAt: '2026-02-03T10:00:00Z', url: 'https://example.test/yt' }, now)
    const lista = listClips(db, 'demo')
    expect(lista.find((k) => k.clipId === 'clp_b')!.published).toEqual(['youtube', 'instagram'])
    expect(filterClips(lista, 'pending').map((k) => k.clipId)).toEqual(['clp_a', 'clp_c'])
    expect(filterClips(lista, 'published').map((k) => k.clipId)).toEqual(['clp_b'])
    expect(filterClips(lista, 'top5')).toHaveLength(3)
    expect(filterClips(lista, 'all', 'TERC').map((k) => k.clipId)).toEqual(['clp_c'])
    expect(filterClips(lista, 'all', 'no hay nada así')).toEqual([])
    expect(counts(db)).toEqual({ campaigns: 1, clips: 3, published: 1, pending: 2 })
    expect(listCampaigns(db)[0].clipsPublished).toBe(1)
    // «Publicados»: una fila por publicación, la más reciente primero, con clip, campaña, plataforma, fecha, URL y score
    const pubs = listPublished(db)
    expect(pubs.map((r) => [r.clip.clipId, r.clip.campaignName, r.publication.platform, r.publication.url, r.clip.score])).toEqual([
      ['clp_b', 'Demo', 'youtube', 'https://example.test/yt', 90],
      ['clp_b', 'Demo', 'instagram', null, 90]
    ])
  })

  it('quitar una publicación devuelve el clip a pendientes; el clip no se toca', () => {
    const id = savePublication(db, { clipId: 'clp_a', platform: 'tiktok' }, now)
    deletePublication(db, id)
    expect(counts(db).pending).toBe(3)
    expect(getClip(db, 'clp_a')!.title).toBe('Primero')
    expect(fs.existsSync(getClip(db, 'clp_a')!.resolvedPath!)).toBe(true)
  })

  it('las publicaciones sobreviven a que el clip desaparezca del generador', () => {
    savePublication(db, { clipId: 'clp_c', platform: 'tiktok' }, now)
    camp.removeClip(3)
    sync()
    expect(listPublished(db)).toHaveLength(1)
    const lista = listClips(db, 'demo')
    expect(lista[lista.length - 1]).toMatchObject({ clipId: 'clp_c', presentInSource: false, published: ['tiktok'] })
    expect(filterClips(lista, 'pending').map((k) => k.clipId)).toEqual(['clp_a', 'clp_b'])
  })
})

describe('contenido para copiar', () => {
  it('título, descripción y hashtags salen exactamente como están en la ficha', () => {
    camp.addClip({ n: 1, clipId: 'clp_a' })
    const title = "  'We crashed the baby' — 100% real 😅 "
    const caption = 'Línea 1\nLínea 2 con "comillas" y $1,000,000.  Dos espacios. #ABCPartner #SharkTank'
    const hashtags = ['#ABCPartner', '#SharkTank', '#ñandú']
    camp.patchMeta(1, { title, caption, hashtags })
    sync()
    const d = getClip(db, 'clp_a')!
    expect(d.title).toBe(title)
    expect(d.caption).toBe(caption)
    expect(d.hashtags).toEqual(hashtags)
    expect(hashtagsText(d.hashtags)).toBe('#ABCPartner #SharkTank #ñandú')
  })

  it('campaña sin hashtags: texto vacío, no inventado', () => {
    camp.addClip({ n: 1, clipId: 'clp_a' })
    camp.patchMeta(1, { hashtags: [] })
    sync()
    expect(getClip(db, 'clp_a')!.hashtags).toEqual([])
    expect(hashtagsText(getClip(db, 'clp_a')!.hashtags)).toBe('')
  })
})

describe('estados vacíos y archivos', () => {
  it('campaña vacía: aparece con 0 clips y sin mejor score', () => {
    sync()
    expect(getCampaign(db, 'demo')).toMatchObject({ clips: 0, bestScore: null, state: 'empty', clipsPublished: 0 })
    expect(listClips(db, 'demo')).toEqual([])
    expect(counts(db)).toEqual({ campaigns: 1, clips: 0, published: 0, pending: 0 })
  })

  it('sin campañas', () => {
    fs.rmSync(camp.dir, { recursive: true })
    sync()
    expect(listCampaigns(db)).toEqual([])
    expect(listClips(db, null)).toEqual([])
    expect(getClip(db, 'no_existe')).toBeNull()
  })

  it('clip sin portada: se importa sin miniatura', () => {
    camp.addClip({ n: 1, clipId: 'clp_con' })
    camp.addClip({ n: 2, clipId: 'clp_sin' })
    fs.rmSync(path.join(camp.dir, 'METADATA', 'clip_002_portada.jpg'))
    sync()
    const lista = listClips(db, 'demo')
    expect(lista.find((k) => k.clipId === 'clp_con')).toMatchObject({ hasThumb: true })
    expect(lista.find((k) => k.clipId === 'clp_sin')).toMatchObject({ hasThumb: false, thumbVersion: null })
    expect(clipPaths(db, 'clp_sin')!.thumb).toBeNull()
    expect(fs.existsSync(clipPaths(db, 'clp_con')!.thumb!)).toBe(true)
    expect(fs.readdirSync(path.join(camp.dir, 'METADATA')).filter((f) => f.endsWith('.jpg'))).toEqual(['clip_001_portada.jpg'])
  })

  it('archivo faltante: el clip sigue visible, sin ruta que abrir, y aun así se puede marcar publicado', () => {
    camp.addClip({ n: 1, clipId: 'clp_a', content: 'video' })
    sync()
    fs.rmSync(camp.clipPath(String(camp.readMeta(1).filename)))
    camp.patchMeta(1, { full_path: null })
    sync()
    const d = getClip(db, 'clp_a')!
    expect(d).toMatchObject({ fileState: 'missing', resolvedPath: null, presentInSource: true })
    expect(clipPaths(db, 'clp_a')!.video).toBeNull()
    expect(getCampaign(db, 'demo')!.clipsMissingFile).toBe(1)
    // sin archivo delante, se guarda el hash del render que consta en la ficha
    const id = savePublication(db, { clipId: 'clp_a', platform: 'tiktok' }, now)
    expect((db.prepare('SELECT sha256_at_publish FROM publications WHERE id = ?').get(id) as Row).sha256_at_publish).toBe(sha('video'))
  })

  it('archivo modificado a mano: estado propio, distinto de «falta»', () => {
    camp.addClip({ n: 1, clipId: 'clp_a' })
    sync()
    fs.writeFileSync(camp.clipPath(String(camp.readMeta(1).filename)), 'tocado')
    sync()
    expect(getClip(db, 'clp_a')!.fileState).toBe('hash_mismatch')
  })
})

describe('formato', () => {
  it('duración, QA y fechas relativas', () => {
    expect(formatDuration(43.4)).toBe('0:43')
    expect(formatDuration(125)).toBe('2:05')
    expect(formatDuration(null)).toBe('—')
    expect(qaLabel(0.999)).toBe('99.9')
    expect(qaLabel(1)).toBe('100')
    expect(qaLabel(null)).toBe('—')
    const ahora = new Date('2026-06-01T12:00:00Z')
    expect(relativeTime('2026-06-01T11:59:50Z', ahora)).toBe('ahora mismo')
    expect(relativeTime('2026-06-01T11:58:00Z', ahora)).toBe('hace 2 min')
    expect(relativeTime('2026-06-01T09:00:00Z', ahora)).toBe('hace 3 h')
    expect(relativeTime('2026-05-31T10:00:00Z', ahora)).toBe('ayer')
    expect(relativeTime(null, ahora)).toBe('nunca')
  })
})
