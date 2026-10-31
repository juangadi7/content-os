/** «Fuera de campaña»: lectura de la carpeta, rutas seguras y marcas de subido. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { listExtras, resolveExtra, resolveExtraThumb, setExtraUploaded, trashExtras } from '../src/core/extras'
import { tmpDir } from './fixtures/builder'

let base: string
let carpeta: string
let db: DB
const escribir = (rel: string, contenido: string | Buffer = Buffer.alloc(2048)) => {
  const ruta = path.join(carpeta, rel)
  fs.mkdirSync(path.dirname(ruta), { recursive: true })
  fs.writeFileSync(ruta, contenido)
}

beforeEach(() => {
  base = tmpDir('cos_extras_')
  carpeta = path.join(base, 'FUERA_DE_CAMPAÑA')
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('lectura de la carpeta', () => {
  it('sin carpeta: vacío, sin error', () => {
    expect(listExtras(db, carpeta)).toEqual({ folder: carpeta, exists: false, groups: [], total: 0 })
  })

  it('agrupa por subcarpeta, ordena por número y lee los textos de cada vídeo', () => {
    escribir('Roblox/grupo.json', JSON.stringify({ name: 'Roblox · 99 Nights', source_url: 'https://www.youtube.com/watch?v=0-DAC3vFIyE', notes: 'Emoji: Google Noto (CC BY 4.0)' }))
    escribir('Roblox/10_ultimo.mp4')
    escribir('Roblox/2_segundo.mp4')
    escribir('Roblox/2_segundo.json', JSON.stringify({ title: 'Can logs crash the game?', description: 'Myth tested.', hashtags: ['roblox', '#99nights', 7] }))
    escribir('Roblox/notas.txt', 'no es un vídeo')
    escribir('Vacía/leeme.txt', 'sin vídeos')
    escribir('_trabajo/borrador.mp4')
    const v = listExtras(db, carpeta)
    expect(v.total).toBe(2)
    expect(v.groups.map((g) => [g.id, g.name, g.sourceUrl, g.notes])).toEqual([['Roblox', 'Roblox · 99 Nights', 'https://www.youtube.com/watch?v=0-DAC3vFIyE', 'Emoji: Google Noto (CC BY 4.0)']])
    const [a, b] = v.groups[0].videos
    expect([a.id, a.title, a.description, a.hashtags]).toEqual(['Roblox/2_segundo.mp4', 'Can logs crash the game?', 'Myth tested.', ['roblox', '#99nights']])
    // sin .json, el título sale del nombre del archivo
    expect([b.id, b.title, b.description, b.hashtags, b.sizeBytes]).toEqual(['Roblox/10_ultimo.mp4', 'ultimo', null, [], 2048])
  })

  it('cada vídeo original lleva su miniatura y su canal; el más reciente primero', () => {
    escribir('Viejo/1_a.mp4')
    escribir('Nuevo/1_b.mp4')
    escribir('Nuevo/miniatura.jpg', 'jpg')
    escribir('Nuevo/grupo.json', JSON.stringify({ name: 'Rare Anomalies', source_channel: 'WOLF Roblox' }))
    fs.utimesSync(path.join(carpeta, 'Viejo', '1_a.mp4'), new Date('2026-10-01'), new Date('2026-10-01'))
    const v = listExtras(db, carpeta)
    expect(v.groups.map((g) => [g.id, g.name, g.channel, g.hasThumb])).toEqual([['Nuevo', 'Rare Anomalies', 'WOLF Roblox', true], ['Viejo', 'Viejo', null, false]])
    expect(resolveExtraThumb(carpeta, 'Nuevo')).toBe(path.join(carpeta, 'Nuevo', 'miniatura.jpg'))
    for (const malo of ['Viejo', '..', '../Nuevo', 'Nuevo/miniatura.jpg', '', null]) expect(resolveExtraThumb(carpeta, malo)).toBeNull()
  })

  it('un .json roto no impide ver el vídeo', () => {
    escribir('G/1_a.mp4')
    escribir('G/1_a.json', '{ esto no es json')
    expect(listExtras(db, carpeta).groups[0].videos[0].title).toBe('a')
  })
})

describe('solo se puede pedir un vídeo de la carpeta', () => {
  it('acepta "<grupo>/<archivo>.mp4" existente y nada más', () => {
    escribir('G/1_a.mp4')
    escribir('G/1_a.json', '{}')
    fs.writeFileSync(path.join(base, 'fuera.mp4'), 'x')
    expect(resolveExtra(carpeta, 'G/1_a.mp4')).toBe(path.join(carpeta, 'G', '1_a.mp4'))
    for (const malo of ['G/1_a.json', 'G/no-existe.mp4', '../fuera.mp4', 'G/../../fuera.mp4', 'G\\..\\..\\fuera.mp4', 'G/sub/1_a.mp4', '1_a.mp4', 'C:/x/1_a.mp4', '/G/1_a.mp4', '', null, 3]) {
      expect(resolveExtra(carpeta, malo)).toBeNull()
    }
  })
})

describe('marcar como subido', () => {
  it('se guarda por plataforma, se puede deshacer y no toca el vídeo', () => {
    escribir('G/1_a.mp4', 'video')
    const antes = fs.statSync(path.join(carpeta, 'G', '1_a.mp4')).mtimeMs
    setExtraUploaded(db, carpeta, 'G/1_a.mp4', 'youtube', true, new Date('2026-10-15T12:00:00Z'))
    setExtraUploaded(db, carpeta, 'G/1_a.mp4', 'tiktok', true, new Date('2026-10-15T13:00:00Z'))
    expect(listExtras(db, carpeta).groups[0].videos[0].uploaded).toEqual({ youtube: '2026-10-15T12:00:00.000Z', tiktok: '2026-10-15T13:00:00.000Z' })
    setExtraUploaded(db, carpeta, 'G/1_a.mp4', 'youtube', false)
    setExtraUploaded(db, carpeta, 'G/1_a.mp4', 'tiktok', false)
    expect(listExtras(db, carpeta).groups[0].videos[0].uploaded).toEqual({})
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'extra_upload:%'").get()).toEqual({ n: 0 })
    expect(fs.statSync(path.join(carpeta, 'G', '1_a.mp4')).mtimeMs).toBe(antes)
    expect(fs.readFileSync(path.join(carpeta, 'G', '1_a.mp4'), 'utf8')).toBe('video')
  })

  it('eliminar: un grupo o todos, a la Papelera, y se olvidan sus marcas', async () => {
    escribir('Uno/1_a.mp4')
    escribir('Dos/1_b.mp4')
    escribir('_trabajo/x.mp4')
    setExtraUploaded(db, carpeta, 'Uno/1_a.mp4', 'youtube', true)
    setExtraUploaded(db, carpeta, 'Dos/1_b.mp4', 'tiktok', true)
    const movidas: string[] = []
    const papelera = async (dir: string) => {
      movidas.push(path.basename(dir))
      fs.rmSync(dir, { recursive: true })
    }
    await expect(trashExtras(db, carpeta, '../fuera', papelera)).rejects.toThrow('Ese grupo no existe.')
    expect(await trashExtras(db, carpeta, 'Uno', papelera)).toBe(1)
    expect(listExtras(db, carpeta).groups.map((g) => g.id)).toEqual(['Dos'])
    expect(db.prepare("SELECT key FROM settings WHERE key LIKE 'extra_upload:%'").all()).toEqual([{ key: 'extra_upload:Dos/1_b.mp4' }])
    expect(await trashExtras(db, carpeta, null, papelera)).toBe(1)
    expect(movidas).toEqual(['Uno', 'Dos'])
    expect(listExtras(db, carpeta).total).toBe(0)
    // la carpeta de trabajo (empieza por _) no se toca
    expect(fs.existsSync(path.join(carpeta, '_trabajo', 'x.mp4'))).toBe(true)
  })

  it('rechaza vídeos que no existen y plataformas desconocidas', () => {
    escribir('G/1_a.mp4')
    expect(() => setExtraUploaded(db, carpeta, '../x.mp4', 'youtube', true)).toThrow('El vídeo no existe.')
    expect(() => setExtraUploaded(db, carpeta, 'G/1_a.mp4', 'facebook', true)).toThrow('Plataforma no válida.')
  })
})
