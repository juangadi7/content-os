/**
 * «Cuentas»: qué correo usa cada canal, para no olvidarlo. Vive en <biblioteca>\..\PLAN\cuentas.json, que mantiene
 * Claude; la aplicación solo lo lee. Nunca guarda contraseñas: si el archivo trae algo parecido, se ignora.
 */
import fs from 'node:fs'
import { isPlatform, type Platform } from './format'

export interface AccountBookEntry {
  platform: Platform
  channel: string
  email: string
  note: string | null
}

export interface AccountBook {
  file: string | null
  updatedAt: string | null
  entries: AccountBookEntry[]
  /** Correos con sus canales, en el orden en que aparecen. */
  byEmail: { email: string; entries: AccountBookEntry[] }[]
  error: string | null
}

const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function loadAccountBook(file: string | null): AccountBook {
  const vacio: AccountBook = { file, updatedAt: null, entries: [], byEmail: [], error: null }
  if (!file || !fs.existsSync(file)) return vacio
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { actualizado?: unknown; cuentas?: unknown }
    if (!Array.isArray(j.cuentas)) return { ...vacio, error: 'cuentas.json no tiene la lista "cuentas".' }
    const entries: AccountBookEntry[] = []
    for (const c of j.cuentas as Record<string, unknown>[]) {
      const platform = texto(c?.plataforma)?.toLowerCase()
      const channel = texto(c?.canal)
      const email = texto(c?.correo)
      if (!platform || !isPlatform(platform) || !channel || !email) continue
      entries.push({ platform, channel, email, note: texto(c.nota) })
    }
    const byEmail: AccountBook['byEmail'] = []
    for (const e of entries) {
      const g = byEmail.find((x) => x.email.toLowerCase() === e.email.toLowerCase())
      if (g) g.entries.push(e)
      else byEmail.push({ email: e.email, entries: [e] })
    }
    return { file, updatedAt: texto(j.actualizado), entries, byEmail, error: null }
  } catch (e) {
    return { ...vacio, error: `No se pudo leer cuentas.json: ${(e as Error).message}` }
  }
}
