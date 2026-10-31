import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { MIGRATIONS, SCHEMA_VERSION } from './schema'

export type DB = Database.Database

export interface OpenOptions {
  /** Carpeta donde dejar una copia de la base antes de migrarla a un esquema nuevo. */
  backupDir?: string
}

function userVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number
}

/** Abre (o crea) la base de datos de CONTENT OS y la lleva al esquema actual. */
export function openDatabase(dbPath: string, opts: OpenOptions = {}): DB {
  const memoria = dbPath === ':memory:'
  if (!memoria) fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const existia = !memoria && fs.existsSync(dbPath)

  let db = new Database(dbPath)
  const version = userVersion(db)
  if (version > SCHEMA_VERSION) {
    db.close()
    throw new Error(`La base de datos es de una versión más nueva (${version}) que esta aplicación (${SCHEMA_VERSION}).`)
  }
  if (existia && version > 0 && version < SCHEMA_VERSION && opts.backupDir) {
    db.close()
    fs.mkdirSync(opts.backupDir, { recursive: true })
    const sello = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(dbPath, path.join(opts.backupDir, `content-os_v${version}_${sello}.db`))
    db = new Database(dbPath)
  }
  if (!memoria) db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // la sincronización corre en otro hilo con su propia conexión: se espera en vez de fallar
  db.pragma('busy_timeout = 5000')

  for (let v = userVersion(db); v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}
