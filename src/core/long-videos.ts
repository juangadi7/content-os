/**
 * «Vídeos largos»: vídeos de YouTube de los canales propios (p. ej. MiCanal), uno por carpeta,
 * con sus 3 miniaturas y sus 3 títulos para «Probar y comparar». Viven junto a la biblioteca:
 *
 *   VIDEOS_LARGOS/<vídeo>/video.json       { channel, titles: [A, B, C], description, hashtags[], pinned_comment, schedule, notes, file }
 *   VIDEOS_LARGOS/<vídeo>/<archivo>.mp4    el vídeo (normalmente un enlace duro al render final)
 *   VIDEOS_LARGOS/<vídeo>/miniatura_A.jpg  ... miniatura_B.jpg, miniatura_C.jpg (también .png / .webp)
 *   VIDEOS_LARGOS/<vídeo>/<archivo>.srt    (opcional) subtítulos para subir
 *
 * La aplicación solo lee esa carpeta (la escribe el generador de cada canal). Lo único que guarda es la
 * fecha en que marcaste el vídeo como subido a YouTube (tabla settings, clave "long_upload:<id>").
 *
 * «Vídeos de música» (vídeos de ambiente de horas: música + lluvia, etc.) usa exactamente la misma estructura
 * en otra carpeta, VIDEOS_MUSICA, con sus marcas de subido aparte (clave "music_upload:<id>").
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'

export const LONG_FOLDER = 'VIDEOS_LARGOS'
export const MUSIC_FOLDER = 'VIDEOS_MUSICA'
/** Sección: «Vídeos largos» (long) o «Vídeos de música» (music). */
export type LongKind = 'long' | 'music'
export const asLongKind = (v: unknown): LongKind => (v === 'music' ? 'music' : 'long')
export const LONG_LETTERS = ['A', 'B', 'C'] as const
export type LongLetter = (typeof LONG_LETTERS)[number]

export interface LongTitle {
  letter: LongLetter
  text: string
}

export interface LongVideo {
  /** Nombre de la carpeta del vídeo: lo identifica y es lo único que viaja a la interfaz. */
  id: string
  /** Archivo MP4 dentro de la carpeta (null si aún no está). */
  file: string | null
  channel: string | null
  /** Hasta 3 títulos, en orden A, B, C. */
  titles: LongTitle[]
  /** Letras de las miniaturas que hay en la carpeta, en orden. */
  thumbs: LongLetter[]
  description: string | null
  hashtags: string[]
  pinnedComment: string | null
  schedule: string | null
  notes: string | null
  /** Hay subtítulos (.srt) junto al vídeo. */
  hasSubtitles: boolean
  sizeBytes: number | null
  modifiedAt: string
  /** Fecha en que se marcó como subido a YouTube; null si no. */
  uploadedAt: string | null
}

export interface LongVideosView {
  folder: string
  exists: boolean
  videos: LongVideo[]
  total: number
}

const IMAGENES = ['.jpg', '.jpeg', '.png', '.webp']

function leerJson(ruta: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(ruta, 'utf8').replace(/^﻿/, '')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const clave = (id: string, kind: LongKind) => `${kind}_upload:${id}`

/** Carpeta de un vídeo, comprobando que es una subcarpeta directa (nada de "..", rutas ni ocultas). */
function carpetaDe(folder: string, id: unknown): string | null {
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/:]/.test(id) || id.startsWith('.') || id.startsWith('_')) return null
  const dir = path.join(path.resolve(folder), id)
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null
}

/** MP4 del vídeo: el que diga video.json ("file") o, si no, el único/mayor MP4 de la carpeta. */
function mp4De(dir: string, meta: Record<string, unknown> | null): string | null {
  const pedido = texto(meta?.file)
  if (pedido && !/[\\/:]/.test(pedido) && /\.mp4$/i.test(pedido) && fs.existsSync(path.join(dir, pedido))) return pedido
  const mp4 = fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && /\.mp4$/i.test(f.name))
  if (!mp4.length) return null
  return mp4.map((f) => f.name).sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0]
}

function miniaturaDe(dir: string, letra: LongLetter): string | null {
  for (const ext of IMAGENES) {
    const ruta = path.join(dir, `miniatura_${letra}${ext}`)
    if (fs.existsSync(ruta)) return ruta
  }
  // la principal también puede llamarse miniatura.jpg
  if (letra === 'A') {
    for (const ext of IMAGENES) {
      const ruta = path.join(dir, `miniatura${ext}`)
      if (fs.existsSync(ruta)) return ruta
    }
  }
  return null
}

function subido(db: DB, id: string, kind: LongKind): string | null {
  const fila = db.prepare('SELECT value FROM settings WHERE key = ?').get(clave(id, kind)) as { value: string } | undefined
  return fila && !Number.isNaN(Date.parse(fila.value)) ? fila.value : null
}

/** Lista la carpeta. El vídeo más reciente primero. */
export function listLongVideos(db: DB, folder: string, kind: LongKind = 'long'): LongVideosView {
  if (!fs.existsSync(folder)) return { folder, exists: false, videos: [], total: 0 }
  const videos: LongVideo[] = []
  for (const g of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!g.isDirectory() || g.name.startsWith('.') || g.name.startsWith('_')) continue
    const dir = path.join(folder, g.name)
    const meta = leerJson(path.join(dir, 'video.json'))
    const file = mp4De(dir, meta)
    if (!file && !meta) continue
    const titulos = Array.isArray(meta?.titles) ? (meta!.titles as unknown[]).map(texto) : []
    const titles: LongTitle[] = []
    titulos.slice(0, 3).forEach((t, i) => t && titles.push({ letter: LONG_LETTERS[i], text: t }))
    const st = file ? fs.statSync(path.join(dir, file)) : fs.statSync(dir)
    videos.push({
      id: g.name,
      file,
      channel: texto(meta?.channel),
      titles,
      thumbs: LONG_LETTERS.filter((l) => miniaturaDe(dir, l) !== null),
      description: texto(meta?.description),
      hashtags: Array.isArray(meta?.hashtags) ? (meta!.hashtags as unknown[]).filter((h): h is string => typeof h === 'string' && h.trim() !== '') : [],
      pinnedComment: texto(meta?.pinned_comment),
      schedule: texto(meta?.schedule),
      notes: texto(meta?.notes),
      hasSubtitles: file ? fs.existsSync(path.join(dir, file.replace(/\.mp4$/i, '.srt'))) : false,
      sizeBytes: file ? st.size : null,
      modifiedAt: st.mtime.toISOString(),
      uploadedAt: subido(db, g.name, kind)
    })
  }
  videos.sort((a, b) => b.id.localeCompare(a.id, 'es', { numeric: true }))
  return { folder, exists: true, videos, total: videos.length }
}

/** Ruta real del MP4 de un vídeo; null si el id no es una carpeta de vídeo o no tiene MP4. */
export function resolveLongVideo(folder: string, id: unknown): string | null {
  const dir = carpetaDe(folder, id)
  if (!dir) return null
  const file = mp4De(dir, leerJson(path.join(dir, 'video.json')))
  return file ? path.join(dir, file) : null
}

/** Ruta real de una miniatura (A, B o C) de un vídeo. */
export function resolveLongThumb(folder: string, id: unknown, letter: unknown): string | null {
  if (!LONG_LETTERS.includes(letter as LongLetter)) return null
  const dir = carpetaDe(folder, id)
  return dir ? miniaturaDe(dir, letter as LongLetter) : null
}

/** Carpeta de un vídeo (para abrirla en el Explorador). */
export function resolveLongFolder(folder: string, id: unknown): string | null {
  return carpetaDe(folder, id)
}

/** Marca o desmarca un vídeo como subido a YouTube. */
export function setLongUploaded(db: DB, folder: string, id: unknown, uploaded: boolean, now = new Date(), kind: LongKind = 'long'): void {
  if (!carpetaDe(folder, id)) throw new Error('El vídeo no existe.')
  if (uploaded) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(clave(id as string, kind), now.toISOString())
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run(clave(id as string, kind))
  }
}
