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
 *
 * «Vídeos de la ciudad» (proyecto «La Ciudad de Todos»: un vídeo al día en TikTok, Instagram y YouTube) usa la
 * misma estructura en VIDEOS_CIUDAD, una carpeta por día (la escribe Ciudad seguidores/tools/content_os.mjs):
 *   video.json  { channel, titles: [título de YouTube], description, captions: { tiktok, instagram }, hashtags, schedule, notes, file }
 *   miniatura_A.png  la portada del día
 *   ciudad.json (en la raíz de VIDEOS_CIUDAD)  copia del registro: cifras de cada red, vecinos, VIP, metas
 * Las marcas de subido van por red: "city_upload:<id>:<tiktok|instagram|youtube>".
 *
 * «Historias Roblox» (Shorts estilo @RakoEspanol, hechos en Desktop/Cosas IA/Historias Roblox) usa la misma
 * estructura que música en VIDEOS_ROBLOX (la escribe Historias Roblox/tools/content_os.py), con su propia marca
 * de subido a YouTube ("roblox_upload:<id>").
 *
 * «Curiosidades» (Shorts de curiosidades estilo @resultaaquee, hechos en Desktop/Cosas IA/Canal curiosidades) usa la
 * misma estructura en VIDEOS_CURIOSIDADES (la escribe Canal curiosidades/tools/content_os.mjs), marca "curio_upload:<id>".
 *
 * «GTA 6» (serie de Shorts de noticias de GTA 6, hechos también en Canal curiosidades) usa la misma estructura en
 * VIDEOS_GTA6 (la escribe el mismo content_os.mjs para los vídeos de la serie), marca "gta_upload:<id>".
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { asOwnChannel, asOwnPlatform, ownUploads, setOwnPost, type OwnPlatform } from './own-channels'

export const LONG_FOLDER = 'VIDEOS_LARGOS'
export const MUSIC_FOLDER = 'VIDEOS_MUSICA'
export const CITY_FOLDER = 'VIDEOS_CIUDAD'
export const ROBLOX_FOLDER = 'VIDEOS_ROBLOX'
export const CURIO_FOLDER = 'VIDEOS_CURIOSIDADES'
export const GTA_FOLDER = 'VIDEOS_GTA6'
/** Sección: «Vídeos largos» (long), «Vídeos de música» (music), «Vídeos de la ciudad» (city) «Historias Roblox» (roblox), «Curiosidades» (curio) o «GTA 6» (gta). */
export type LongKind = 'long' | 'music' | 'city' | 'roblox' | 'curio' | 'gta'
export const asLongKind = (v: unknown): LongKind => (v === 'music' || v === 'city' || v === 'roblox' || v === 'curio' || v === 'gta' ? v : 'long')
/** Redes donde se sube cada vídeo de la ciudad. */
export const CITY_PLATFORMS = ['tiktok', 'instagram', 'youtube'] as const
export type CityPlatform = (typeof CITY_PLATFORMS)[number]
export const asCityPlatform = (v: unknown): CityPlatform | null => (CITY_PLATFORMS.includes(v as CityPlatform) ? (v as CityPlatform) : null)

/** Cifras de la ciudad (de VIDEOS_CIUDAD/ciudad.json). */
export interface CityStats {
  vecinos: number
  /** Última fecha con cifras (null si aún no hay). */
  fecha: string | null
  cifras: Record<CityPlatform, { seguidores: number; comentarios: number } | null>
  vip: { usuario: string; red: string }[]
  /** Vecinos que no son VIP. */
  resto: number
  siguienteMeta: { vecinos: number; obra: string } | null
  /** Fecha de GTA 6 (cuenta atrás). */
  gta6: string | null
}
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
  /** Solo en la ciudad: texto para TikTok e Instagram. */
  captions: Partial<Record<CityPlatform, string>>
  /** Solo en la ciudad: fecha de subida en cada red (null si no). */
  uploads: Partial<Record<CityPlatform, string | null>>
  /** Solo en Curiosidades: programado en Metricool para esta fecha («2026-11-18T10:00»); ya no está «por subir». */
  scheduledAt?: string | null
}

export interface LongVideosView {
  folder: string
  exists: boolean
  videos: LongVideo[]
  total: number
  /** Solo en la ciudad: sus cifras (null si no hay ciudad.json). */
  city?: CityStats | null
  /** Solo en Curiosidades: avisos de la cola de Metricool (en rojo). */
  alerts?: string[]
  /** Solo en Curiosidades: cuándo se actualizó la cola de Metricool (null si no hay cola). */
  queueUpdatedAt?: string | null
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
const clave = (id: string, kind: LongKind, plat?: CityPlatform | null) => `${kind}_upload:${id}${plat ? `:${plat}` : ''}`

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

function subido(db: DB, id: string, kind: LongKind, plat?: CityPlatform | null): string | null {
  const fila = db.prepare('SELECT value FROM settings WHERE key = ?').get(clave(id, kind, plat)) as { value: string } | undefined
  return fila && !Number.isNaN(Date.parse(fila.value)) ? fila.value : null
}

/** Lista la carpeta. El vídeo más reciente primero. */
export function listLongVideos(db: DB, folder: string, kind: LongKind = 'long'): LongVideosView {
  if (!fs.existsSync(folder)) return { folder, exists: false, videos: [], total: 0 }
  const videos: LongVideo[] = []
  // canales propios (GTA 6, Curiosidades, Roblox): las subidas van por red, en own_posts
  const propio = asOwnChannel(kind)
  const subidasPropias = propio ? ownUploads(db, propio) : null
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
      uploadedAt: subidasPropias
        ? Object.values(subidasPropias.get(g.name) ?? {}).sort()[0] ?? null
        : kind === 'city' ? subido(db, g.name, kind, 'youtube') : subido(db, g.name, kind),
      captions: kind === 'city' ? captionsDe(meta) : {},
      uploads: subidasPropias
        ? Object.fromEntries(CITY_PLATFORMS.map((p) => [p, subidasPropias.get(g.name)?.[p as OwnPlatform] ?? null]))
        : kind === 'city' ? Object.fromEntries(CITY_PLATFORMS.map((p) => [p, subido(db, g.name, kind, p)])) : {}
    })
  }
  videos.sort((a, b) => b.id.localeCompare(a.id, 'es', { numeric: true }))
  return { folder, exists: true, videos, total: videos.length, ...(kind === 'city' ? { city: readCityStats(folder) } : {}) }
}

function captionsDe(meta: Record<string, unknown> | null): Partial<Record<CityPlatform, string>> {
  const c = meta?.captions
  if (!c || typeof c !== 'object') return {}
  const out: Partial<Record<CityPlatform, string>> = {}
  for (const p of CITY_PLATFORMS) {
    const t = texto((c as Record<string, unknown>)[p])
    if (t) out[p] = t
  }
  return out
}

/** Un vídeo de la ciudad está pendiente si falta marcarlo en alguna red. (En los canales propios, «subido» = en alguna red.) */
export const cityPending = (v: LongVideo) => CITY_PLATFORMS.some((p) => !v.uploads[p])

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Lee VIDEOS_CIUDAD/ciudad.json (copia del registro de la ciudad). null si no está o no se entiende. */
export function readCityStats(folder: string): CityStats | null {
  const d = leerJson(path.join(folder, 'ciudad.json'))
  if (!d) return null
  const vecinos = Array.isArray(d.vecinos) ? (d.vecinos as Record<string, unknown>[]).filter((v) => v && typeof v === 'object') : []
  const filas = Array.isArray(d.cifras) ? (d.cifras as Record<string, unknown>[]).filter((c) => c && typeof c.fecha === 'string') : []
  const ult = filas.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))).at(-1) ?? null
  const cifras = Object.fromEntries(CITY_PLATFORMS.map((p) => {
    const c = ult?.[p] as Record<string, unknown> | undefined
    return [p, c && typeof c === 'object' ? { seguidores: num(c.seguidores), comentarios: num(c.comentarios) } : null]
  })) as CityStats['cifras']
  const vip = vecinos.filter((v) => v.vip === true).map((v) => ({ usuario: String(v.usuario ?? ''), red: String(v.red ?? '') }))
  const metas = Array.isArray(d.metas) ? (d.metas as Record<string, unknown>[]) : []
  const meta = metas.map((m) => ({ vecinos: num(m.vecinos), obra: String(m.obra ?? '') })).sort((a, b) => a.vecinos - b.vecinos).find((m) => m.vecinos > vecinos.length) ?? null
  return {
    vecinos: vecinos.length,
    fecha: ult ? String(ult.fecha) : null,
    cifras,
    vip,
    resto: vecinos.length - vip.length,
    siguienteMeta: meta,
    gta6: typeof d.gta6 === 'string' ? d.gta6 : null
  }
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

/**
 * Cuando unos vídeos pasan de una sección a otra (p. ej. de «Curiosidades» a «GTA 6»), lleva sus marcas de subido:
 * para cada carpeta de `folder`, si existe "<from>_upload:<id>" y no "<to>_upload:<id>", la pasa. Devuelve cuántas movió.
 */
export function moveUploadMarks(db: DB, folder: string, from: LongKind, to: LongKind): number {
  if (!fs.existsSync(folder)) return 0
  let n = 0
  for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const viejo = db.prepare('SELECT value FROM settings WHERE key = ?').get(clave(d.name, from)) as { value: string } | undefined
    if (!viejo) continue
    const nuevo = db.prepare('SELECT value FROM settings WHERE key = ?').get(clave(d.name, to))
    if (!nuevo) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(clave(d.name, to), viejo.value)
    db.prepare('DELETE FROM settings WHERE key = ?').run(clave(d.name, from))
    n++
  }
  return n
}

/** Marca o desmarca un vídeo como subido (a YouTube; en la ciudad, a la red que se diga). */
export function setLongUploaded(db: DB, folder: string, id: unknown, uploaded: boolean, now = new Date(), kind: LongKind = 'long', platform?: unknown): void {
  if (!carpetaDe(folder, id)) throw new Error('El vídeo no existe.')
  const propio = asOwnChannel(kind)
  if (propio) {
    // canales propios: por red (por defecto YouTube, como antes)
    setOwnPost(db, { channel: propio, video: id, platform: asOwnPlatform(platform) ?? 'youtube', uploaded }, now.toISOString())
    return
  }
  const plat = kind === 'city' ? asCityPlatform(platform) : null
  if (kind === 'city' && !plat) throw new Error('Red no válida.')
  if (uploaded) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(clave(id as string, kind, plat), now.toISOString())
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run(clave(id as string, kind, plat))
  }
}
