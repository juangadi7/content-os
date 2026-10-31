import fs from 'node:fs'
import path from 'node:path'

export interface AppConfig {
  library_roots: string[]
}

export interface LoadedConfig {
  config: AppConfig
  path: string
  /** true si el archivo no existía y se acaba de crear. */
  created: boolean
  /** Motivo por el que el archivo existente no se pudo usar (no se sobrescribe). */
  error: string | null
}

export const CONFIG_FILE = 'config.json'

function limpiar(valor: unknown): AppConfig {
  const roots = (valor as { library_roots?: unknown })?.library_roots
  const lista = Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : []
  return { library_roots: [...new Set(lista.map((r) => path.normalize(r.trim())))] }
}

/**
 * Lee la configuración editable. Si no existe, la crea con las bibliotecas que proponga
 * `porDefecto` (lo decide quien arranca la aplicación, no el dominio).
 */
export function loadConfig(configDir: string, porDefecto: () => string[] = () => []): LoadedConfig {
  const ruta = path.join(configDir, CONFIG_FILE)
  if (!fs.existsSync(ruta)) {
    const config = limpiar({ library_roots: porDefecto() })
    saveConfig(configDir, config)
    return { config, path: ruta, created: true, error: null }
  }
  try {
    const texto = fs.readFileSync(ruta, 'utf8').replace(/^﻿/, '')
    return { config: limpiar(JSON.parse(texto)), path: ruta, created: false, error: null }
  } catch (e) {
    return { config: { library_roots: [] }, path: ruta, created: false, error: `config.json ilegible: ${(e as Error).message}` }
  }
}

export function saveConfig(configDir: string, config: AppConfig): void {
  fs.mkdirSync(configDir, { recursive: true })
  const ruta = path.join(configDir, CONFIG_FILE)
  const tmp = ruta + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(limpiar(config), null, 2), 'utf8')
  fs.renameSync(tmp, ruta)
}
