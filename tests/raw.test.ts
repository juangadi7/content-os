/** Material en bruto: listar lo que ocupa y quitarlo, con sus enlaces duros, sin tocar nada más. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatBytes } from '../src/core/format'
import { listRawFiles, removeRawFiles, windowsLinks } from '../src/core/raw'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

let base: string
let root: string
let descargas: string
let camp: CampaignFixture
let source: string

beforeEach(() => {
  base = tmpDir('cos_raw_')
  root = path.join(base, 'CAMPAIGNS')
  descargas = path.join(base, 'Descargas')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(descargas)
  camp = new CampaignFixture(root, 'DEMO', 'demo', 'Demo')
  camp.addClip({ n: 1, clipId: 'clp_a' })
  source = path.join(camp.dir, 'SOURCE')
  fs.rmSync(path.join(source, 'x.mp4'))
  // como hace el generador: el vídeo está en Descargas y SOURCE lo enlaza (mismo archivo, dos nombres)
  fs.writeFileSync(path.join(descargas, 'episodio.mp4'), 'E'.repeat(5000))
  fs.linkSync(path.join(descargas, 'episodio.mp4'), path.join(source, 'episodio.mp4'))
  fs.linkSync(path.join(descargas, 'episodio.mp4'), path.join(base, 'tercera-copia.mp4'))
  // otro vídeo que solo está en SOURCE
  fs.writeFileSync(path.join(source, 'suelto.mov'), 'S'.repeat(3000))
  // y un archivo de Descargas con el mismo nombre que NO es el mismo archivo
  fs.writeFileSync(path.join(descargas, 'suelto.mov'), 'otro contenido')
})
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

describe('material en bruto', () => {
  it('Windows dice todos los nombres de un archivo', () => {
    const nombres = windowsLinks(path.join(source, 'episodio.mp4')).map((p) => path.resolve(p).toLowerCase()).sort()
    expect(nombres).toEqual([path.join(descargas, 'episodio.mp4'), path.join(source, 'episodio.mp4'), path.join(base, 'tercera-copia.mp4')].map((p) => path.resolve(p).toLowerCase()).sort())
  })

  it('lista los vídeos, lo que ocupan y dónde más están', () => {
    const info = listRawFiles(source)
    expect(info.files.map((f) => [f.name, f.size, f.otherNames.length])).toEqual([['episodio.mp4', 5000, 2], ['suelto.mov', 3000, 0]])
    expect(info.totalBytes).toBe(8000)
    expect(info.files[0].otherNames.map((p) => path.basename(p)).sort()).toEqual(['episodio.mp4', 'tercera-copia.mp4'])
  })

  it('una carpeta SOURCE vacía o inexistente no da error', () => {
    expect(listRawFiles(path.join(base, 'no-existe'))).toMatchObject({ files: [], totalBytes: 0 })
  })

  it('quita todos los nombres del vídeo y nada más', async () => {
    const antes = fingerprint(camp.dir)
    const r = await removeRawFiles(source, (p) => fs.rmSync(p))
    expect(r.failed).toEqual([])
    expect(r.freedBytes).toBe(8000)
    expect(r.removed).toHaveLength(4)
    expect(fs.readdirSync(source)).toEqual([])
    expect(fs.existsSync(path.join(descargas, 'episodio.mp4'))).toBe(false)
    expect(fs.existsSync(path.join(base, 'tercera-copia.mp4'))).toBe(false)
    // el archivo de Descargas que solo compartía nombre sigue intacto
    expect(fs.readFileSync(path.join(descargas, 'suelto.mov'), 'utf8')).toBe('otro contenido')
    // del resto de la campaña no cambia ni un byte: clips, fichas, QA, informe, registro
    const despues = fingerprint(camp.dir)
    const cambiados = Object.keys(antes).filter((k) => antes[k] !== despues[k])
    expect(cambiados.every((k) => k.startsWith('SOURCE' + path.sep))).toBe(true)
    expect(fs.existsSync(camp.clipPath(String(camp.readMeta(1).filename)))).toBe(true)
    expect(listRawFiles(source).totalBytes).toBe(0)
  })

  it('si no se puede quitar un nombre, lo dice y no cuenta ese espacio como liberado', async () => {
    const r = await removeRawFiles(source, (p) => {
      if (path.basename(p) === 'tercera-copia.mp4') throw new Error('en uso')
      fs.rmSync(p)
    })
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error).toBe('en uso')
    expect(r.freedBytes).toBe(3000) // solo el vídeo suelto
    expect(fs.existsSync(path.join(source, 'episodio.mp4'))).toBe(true) // la campaña conserva su vídeo
  })

  it('tamaños legibles', () => {
    expect(formatBytes(39728447488)).toBe('37 GB')
    expect(formatBytes(1503238554)).toBe('1,4 GB')
    expect(formatBytes(524288000)).toBe('500 MB')
    expect(formatBytes(0)).toBe('0 MB')
  })
})
