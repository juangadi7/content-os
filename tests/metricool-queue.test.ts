/** Curiosidades (17-nov-2026): cola de Metricool de la fábrica y datos de YouTube Studio apuntados a mano para la fábrica. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { applyMetricoolQueue, metricoolQueueView, queueProblems, readMetricoolQueue, scheduledByFolder } from '../src/core/metricool-queue'
import { addOwnStats, getOwnChannelStats, setOwnPost, youtubeManualRows } from '../src/core/own-channels'
import { tmpDir } from './fixtures/builder'

let base: string
let db: DB
beforeEach(() => {
  base = tmpDir('cos_cola_')
  db = openDatabase(':memory:')
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

const GARBO = '43 · El barcelonés que engañó a Hitler'
const FUNC = '44 · Seis años sin ir a trabajar'
const CONG = '45 · La encontraron dura como una tabla'

function cola(obj: unknown): string {
  const f = path.join(base, 'cola_metricool.json')
  fs.writeFileSync(f, JSON.stringify(obj))
  return f
}

describe('cola de Metricool', () => {
  it('lo publicado cuenta como subido a YouTube por Metricool; lo programado lleva su fecha; los problemas salen como aviso', () => {
    const f = cola({
      actualizado: '2026-11-17T18:20:39',
      programados: [
        { carpeta_content_os: GARBO, titulo: 'Garbo', fecha: '2026-11-17T16:00', estado: 'publicado', youtube_id: 'KyCH5YUJVpA' },
        { carpeta_content_os: FUNC, titulo: 'Funcionario', fecha: '2026-11-18T10:00', estado: 'programado', youtube_id: null },
        { carpeta_content_os: CONG, titulo: 'Congelada', fecha: '2026-11-18T16:00', estado: 'programado', problema: 'ya_publicado' },
        { carpeta_content_os: 'no existe', estado: 'publicado', youtube_id: 'AAAAAAAAAAA' },
        { carpeta_content_os: 'sin estado' }
      ],
      problemas: ['Hay dos vídeos el mismo día']
    })
    const q = readMetricoolQueue(f)!
    expect(q.items.map((i) => i.state)).toEqual(['publicado', 'programado', 'programado', 'publicado'])
    expect(scheduledByFolder(q).get(FUNC)).toBe('2026-11-18T10:00')
    expect(scheduledByFolder(q).has(GARBO)).toBe(false)
    expect(queueProblems(q)).toEqual(['Hay dos vídeos el mismo día', 'Congelada: ya estaba publicado'])

    const carpetas = new Set([GARBO, FUNC, CONG])
    expect(applyMetricoolQueue(db, q, carpetas)).toBe(1)
    expect(applyMetricoolQueue(db, q, carpetas)).toBe(0) // una sola vez
    expect(db.prepare('SELECT video, platform, source, ext_id, url FROM own_posts').all()).toEqual([
      { video: GARBO, platform: 'youtube', source: 'metricool', ext_id: 'KyCH5YUJVpA', url: 'https://www.youtube.com/shorts/KyCH5YUJVpA' }
    ])
    // si ya estaba marcado a mano, no se duplica: solo se le añade el id
    setOwnPost(db, { channel: 'curio', video: FUNC, platform: 'youtube', uploaded: true })
    const q2 = readMetricoolQueue(cola({ programados: [{ carpeta_content_os: FUNC, estado: 'publicado', youtube_id: 'BBBBBBBBBBB' }] }))!
    expect(applyMetricoolQueue(db, q2, carpetas)).toBe(0)
    expect(db.prepare('SELECT source, ext_id FROM own_posts WHERE video = ?').get(FUNC)).toEqual({ source: 'manual', ext_id: 'BBBBBBBBBBB' })
  })

  it('sin archivo o con un archivo roto no cambia nada', () => {
    expect(readMetricoolQueue(path.join(base, 'no-existe.json'))).toBeNull()
    fs.writeFileSync(path.join(base, 'roto.json'), '{ esto no es json')
    expect(readMetricoolQueue(path.join(base, 'roto.json'))).toBeNull()
    expect(applyMetricoolQueue(db, null, new Set())).toBe(0)
    expect(queueProblems(null)).toEqual([])
  })
})

describe('pantalla «Cola de Metricool»', () => {
  it('ordena por fecha y resume: en cola, hasta cuándo y cuántos gratis quedan este mes', () => {
    const q = readMetricoolQueue(cola({
      actualizado: '2026-11-17T18:20:39',
      programados: [
        { nn: '44-funcionario', carpeta_content_os: FUNC, titulo: 'Funcionario', fecha: '2026-11-18T10:00', estado: 'programado' },
        { nn: '43-garbo', carpeta_content_os: GARBO, titulo: 'Garbo', fecha: '2026-11-17T16:00', estado: 'publicado', youtube_id: 'KyCH5YUJVpA' },
        { nn: '45-congelada', carpeta_content_os: CONG, titulo: 'Congelada', fecha: '2026-12-01T16:00', estado: 'programado' }
      ]
    }))
    const v = metricoolQueueView(q, new Date(2026, 10, 17, 12))
    expect(v.items.map((i) => [i.number, i.state, i.network])).toEqual([['43', 'publicado', 'YouTube Shorts'], ['44', 'programado', 'YouTube Shorts'], ['45', 'programado', 'YouTube Shorts']])
    expect([v.pending, v.lastAt, v.usedThisMonth, v.freeLeft, v.updatedAt]).toEqual([2, '2026-12-01T16:00', 2, 18, '2026-11-17T18:20:39'])
    expect(metricoolQueueView(null)).toMatchObject({ exists: false, items: [], pending: 0, freeLeft: 20 })
  })
})

describe('datos de YouTube Studio para la fábrica', () => {
  it('se apuntan a mano y salen en youtube_manual.json con el id de YouTube', () => {
    expect(() => addOwnStats(db, { channel: 'curio', video: GARBO, platform: 'youtube', viewedPct: '150' })).toThrow(/Vieron/)
    expect(() => addOwnStats(db, { channel: 'curio', video: GARBO, platform: 'youtube', avgViewS: 'mucho' })).toThrow(/segundos/)
    // sin id de YouTube todavía: la fábrica no lo reconocería, no sale
    addOwnStats(db, { channel: 'curio', video: GARBO, platform: 'youtube', viewedPct: '81', retention: '64' }, '2026-11-17T20:00:00.000Z')
    const titulos = new Map([[GARBO, 'El barcelonés que engañó a Hitler con 27 espías que no existían']])
    expect(youtubeManualRows(db, 'curio', titulos)).toEqual([])
    // con el enlace pegado ya tiene id; lo último apuntado manda, campo a campo
    addOwnStats(db, { channel: 'curio', video: GARBO, platform: 'youtube', url: 'https://www.youtube.com/shorts/KyCH5YUJVpA', avgViewS: '0:23', views: '398', viewedPct: '82' }, '2026-11-18T09:00:00.000Z')
    expect(youtubeManualRows(db, 'curio', titulos)).toEqual([{
      id: 'KyCH5YUJVpA', titulo: 'El barcelonés que engañó a Hitler con 27 espías que no existían',
      vieron_pct: 82, retencion_media_pct: 64, duracion_media_vista_s: 23, visitas: 398, fecha_apuntado: '2026-11-18'
    }])
    // y la app los enseña en la ficha del vídeo
    const p = getOwnChannelStats(db, 'curio', [{ id: GARBO, title: 'Garbo', description: null }]).videos[0].posts[0]
    expect([p.studio.viewedPct, p.studio.avgViewS, p.extId]).toEqual([82, 23, 'KyCH5YUJVpA'])
  })
})
