/**
 * «Añadir vídeos»: mete en la carpeta de un canal propio los MP4 que el usuario arrastra o elige.
 *
 * Por cada vídeo se crea VIDEOS_<canal>/<NN · título>/ con el MP4 y un video.json (título y descripción), igual que
 * lo dejan los generadores de cada canal. El archivo original NO se mueve ni se toca: si está en el mismo disco se
 * enlaza (enlace duro: no ocupa espacio de más); si no, se copia.
 */
import fs from 'node:fs'
import path from 'node:path'
import { OWN_NAMES, type OwnChannel } from './own-channels'

export interface ImportItem {
  /** Ruta del MP4 elegido o arrastrado. */
  path: string
  title?: string
  description?: string
}

export interface ImportResult {
  created: { id: string; linked: boolean }[]
  skipped: { path: string; reason: string }[]
}

export interface PickedVideo {
  path: string
  name: string
  sizeBytes: number
}

const PROHIBIDOS = /[<>:"/\\|?*\u0000-\u001f]/g

/** Nombre de carpeta seguro para Windows. */
export function folderTitle(t: string): string {
  return t.replace(PROHIBIDOS, ' ').replace(/\s+/g, ' ').trim().slice(0, 90).replace(/[. ]+$/, '') || 'Vídeo'
}

/** Título por defecto a partir del nombre del archivo: «gta-mapa_v2.mp4» → «gta mapa v2». */
export function titleFromFile(file: string): string {
  return path.basename(file).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Siguiente número de la carpeta (los del canal: «32 · …», «001 · …») con el mismo ancho. */
export function nextNumber(folder: string): string {
  let max = 0
  let ancho = 2
  if (fs.existsSync(folder)) {
    for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
      const m = d.isDirectory() ? /^(\d+)/.exec(d.name) : null
      if (!m) continue
      max = Math.max(max, Number(m[1]))
      ancho = Math.max(ancho, m[1].length)
    }
  }
  return String(max + 1).padStart(ancho, '0')
}

/** MP4 de una lista de rutas (archivos sueltos o carpetas, sin entrar en subcarpetas). */
export function listVideoFiles(rutas: string[]): PickedVideo[] {
  const out: PickedVideo[] = []
  const ver = (r: string) => {
    try {
      const st = fs.statSync(r)
      if (st.isFile() && /\.mp4$/i.test(r)) out.push({ path: r, name: path.basename(r), sizeBytes: st.size })
    } catch {
      /* desaparecido o sin permiso */
    }
  }
  for (const r of rutas) {
    try {
      if (fs.statSync(r).isDirectory()) {
        for (const f of fs.readdirSync(r).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))) ver(path.join(r, f))
      } else ver(r)
    } catch {
      /* ignorado */
    }
  }
  return out
}

/** ¿Ya está ese mismo archivo (mismo nombre y tamaño) en alguna carpeta del canal? */
function yaEsta(folder: string, file: string, size: number): string | null {
  if (!fs.existsSync(folder)) return null
  for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const otro = path.join(folder, d.name, path.basename(file))
    try {
      if (fs.statSync(otro).size === size) return d.name
    } catch {
      /* no está */
    }
  }
  return null
}

export function importOwnVideos(folder: string, channel: OwnChannel, items: ImportItem[]): ImportResult {
  const res: ImportResult = { created: [], skipped: [] }
  fs.mkdirSync(folder, { recursive: true })
  for (const it of items) {
    const origen = typeof it?.path === 'string' ? path.resolve(it.path) : ''
    let st: fs.Stats
    try {
      st = fs.statSync(origen)
    } catch {
      res.skipped.push({ path: String(it?.path ?? ''), reason: 'No se encuentra el archivo.' })
      continue
    }
    if (!st.isFile() || !/\.mp4$/i.test(origen)) {
      res.skipped.push({ path: origen, reason: 'Solo se pueden añadir vídeos MP4.' })
      continue
    }
    if (path.resolve(path.dirname(path.dirname(origen))) === path.resolve(folder)) {
      res.skipped.push({ path: origen, reason: 'Ya está dentro de este canal.' })
      continue
    }
    const repetido = yaEsta(folder, origen, st.size)
    if (repetido) {
      res.skipped.push({ path: origen, reason: `Ya estaba en «${repetido}».` })
      continue
    }
    const titulo = (typeof it.title === 'string' && it.title.trim()) || titleFromFile(origen)
    const id = `${nextNumber(folder)} · ${folderTitle(titulo)}`
    const dir = path.join(folder, id)
    fs.mkdirSync(dir)
    const destino = path.join(dir, path.basename(origen))
    let linked = true
    try {
      fs.linkSync(origen, destino)
    } catch {
      linked = false
      fs.copyFileSync(origen, destino)
    }
    const meta = {
      channel: OWN_NAMES[channel],
      titles: [titulo],
      description: typeof it.description === 'string' && it.description.trim() ? it.description.trim() : null,
      hashtags: [],
      schedule: null,
      notes: 'Añadido desde CONTENT OS.',
      file: path.basename(origen)
    }
    fs.writeFileSync(path.join(dir, 'video.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
    res.created.push({ id, linked })
  }
  return res
}
