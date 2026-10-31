/**
 * «Fuera de campaña»: vídeos hechos sin campaña detrás (pruebas, montajes propios…), que no cobran por
 * visitas. Viven en una carpeta junto a la biblioteca (FUERA_DE_CAMPAÑA), una subcarpeta por grupo:
 *
 *   FUERA_DE_CAMPAÑA/<grupo>/grupo.json        (opcional) { name, source_url, notes }
 *   FUERA_DE_CAMPAÑA/<grupo>/<vídeo>.mp4
 *   FUERA_DE_CAMPAÑA/<grupo>/<vídeo>.json      (opcional) { title, description, hashtags[] }
 *
 * La aplicación solo lee esa carpeta. Lo único que guarda es en qué plataformas has marcado cada vídeo
 * como subido (tabla settings, clave "extra_upload:<id>").
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'

export const EXTRAS_FOLDER = 'FUERA_DE_CAMPAÑA'
export const EXTRA_PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const
export type ExtraPlatform = (typeof EXTRA_PLATFORMS)[number]

export interface ExtraVideo {
  /** "<grupo>/<archivo>.mp4": identifica el vídeo y es lo único que viaja a la interfaz. */
  id: string
  file: string
  title: string
  description: string | null
  hashtags: string[]
  sizeBytes: number
  modifiedAt: string
  /** plataforma -> fecha en que se marcó como subido */
  uploaded: Partial<Record<ExtraPlatform, string>>
}

export interface ExtraGroup {
  id: string
  name: string
  sourceUrl: string | null
  notes: string | null
  /** Canal del vídeo original (grupo.json "source_channel"). */
  channel: string | null
  /** Hay miniatura del vídeo original (miniatura.jpg o .png en la carpeta del grupo). */
  hasThumb: boolean
  /** Fecha del vídeo más reciente del grupo. */
  updatedAt: string
  videos: ExtraVideo[]
}

const MINIATURAS = ['miniatura.jpg', 'miniatura.jpeg', 'miniatura.png', 'miniatura.webp']

/** Ruta de la miniatura de un grupo, comprobando que el grupo es una subcarpeta directa de la carpeta. */
export function resolveExtraThumb(folder: string, groupId: unknown): string | null {
  if (typeof groupId !== 'string' || !groupId || groupId === '.' || groupId === '..' || /[\\/:]/.test(groupId)) return null
  const dir = path.join(path.resolve(folder), groupId)
  for (const m of MINIATURAS) {
    const ruta = path.join(dir, m)
    if (fs.existsSync(ruta)) return ruta
  }
  return null
}

export interface ExtrasView {
  folder: string
  exists: boolean
  groups: ExtraGroup[]
  total: number
}

const leerJson = (ruta: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(fs.readFileSync(ruta, 'utf8').replace(/^﻿/, ''))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const textoODefecto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
/** "003_250-logs-to-crash" -> "250 logs to crash" */
const tituloDeArchivo = (archivo: string) => archivo.replace(/\.mp4$/i, '').replace(/^\d+[_-]/, '').replace(/[_-]+/g, ' ').trim()

const clave = (id: string) => `extra_upload:${id}`
function marcas(db: DB, id: string): Partial<Record<ExtraPlatform, string>> {
  const fila = db.prepare('SELECT value FROM settings WHERE key = ?').get(clave(id)) as { value: string } | undefined
  if (!fila) return {}
  try {
    const v = JSON.parse(fila.value) as Record<string, unknown>
    return Object.fromEntries(EXTRA_PLATFORMS.filter((p) => typeof v[p] === 'string').map((p) => [p, v[p] as string]))
  } catch {
    return {}
  }
}

/** Lista la carpeta. Grupos y vídeos ordenados por nombre (los clips llevan número delante). */
export function listExtras(db: DB, folder: string): ExtrasView {
  if (!fs.existsSync(folder)) return { folder, exists: false, groups: [], total: 0 }
  const groups: ExtraGroup[] = []
  for (const g of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!g.isDirectory() || g.name.startsWith('.') || g.name.startsWith('_')) continue
    const dir = path.join(folder, g.name)
    const meta = leerJson(path.join(dir, 'grupo.json'))
    const videos: ExtraVideo[] = []
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !/\.mp4$/i.test(f.name)) continue
      const ruta = path.join(dir, f.name)
      const st = fs.statSync(ruta)
      const m = leerJson(ruta.replace(/\.mp4$/i, '.json'))
      const id = `${g.name}/${f.name}`
      videos.push({
        id,
        file: f.name,
        title: textoODefecto(m?.title) ?? tituloDeArchivo(f.name),
        description: textoODefecto(m?.description),
        hashtags: Array.isArray(m?.hashtags) ? (m!.hashtags as unknown[]).filter((h): h is string => typeof h === 'string') : [],
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        uploaded: marcas(db, id),
      })
    }
    if (!videos.length) continue
    videos.sort((a, b) => a.file.localeCompare(b.file, 'es', { numeric: true }))
    groups.push({
      id: g.name, name: textoODefecto(meta?.name) ?? g.name, sourceUrl: textoODefecto(meta?.source_url), notes: textoODefecto(meta?.notes),
      channel: textoODefecto(meta?.source_channel), hasThumb: resolveExtraThumb(folder, g.name) !== null,
      updatedAt: videos.map((v) => v.modifiedAt).sort().at(-1)!, videos,
    })
  }
  // como en Campañas: el más reciente primero
  groups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name, 'es', { numeric: true }))
  return { folder, exists: true, groups, total: groups.reduce((n, g) => n + g.videos.length, 0) }
}

/**
 * Ruta real de un vídeo a partir de su id, comprobando que es "<grupo>/<archivo>.mp4" dentro de la
 * carpeta: no se puede pedir ningún otro archivo del disco.
 */
export function resolveExtra(folder: string, id: unknown): string | null {
  if (typeof id !== 'string') return null
  const partes = id.split('/')
  if (partes.length !== 2 || partes.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p))) return null
  if (!/\.mp4$/i.test(partes[1])) return null
  const base = path.resolve(folder)
  const ruta = path.resolve(base, partes[0], partes[1])
  if (path.dirname(path.dirname(ruta)) !== base) return null
  return fs.existsSync(ruta) ? ruta : null
}

/** Marca o desmarca un vídeo como subido a una plataforma. */
export function setExtraUploaded(db: DB, folder: string, id: unknown, platform: unknown, uploaded: boolean, now = new Date()): void {
  if (!resolveExtra(folder, id)) throw new Error('El vídeo no existe.')
  if (!EXTRA_PLATFORMS.includes(platform as ExtraPlatform)) throw new Error('Plataforma no válida.')
  const actual = marcas(db, id as string)
  if (uploaded) actual[platform as ExtraPlatform] = now.toISOString()
  else delete actual[platform as ExtraPlatform]
  if (Object.keys(actual).length) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(clave(id as string), JSON.stringify(actual))
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run(clave(id as string))
  }
}

/**
 * Carpetas de grupo que se mandan a la Papelera: una (por su id) o todas. Solo subcarpetas directas de
 * FUERA_DE_CAMPAÑA. Las marcas de subido de esos vídeos se olvidan.
 */
export async function trashExtras(db: DB, folder: string, groupId: string | null, trash: (dir: string) => Promise<void>): Promise<number> {
  if (!fs.existsSync(folder)) return 0
  const base = path.resolve(folder)
  const grupos = fs.readdirSync(base, { withFileTypes: true })
    .filter((g) => g.isDirectory() && !g.name.startsWith('.') && !g.name.startsWith('_'))
    .map((g) => g.name)
  if (groupId !== null && (typeof groupId !== 'string' || !grupos.includes(groupId))) throw new Error('Ese grupo no existe.')
  let n = 0
  for (const g of groupId === null ? grupos : [groupId]) {
    await trash(path.join(base, g))
    db.prepare('DELETE FROM settings WHERE substr(key, 1, ?) = ?').run(`extra_upload:${g}/`.length, `extra_upload:${g}/`)
    n++
  }
  return n
}
