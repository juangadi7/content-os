/**
 * Acceso a los archivos del generador. SOLO LECTURA: en este módulo no hay ninguna
 * llamada que cree, modifique, mueva o borre archivos.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'

export type JsonRead = { ok: true; value: unknown } | { ok: false; missing: boolean; error: string }

export function readJson(ruta: string): JsonRead {
  let texto: string
  try {
    texto = fs.readFileSync(ruta, 'utf8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return { ok: false, missing: err.code === 'ENOENT', error: err.message }
  }
  try {
    return { ok: true, value: JSON.parse(texto.replace(/^﻿/, '')) }
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error).message }
  }
}

export function isFile(ruta: string | null | undefined): boolean {
  if (!ruta) return false
  try {
    return fs.statSync(ruta).isFile()
  } catch {
    return false
  }
}

export function isDir(ruta: string): boolean {
  try {
    return fs.statSync(ruta).isDirectory()
  } catch {
    return false
  }
}

export function listDir(ruta: string): string[] {
  try {
    return fs.readdirSync(ruta).sort()
  } catch {
    return []
  }
}

export function sha256File(ruta: string): string {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(ruta, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let n: number
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

export interface HashStats {
  computed: number
  reused: number
}

/** SHA-256 de un archivo; se reutiliza el guardado si tamaño y fecha no han cambiado. */
export function cachedSha256(db: DB, ruta: string, now: string, stats?: HashStats): { sha256: string; size: number; mtimeMs: number } {
  const st = fs.statSync(ruta)
  const size = st.size
  const mtimeMs = Math.round(st.mtimeMs)
  const fila = db.prepare('SELECT size, mtime_ms, sha256 FROM file_hashes WHERE path = ?').get(ruta) as
    | { size: number; mtime_ms: number; sha256: string }
    | undefined
  if (fila && fila.size === size && fila.mtime_ms === mtimeMs) {
    if (stats) stats.reused++
    return { sha256: fila.sha256, size, mtimeMs }
  }
  const sha256 = sha256File(ruta)
  if (stats) stats.computed++
  db.prepare(
    `INSERT INTO file_hashes (path, size, mtime_ms, sha256, hashed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
       sha256 = excluded.sha256, hashed_at = excluded.hashed_at`
  ).run(ruta, size, mtimeMs, sha256, now)
  return { sha256, size, mtimeMs }
}

export type ResolvedVia = 'campaign_clips' | 'full_path' | 'filename_search' | 'sha_search'
export type FileState = 'ok' | 'missing' | 'hash_mismatch' | 'unverified'

export interface ResolvedFile {
  path: string | null
  via: ResolvedVia | null
  state: FileState
  size: number | null
  mtimeMs: number | null
  sha256: string | null
}

/**
 * Localiza el MP4 de un clip, por este orden:
 *   1. <campaña>\CLIPS\<filename>     2. full_path de la ficha
 *   3. mismo nombre dentro de CLIPS   4. mismo sha256 dentro de CLIPS
 * `otros` son los nombres de archivo que pertenecen a otras fichas de la campaña (no se
 * consideran candidatos en la búsqueda por hash).
 */
export function resolveClipFile(
  db: DB,
  campaignDir: string,
  clip: { filename: string | null; fullPath: string | null; sha256: string | null },
  otros: Set<string>,
  now: string,
  stats?: HashStats
): ResolvedFile {
  const clipsDir = path.join(campaignDir, 'CLIPS')
  let ruta: string | null = null
  let via: ResolvedVia | null = null

  if (clip.filename && isFile(path.join(clipsDir, clip.filename))) {
    ruta = path.join(clipsDir, clip.filename)
    via = 'campaign_clips'
  } else if (isFile(clip.fullPath)) {
    ruta = clip.fullPath as string
    via = 'full_path'
  } else {
    const entradas = listDir(clipsDir)
    const igual = clip.filename ? entradas.find((f) => f.toLowerCase() === clip.filename!.toLowerCase()) : undefined
    if (igual && isFile(path.join(clipsDir, igual))) {
      ruta = path.join(clipsDir, igual)
      via = 'filename_search'
    } else if (clip.sha256) {
      for (const f of entradas) {
        if (!f.toLowerCase().endsWith('.mp4') || otros.has(f.toLowerCase())) continue
        const p = path.join(clipsDir, f)
        if (!isFile(p)) continue
        if (cachedSha256(db, p, now, stats).sha256 === clip.sha256) {
          ruta = p
          via = 'sha_search'
          break
        }
      }
    }
  }

  if (!ruta) return { path: null, via: null, state: 'missing', size: null, mtimeMs: null, sha256: null }
  const h = cachedSha256(db, ruta, now, stats)
  const state: FileState = !clip.sha256 ? 'unverified' : h.sha256 === clip.sha256 ? 'ok' : 'hash_mismatch'
  return { path: ruta, via, state, size: h.size, mtimeMs: h.mtimeMs, sha256: h.sha256 }
}
