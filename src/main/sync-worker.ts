/**
 * Hilo aparte para la sincronización: lee las bibliotecas y calcula hashes sin congelar la
 * ventana. Abre su propia conexión a la base (WAL permite que la interfaz siga leyendo).
 */
import { parentPort, workerData } from 'node:worker_threads'
import { openDatabase } from '../core/db'
import { syncLibraries, type SyncSummary } from '../core/importer'

export interface SyncJob {
  dbPath: string
  roots: string[]
  thumbsDir: string
}
export type SyncReply = { ok: true; summary: SyncSummary } | { ok: false; error: string }

const job = workerData as SyncJob
let reply: SyncReply
try {
  const db = openDatabase(job.dbPath)
  try {
    reply = { ok: true, summary: syncLibraries(db, { roots: job.roots, thumbsDir: job.thumbsDir }) }
  } finally {
    db.close()
  }
} catch (e) {
  reply = { ok: false, error: (e as Error).message }
}
parentPort?.postMessage(reply)
