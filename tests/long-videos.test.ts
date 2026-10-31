/** «Vídeos largos»: lectura de la carpeta, títulos y miniaturas A/B/C, rutas seguras y marca de subido. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { listLongVideos, resolveLongFolder, resolveLongThumb, resolveLongVideo, setLongUploaded } from '../src/core/long-videos'
import { tmpDir } from './fixtures/builder'

let base: string
let carpeta: string
let db: DB
const escribir = (rel: string, contenido: string | Buffer = Buffer.alloc(4096)) => {
  const ruta = path.join(carpeta, rel)
  fs.mkdirSync(path.dirname(ruta), { recursive: true })
  fs.writeFileSync(ruta, contenido)
}

beforeEach(() => {
  base = tmpDir('cos_long_')
  carpeta = path.join(base, 'VIDEOS_LARGOS')
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('lectura de la carpeta', () => {
  it('sin carpeta: vacío, sin error', () => {
    expect(listLongVideos(db, carpeta)).toEqual({ folder: carpeta, exists: false, videos: [], total: 0 })
  })

  it('lee los 3 títulos y las 3 miniaturas en orden A, B, C', () => {
    escribir('03 GTA V/video.json', JSON.stringify({
      channel: 'MiCanal', titles: ['Título A', 'Título B', 'Título C', 'sobra'],
      description: 'Descripción', hashtags: ['GTA5', '', 7], pinned_comment: 'A, B or C?', schedule: 'Martes 20:00', file: 'gta_v.mp4'
    }))
    escribir('03 GTA V/gta_v.mp4')
    escribir('03 GTA V/gta_v.srt', '1')
    escribir('03 GTA V/miniatura_C.jpg', 'c')
    escribir('03 GTA V/miniatura_A.jpg', 'a')
    escribir('03 GTA V/miniatura_B.png', 'b')
    const v = listLongVideos(db, carpeta)
    expect(v.total).toBe(1)
    const x = v.videos[0]
    expect(x.titles).toEqual([{ letter: 'A', text: 'Título A' }, { letter: 'B', text: 'Título B' }, { letter: 'C', text: 'Título C' }])
    expect(x.thumbs).toEqual(['A', 'B', 'C'])
    expect([x.id, x.file, x.channel, x.description, x.hashtags, x.pinnedComment, x.schedule, x.hasSubtitles, x.sizeBytes, x.uploadedAt])
      .toEqual(['03 GTA V', 'gta_v.mp4', 'MiCanal', 'Descripción', ['GTA5'], 'A, B or C?', 'Martes 20:00', true, 4096, null])
    expect(resolveLongThumb(carpeta, '03 GTA V', 'B')).toBe(path.join(carpeta, '03 GTA V', 'miniatura_B.png'))
  })

  it('sin video.json usa el MP4 más grande; los títulos que faltan no aparecen; el más reciente (por número) primero', () => {
    escribir('01 Avengers/pequeño.mp4', Buffer.alloc(10))
    escribir('01 Avengers/grande.mp4', Buffer.alloc(9000))
    escribir('01 Avengers/miniatura.jpg', 'a')
    escribir('02 GTA/video.json', JSON.stringify({ titles: ['Solo A', null, 'Solo C'] }))
    escribir('02 GTA/v.mp4')
    escribir('_trabajo/x.mp4')
    escribir('Vacía/leeme.txt', 'nada')
    const v = listLongVideos(db, carpeta)
    expect(v.videos.map((x) => x.id)).toEqual(['02 GTA', '01 Avengers'])
    expect(v.videos[0].titles).toEqual([{ letter: 'A', text: 'Solo A' }, { letter: 'C', text: 'Solo C' }])
    expect([v.videos[1].file, v.videos[1].thumbs, v.videos[1].titles]).toEqual(['grande.mp4', ['A'], []])
  })
})

describe('rutas seguras', () => {
  it('solo carpetas directas, solo A/B/C', () => {
    escribir('V1/v.mp4')
    escribir('V1/miniatura_A.jpg', 'a')
    expect(resolveLongVideo(carpeta, 'V1')).toBe(path.join(carpeta, 'V1', 'v.mp4'))
    expect(resolveLongFolder(carpeta, 'V1')).toBe(path.join(carpeta, 'V1'))
    for (const malo of ['..', '../V1', 'V1/v.mp4', '', '.', '_x', null, 7]) {
      expect(resolveLongVideo(carpeta, malo)).toBeNull()
      expect(resolveLongFolder(carpeta, malo)).toBeNull()
    }
    for (const letra of ['D', 'a', '', null]) expect(resolveLongThumb(carpeta, 'V1', letra)).toBeNull()
  })
})

describe('marca de subido', () => {
  it('se marca, se desmarca y solo existe para vídeos que están', () => {
    escribir('V1/v.mp4')
    setLongUploaded(db, carpeta, 'V1', true, new Date('2026-10-23T19:00:00Z'))
    expect(listLongVideos(db, carpeta).videos[0].uploadedAt).toBe('2026-10-23T19:00:00.000Z')
    setLongUploaded(db, carpeta, 'V1', false)
    expect(listLongVideos(db, carpeta).videos[0].uploadedAt).toBeNull()
    expect(() => setLongUploaded(db, carpeta, '../V1', true)).toThrow('El vídeo no existe.')
    expect(() => setLongUploaded(db, carpeta, 'Otro', true)).toThrow('El vídeo no existe.')
  })
})

describe('«Vídeos de música»', () => {
  it('misma carpeta-tipo, marcas de subido separadas de «Vídeos largos» aunque el nombre coincida', () => {
    const musica = path.join(base, 'VIDEOS_MUSICA')
    escribir('01 Prueba/v.mp4')
    fs.mkdirSync(path.join(musica, '01 Prueba'), { recursive: true })
    fs.writeFileSync(path.join(musica, '01 Prueba', 'video.json'), JSON.stringify({ titles: ['Rainy Night Library'] }))
    fs.writeFileSync(path.join(musica, '01 Prueba', 'v.mp4'), Buffer.alloc(10))
    setLongUploaded(db, musica, '01 Prueba', true, new Date('2026-10-29T12:00:00Z'), 'music')
    expect(listLongVideos(db, musica, 'music').videos[0].uploadedAt).toBe('2026-10-29T12:00:00.000Z')
    expect(listLongVideos(db, musica, 'music').videos[0].titles).toEqual([{ letter: 'A', text: 'Rainy Night Library' }])
    expect(listLongVideos(db, carpeta).videos[0].uploadedAt).toBeNull()
    expect((db.prepare("SELECT key FROM settings WHERE key LIKE '%_upload:%'").all() as { key: string }[]).map((r) => r.key))
      .toEqual(['music_upload:01 Prueba'])
  })
})
