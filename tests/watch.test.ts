/** Vigilancia de la biblioteca: avisa una vez cuando el generador termina de escribir. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRelevantChange, watchLibraries, type LibraryWatcher } from '../src/main/watch'
import { fingerprint, tmpDir } from './fixtures/builder'

let base: string
let root: string
let w: LibraryWatcher | null = null
let avisos = 0
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))
const vigilar = (quietMs = 150, maxWaitMs = 5000) => {
  w = watchLibraries({ quietMs, maxWaitMs, onChange: () => avisos++ })
  w.setRoots([root])
  return w
}

beforeEach(() => {
  base = tmpDir('cos_watch_')
  root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(path.join(root, 'VIEJA', 'METADATA'), { recursive: true })
  fs.mkdirSync(path.join(root, 'VIEJA', '_work'))
  fs.mkdirSync(path.join(root, 'VIEJA', 'SOURCE'))
  avisos = 0
})
afterEach(() => {
  w?.close()
  w = null
  fs.rmSync(base, { recursive: true, force: true })
})

describe('vigilancia de la biblioteca', () => {
  it('distingue lo que importa de lo que no', () => {
    expect(isRelevantChange('NUEVA')).toBe(true)
    expect(isRelevantChange('NUEVA\\campaign.json')).toBe(true)
    expect(isRelevantChange('NUEVA\\METADATA\\clip_001.json')).toBe(true)
    expect(isRelevantChange('NUEVA\\CLIPS\\001_x.mp4')).toBe(true)
    expect(isRelevantChange(null)).toBe(true)
    expect(isRelevantChange('NUEVA', 'change')).toBe(false)
    expect(isRelevantChange('NUEVA\\campaign.json', 'change')).toBe(true)
    expect(isRelevantChange('NUEVA\\_work\\transcripcion.json')).toBe(false)
    expect(isRelevantChange('NUEVA\\SOURCE\\episodio.mp4')).toBe(false)
    expect(isRelevantChange('NUEVA/FAILED/009.mp4')).toBe(false)
    expect(isRelevantChange('NUEVA\\CLIPS\\001_x.mp4.tmp')).toBe(false)
  })

  it('una ráfaga de cambios (campaña nueva con sus clips) da un solo aviso, cuando se calma', async () => {
    vigilar()
    await esperar(100)
    fs.mkdirSync(path.join(root, 'NUEVA', 'METADATA'), { recursive: true })
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(root, 'NUEVA', 'METADATA', `clip_00${i}.json`), '{}')
      await esperar(30)
    }
    expect(avisos).toBe(0) // aún escribiendo
    await esperar(500)
    expect(avisos).toBe(1)
    // otro cambio más tarde, otro aviso
    fs.writeFileSync(path.join(root, 'VIEJA', 'METADATA', 'clip_001.json'), '{}')
    await esperar(500)
    expect(avisos).toBe(2)
  })

  it('el trabajo interno del generador y el material en bruto no despiertan nada', async () => {
    vigilar()
    await esperar(500) // Windows puede entregar tarde los eventos de crear las carpetas de la prueba
    avisos = 0
    fs.writeFileSync(path.join(root, 'VIEJA', '_work', 'a.json'), '{}')
    fs.writeFileSync(path.join(root, 'VIEJA', 'SOURCE', 'video.mp4'), 'x')
    await esperar(500)
    expect(avisos).toBe(0)
  })

  it('si el generador no para de escribir, avisa igualmente al cabo del máximo', async () => {
    vigilar(300, 700)
    await esperar(100)
    const fin = Date.now() + 1300
    while (Date.now() < fin) {
      fs.writeFileSync(path.join(root, 'VIEJA', 'METADATA', 'clip_001.json'), String(Date.now()))
      await esperar(60)
    }
    expect(avisos).toBeGreaterThanOrEqual(1)
  })

  it('una carpeta que no existe no rompe nada y se engancha cuando aparece; cerrar deja de avisar', async () => {
    const otra = path.join(base, 'OTRA')
    const v = vigilar()
    v.setRoots([root, otra])
    expect(v.watching()).toEqual([path.resolve(root)])
    fs.mkdirSync(otra)
    v.setRoots([root, otra])
    expect(v.watching()).toEqual([path.resolve(root), path.resolve(otra)])
    v.setRoots([otra])
    expect(v.watching()).toEqual([path.resolve(otra)])
    v.close()
    fs.mkdirSync(path.join(otra, 'X'))
    await esperar(400)
    expect(avisos).toBe(0)
  })

  it('solo mira: no crea ni cambia ningún archivo', async () => {
    const antes = fingerprint(root)
    vigilar()
    await esperar(300)
    w!.close()
    expect(fingerprint(root)).toEqual(antes)
  })
})
