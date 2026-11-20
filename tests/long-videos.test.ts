/** «Vídeos largos»: lectura de la carpeta, títulos y miniaturas A/B/C, rutas seguras y marca de subido. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { asLongKind, cityPending, listLongVideos, moveUploadMarks, readCityStats, resolveLongFolder, resolveLongThumb, resolveLongVideo, setLongUploaded } from '../src/core/long-videos'
import { adoptLegacyMarks } from '../src/core/own-channels'
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

describe('«Historias Roblox»', () => {
  it('es un tipo propio, con su carpeta y su marca de subido separada de música', () => {
    expect(asLongKind('roblox')).toBe('roblox')
    const roblox = path.join(base, 'VIDEOS_ROBLOX')
    fs.mkdirSync(path.join(roblox, '001 · Lámpara'), { recursive: true })
    fs.writeFileSync(path.join(roblox, '001 · Lámpara', 'video.json'), JSON.stringify({ titles: ['Su Lámpara FEA Lo SALVÓ'] }))
    fs.writeFileSync(path.join(roblox, '001 · Lámpara', 'v.mp4'), Buffer.alloc(10))
    setLongUploaded(db, roblox, '001 · Lámpara', true, new Date('2026-11-07T12:00:00Z'), 'roblox')
    const v = listLongVideos(db, roblox, 'roblox').videos[0]
    expect(v.uploadedAt).toBe('2026-11-07T12:00:00.000Z')
    expect(v.titles).toEqual([{ letter: 'A', text: 'Su Lámpara FEA Lo SALVÓ' }])
    // canal propio (16-nov-2026): la subida va por red; sin decir red, YouTube
    expect(v.uploads).toEqual({ tiktok: null, instagram: null, youtube: '2026-11-07T12:00:00.000Z' })
    expect(db.prepare("SELECT channel, video, platform, source FROM own_posts").all()).toEqual([{ channel: 'roblox', video: '001 · Lámpara', platform: 'youtube', source: 'manual' }])
    expect(db.prepare("SELECT key FROM settings WHERE key LIKE '%_upload:%'").all()).toEqual([])
    // se marca en otra red y se desmarca
    setLongUploaded(db, roblox, '001 · Lámpara', true, new Date('2026-11-08T12:00:00Z'), 'roblox', 'tiktok')
    expect(listLongVideos(db, roblox, 'roblox').videos[0].uploads.tiktok).toBe('2026-11-08T12:00:00.000Z')
    setLongUploaded(db, roblox, '001 · Lámpara', false, new Date(), 'roblox', 'youtube')
    expect(listLongVideos(db, roblox, 'roblox').videos[0].uploadedAt).toBe('2026-11-08T12:00:00.000Z')
  })
})

describe('«GTA 6»', () => {
  it('lee VIDEOS_GTA6 con su propia marca y se lleva las marcas que venían de «Curiosidades»', () => {
    expect(asLongKind('gta')).toBe('gta')
    const gta = path.join(base, 'VIDEOS_GTA6')
    fs.mkdirSync(path.join(gta, '32 · Disco'), { recursive: true })
    fs.writeFileSync(path.join(gta, '32 · Disco', 'video.json'), JSON.stringify({ titles: ['GTA 6 se come un tercio de tu PS5'] }))
    fs.writeFileSync(path.join(gta, '32 · Disco', 'v.mp4'), Buffer.alloc(10))
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('curio_upload:32 · Disco', '2026-11-13T12:00:00.000Z')
    expect(moveUploadMarks(db, gta, 'curio', 'gta')).toBe(1)
    expect(moveUploadMarks(db, gta, 'curio', 'gta')).toBe(0)
    expect((db.prepare("SELECT key FROM settings WHERE key LIKE '%upload:32%'").all() as { key: string }[]).map((r) => r.key)).toEqual(['gta_upload:32 · Disco'])
    // y al abrir la app la marca vieja pasa a las subidas por red (una sola vez)
    expect(adoptLegacyMarks(db, 'gta')).toBe(1)
    expect(adoptLegacyMarks(db, 'gta')).toBe(0)
    const v = listLongVideos(db, gta, 'gta').videos[0]
    expect(v.uploadedAt).toBe('2026-11-13T12:00:00.000Z')
    expect(v.uploads.youtube).toBe('2026-11-13T12:00:00.000Z')
    expect(db.prepare("SELECT key FROM settings WHERE key LIKE '%upload:32%'").all()).toEqual([])
  })
})

describe('«Curiosidades»', () => {
  it('es un tipo propio, con su carpeta y su marca de subido', () => {
    expect(asLongKind('curio')).toBe('curio')
    const curio = path.join(base, 'VIDEOS_CURIOSIDADES')
    fs.mkdirSync(path.join(curio, '04 · GPS'), { recursive: true })
    fs.writeFileSync(path.join(curio, '04 · GPS', 'video.json'), JSON.stringify({ titles: ['Por qué tu móvil sabe dónde estás sin internet'] }))
    fs.writeFileSync(path.join(curio, '04 · GPS', 'v.mp4'), Buffer.alloc(10))
    setLongUploaded(db, curio, '04 · GPS', true, new Date('2026-11-09T12:00:00Z'), 'curio')
    const v = listLongVideos(db, curio, 'curio').videos[0]
    expect(v.uploadedAt).toBe('2026-11-09T12:00:00.000Z')
    expect(db.prepare("SELECT channel, platform FROM own_posts").all()).toEqual([{ channel: 'curio', platform: 'youtube' }])
  })
})

describe('«Vídeos de la ciudad»', () => {
  const preparar = () => {
    const ciudad = path.join(base, 'VIDEOS_CIUDAD')
    const dia = path.join(ciudad, '01 · Día 1')
    fs.mkdirSync(dia, { recursive: true })
    fs.writeFileSync(path.join(dia, 'video.json'), JSON.stringify({
      channel: 'La Ciudad de Todos',
      titles: ['Construimos una ciudad entre todos 🏗️ Día 1'],
      description: 'Texto YouTube',
      hashtags: ['shorts'],
      captions: { tiktok: 'Texto TikTok', instagram: 'Texto Instagram', otra: 'no' },
      schedule: '3 nov a las 13:00'
    }))
    fs.writeFileSync(path.join(dia, 'dia-01.mp4'), Buffer.alloc(10))
    fs.writeFileSync(path.join(dia, 'miniatura_A.png'), Buffer.alloc(10))
    return ciudad
  }

  it('lee textos de cada red, portada y marcas por red', () => {
    const ciudad = preparar()
    let v = listLongVideos(db, ciudad, 'city').videos[0]
    expect(v.id).toBe('01 · Día 1')
    expect(v.captions).toEqual({ tiktok: 'Texto TikTok', instagram: 'Texto Instagram' })
    expect(v.thumbs).toEqual(['A'])
    expect(v.uploads).toEqual({ tiktok: null, instagram: null, youtube: null })
    expect(cityPending(v)).toBe(true)
    setLongUploaded(db, ciudad, '01 · Día 1', true, new Date('2026-11-03T12:00:00Z'), 'city', 'tiktok')
    setLongUploaded(db, ciudad, '01 · Día 1', true, new Date('2026-11-03T12:05:00Z'), 'city', 'instagram')
    setLongUploaded(db, ciudad, '01 · Día 1', true, new Date('2026-11-03T12:10:00Z'), 'city', 'youtube')
    v = listLongVideos(db, ciudad, 'city').videos[0]
    expect(v.uploads.tiktok).toBe('2026-11-03T12:00:00.000Z')
    expect(v.uploadedAt).toBe('2026-11-03T12:10:00.000Z')
    expect(cityPending(v)).toBe(false)
    setLongUploaded(db, ciudad, '01 · Día 1', false, new Date(), 'city', 'instagram')
    expect(cityPending(listLongVideos(db, ciudad, 'city').videos[0])).toBe(true)
    expect(() => setLongUploaded(db, ciudad, '01 · Día 1', true, new Date(), 'city', 'facebook')).toThrow('Red no válida.')
    expect(() => setLongUploaded(db, ciudad, '01 · Día 1', true, new Date(), 'city')).toThrow('Red no válida.')
    expect(resolveLongVideo(ciudad, '01 · Día 1')).toBe(path.join(ciudad, '01 · Día 1', 'dia-01.mp4'))
  })

  it('cifras de la ciudad: última fecha, VIP, siguiente meta; sin ciudad.json → null', () => {
    const ciudad = preparar()
    expect(readCityStats(ciudad)).toBeNull()
    expect(listLongVideos(db, ciudad, 'city').city).toBeNull()
    fs.writeFileSync(path.join(ciudad, 'ciudad.json'), JSON.stringify({
      gta6: '2026-11-19',
      metas: [{ vecinos: 100, obra: 'calles y farolas' }],
      cifras: [
        { fecha: '2026-11-04', tiktok: { seguidores: 120, comentarios: 35 }, youtube: { seguidores: 8, comentarios: 3 } },
        { fecha: '2026-11-03', tiktok: { seguidores: 1, comentarios: 1 } }
      ],
      vecinos: [
        { usuario: '@ana', red: 'instagram', vip: true },
        { usuario: '@luis', red: 'tiktok', vip: true },
        { usuario: '@pepe', red: 'youtube', vip: false }
      ]
    }))
    expect(readCityStats(ciudad)).toEqual({
      vecinos: 3,
      fecha: '2026-11-04',
      cifras: { tiktok: { seguidores: 120, comentarios: 35 }, instagram: null, youtube: { seguidores: 8, comentarios: 3 } },
      vip: [{ usuario: '@ana', red: 'instagram' }, { usuario: '@luis', red: 'tiktok' }],
      resto: 1,
      siguienteMeta: { vecinos: 100, obra: 'calles y farolas' },
      gta6: '2026-11-19'
    })
    fs.writeFileSync(path.join(ciudad, 'ciudad.json'), '{ roto')
    expect(readCityStats(ciudad)).toBeNull()
  })

  it('las otras secciones no cambian: sin textos por red ni cifras', () => {
    escribir('V1/v.mp4')
    const l = listLongVideos(db, carpeta)
    expect(l.city).toBeUndefined()
    expect(l.videos[0].captions).toEqual({})
    expect(l.videos[0].uploads).toEqual({})
  })
})
