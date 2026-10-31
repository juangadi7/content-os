/**
 * Vigila las bibliotecas (solo mira; no escribe nada) y avisa cuando el generador deja de tocar
 * archivos durante un rato, para sincronizar sin que el usuario pulse nada.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Carpetas del generador que cambian mucho y no afectan a lo que enseña CONTENT OS. */
const IGNORADAS = new Set(['_work', 'source', 'failed'])

/** ¿Este cambio puede alterar lo que se importa? `rel` es la ruta relativa a la biblioteca. */
export function isRelevantChange(rel: string | null | undefined, tipo: string = 'rename'): boolean {
  if (!rel) return true
  const partes = String(rel).split(/[\\/]+/).map((p) => p.toLowerCase())
  // «cambió la carpeta de una campaña» sin más no dice nada: lo que importa llega con su propia ruta
  if (tipo === 'change' && partes.length === 1) return false
  if (partes.some((p) => IGNORADAS.has(p))) return false
  return !/\.(tmp|part|crdownload)$/.test(partes[partes.length - 1] ?? '')
}

export interface LibraryWatcher {
  /** Carpetas que se están vigilando ahora mismo. */
  watching(): string[]
  /** Vuelve a engancharse a estas carpetas (las que no existan se reintentan en la siguiente llamada). */
  setRoots(roots: string[]): void
  close(): void
}

/**
 * Llama a `onChange` una sola vez cuando pasan `quietMs` sin cambios relevantes
 * (o `maxWaitMs` desde el primero, si el generador no para de escribir).
 */
export function watchLibraries(opts: { quietMs: number; maxWaitMs: number; onChange: () => void }): LibraryWatcher {
  const vigilantes = new Map<string, fs.FSWatcher>()
  let espera: NodeJS.Timeout | null = null
  let primero = 0

  const disparar = () => {
    if (espera) clearTimeout(espera)
    espera = null
    primero = 0
    opts.onChange()
  }
  const cambio = (rel: string | null, tipo: string) => {
    if (!isRelevantChange(rel, tipo)) return
    const ahora = Date.now()
    if (!primero) primero = ahora
    if (espera) clearTimeout(espera)
    espera = setTimeout(disparar, Math.max(0, Math.min(opts.quietMs, primero + opts.maxWaitMs - ahora)))
  }
  const soltar = (root: string) => {
    try {
      vigilantes.get(root)?.close()
    } catch {
      /* ya cerrado */
    }
    vigilantes.delete(root)
  }

  return {
    watching: () => [...vigilantes.keys()],
    setRoots(roots) {
      const quiero = new Set(roots.map((r) => path.resolve(r)))
      for (const r of [...vigilantes.keys()]) if (!quiero.has(r)) soltar(r)
      for (const r of quiero) {
        if (vigilantes.has(r)) continue
        try {
          const w = fs.watch(r, { recursive: true }, (tipo, archivo) => cambio(archivo == null ? null : String(archivo), tipo))
          w.on('error', () => soltar(r)) // p. ej. la carpeta se borra o el disco se desconecta: se reintenta luego
          vigilantes.set(r, w)
        } catch {
          /* la carpeta no existe todavía */
        }
      }
    },
    close() {
      if (espera) clearTimeout(espera)
      espera = null
      for (const r of [...vigilantes.keys()]) soltar(r)
    }
  }
}
