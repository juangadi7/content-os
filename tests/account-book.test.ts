/** «Cuentas»: qué correo usa cada canal, leído de PLAN\cuentas.json. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { loadAccountBook } from '../src/core/account-book'
import { tmpDir } from './fixtures/builder'

let base: string
beforeEach(() => { base = tmpDir('cos_abook_') })
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

it('agrupa por correo, ignora filas incompletas o de plataformas desconocidas y nunca lee contraseñas', () => {
  const f = path.join(base, 'cuentas.json')
  fs.writeFileSync(f, JSON.stringify({ actualizado: '2026-10-16', cuentas: [
    { plataforma: 'tiktok', canal: '@democlipss', correo: 'cuenta1' },
    { plataforma: 'YouTube', canal: '@Shortsdemo', correo: 'Cuenta1', contraseña: 'no-se-lee' },
    { plataforma: 'youtube', canal: '@clipsparatodos', correo: 'cuenta2', nota: 'canal nuevo' },
    { plataforma: 'myspace', canal: 'x', correo: 'y' },
    { plataforma: 'youtube', correo: 'sin-canal' },
  ] }))
  const l = loadAccountBook(f)
  expect(l.error).toBeNull()
  expect(l.byEmail.map((g) => [g.email, g.entries.map((e) => `${e.platform}:${e.channel}`)])).toEqual([
    ['cuenta1', ['tiktok:@democlipss', 'youtube:@Shortsdemo']],
    ['cuenta2', ['youtube:@clipsparatodos']],
  ])
  expect(JSON.stringify(l)).not.toContain('no-se-lee')
  expect(loadAccountBook(path.join(base, 'no.json'))).toMatchObject({ entries: [], error: null })
  fs.writeFileSync(f, '{roto')
  expect(loadAccountBook(f).error).toContain('No se pudo leer')
})

it('el archivo real del plan se lee entero', () => {
  const real = 'C:/Users/juang/mundial-clipper/PLAN/cuentas.json'
  if (!fs.existsSync(real)) return
  const l = loadAccountBook(real)
  expect(l.error).toBeNull()
  expect(l.entries).toHaveLength(8)
})
