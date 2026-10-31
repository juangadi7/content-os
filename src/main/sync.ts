import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { SyncSummary } from '../core/importer'
import type { SyncJob, SyncReply } from './sync-worker'

/** Lanza la sincronización en un hilo aparte y espera su resumen. */
export function runSyncInWorker(job: SyncJob): Promise<SyncSummary> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'sync-worker.js'), { workerData: job })
    let resuelto = false
    worker.once('message', (m: SyncReply) => {
      resuelto = true
      if (m.ok) resolve(m.summary)
      else reject(new Error(m.error))
    })
    worker.once('error', (e) => {
      resuelto = true
      reject(e)
    })
    worker.once('exit', (code) => {
      if (!resuelto) reject(new Error(`La sincronización terminó sin respuesta (código ${code}).`))
    })
  })
}
