/**
 * Material en bruto de una campaña (los vídeos originales de <campaña>\SOURCE).
 *
 * Es la ÚNICA parte de CONTENT OS que borra algo de las carpetas del generador, y solo cuando el
 * usuario lo pide y lo confirma. No toca CLIPS, METADATA, QA, REPORT ni clip_ids.json.
 *
 * En Windows un mismo vídeo puede tener varios nombres (enlaces duros): el generador enlaza en
 * SOURCE el archivo que está en Descargas en vez de copiarlo. El espacio solo se libera cuando
 * desaparecen TODOS los nombres, así que se localizan y se quitan todos.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface RawFile {
  name: string
  path: string
  size: number
  /** Otros nombres del mismo archivo fuera de esta carpeta SOURCE (p. ej. en Descargas). */
  otherNames: string[]
}

export interface RawInfo {
  sourceDir: string
  files: RawFile[]
  totalBytes: number
}

export interface RawRemoval {
  removed: string[]
  failed: { path: string; error: string }[]
  /** Bytes de los vídeos cuyos nombres se quitaron todos. */
  freedBytes: number
}

/** Devuelve todos los nombres (rutas) de un archivo, incluido el propio. */
export type LinkLister = (file: string) => string[]

const mismaRuta = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Nombres de un archivo según Windows (fsutil hardlink list). Si no se puede saber, solo el propio. */
export const windowsLinks: LinkLister = (file) => {
  try {
    const raiz = path.parse(path.resolve(file)).root.replace(/[\\/]+$/, '')
    const salida = execFileSync('fsutil', ['hardlink', 'list', file], { encoding: 'utf8', windowsHide: true })
    const rutas = salida.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('\\')).map((l) => raiz + l)
    return rutas.length ? rutas : [file]
  } catch {
    return [file]
  }
}

function identidad(ruta: string): string | null {
  try {
    const st = fs.statSync(ruta, { bigint: true })
    return st.isFile() ? `${st.dev}:${st.ino}` : null
  } catch {
    return null
  }
}

/** Vídeos en bruto de una carpeta SOURCE. Cada archivo cuenta una vez aunque tenga varios nombres. */
export function listRawFiles(sourceDir: string, linksOf: LinkLister = windowsLinks): RawInfo {
  const files: RawFile[] = []
  const vistos = new Set<string>()
  let entradas: string[] = []
  try {
    entradas = fs.readdirSync(sourceDir).sort()
  } catch {
    entradas = []
  }
  for (const name of entradas) {
    const ruta = path.join(sourceDir, name)
    const id = identidad(ruta)
    if (!id) continue
    const repetido = vistos.has(id)
    vistos.add(id)
    const otros = linksOf(ruta).filter((l) => !mismaRuta(l, ruta) && identidad(l) === id && !mismaRuta(path.dirname(l), sourceDir))
    files.push({ name, path: ruta, size: repetido ? 0 : fs.statSync(ruta).size, otherNames: otros })
  }
  return { sourceDir, files, totalBytes: files.reduce((s, f) => s + f.size, 0) }
}

/**
 * Quita el material en bruto: cada vídeo de SOURCE y sus demás nombres. `remove` decide cómo
 * (a la Papelera o borrado definitivo). Antes de quitar un nombre se comprueba que sigue siendo
 * ese mismo archivo; nunca se sale de lo que `listRawFiles` enseñó.
 */
export async function removeRawFiles(sourceDir: string, remove: (ruta: string) => Promise<void> | void, linksOf: LinkLister = windowsLinks): Promise<RawRemoval> {
  const info = listRawFiles(sourceDir, linksOf)
  const out: RawRemoval = { removed: [], failed: [], freedBytes: 0 }
  for (const f of info.files) {
    const id = identidad(f.path)
    if (!id) continue
    let todos = true
    // primero los otros nombres y al final el de SOURCE: si algo falla a medias, la campaña conserva su vídeo
    for (const ruta of [...f.otherNames, f.path]) {
      if (identidad(ruta) !== id) continue
      try {
        await remove(ruta)
        out.removed.push(ruta)
      } catch (e) {
        todos = false
        out.failed.push({ path: ruta, error: (e as Error).message })
        break
      }
    }
    if (todos) out.freedBytes += f.size
  }
  return out
}
