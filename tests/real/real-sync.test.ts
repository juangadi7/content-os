/**
 * Sync REAL de solo lectura contra las bibliotecas configuradas (por defecto, las campañas de
 * mundial-clipper). Usa una base de datos temporal y comprueba, con huella completa antes y
 * después, que no se toca ni un byte de CAMPAIGNS.
 *
 *   npm run test:real
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../../src/core/db'
import { syncLibraries, type SyncSummary } from '../../src/core/importer'
import { listCampaigns, listClips } from '../../src/core/queries'

type Row = Record<string, any>

const ROOT = process.env.CONTENT_OS_REAL_ROOT || path.join(os.homedir(), 'mundial-clipper', 'CAMPAIGNS')
const REPORT = process.env.CONTENT_OS_REAL_REPORT || path.join(__dirname, '..', '..', 'docs', 'real-sync-report.json')
const HASH_COMPLETO = new Set(['METADATA', 'QA', 'REPORT', 'CLIPS', 'FAILED'])

function sha(ruta: string): string {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(ruta, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  let n: number
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  fs.closeSync(fd)
  return h.digest('hex')
}

/** Huella de TODO el árbol: hash de contenido en lo pequeño y en CLIPS; tamaño+fecha en SOURCE y _work. */
function huella(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, completo: boolean) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = path.relative(dir, p)
      if (e.isDirectory()) {
        out[rel + path.sep] = 'dir'
        const nivel = rel.split(path.sep)
        walk(p, nivel.length === 1 ? true : nivel.length === 2 ? HASH_COMPLETO.has(e.name) : completo)
      } else {
        const st = fs.statSync(p)
        out[rel] = `${st.size}:${Math.round(st.mtimeMs)}` + (completo ? ':' + sha(p) : '')
      }
    }
  }
  walk(dir, true)
  return out
}

let tmp: string
let db: DB
let antes: Record<string, string>
let r1: SyncSummary
let r2: SyncSummary
const q = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Row[]

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos_real_'))
  db = openDatabase(path.join(tmp, 'content-os.db'))
  antes = huella(ROOT)
  r1 = syncLibraries(db, { roots: [ROOT], thumbsDir: path.join(tmp, 'thumbs') })
  r2 = syncLibraries(db, { roots: [ROOT], thumbsDir: path.join(tmp, 'thumbs') })
})

afterAll(() => {
  const informe = {
    fecha: new Date().toISOString(),
    runtime: { electron: process.versions.electron ?? null, node: process.versions.node },
    biblioteca: ROOT,
    primera_sincronizacion: r1,
    segunda_sincronizacion: r2,
    campañas: listCampaigns(db).map((c) => ({ campaign_id: c.campaignId, nombre: c.displayName, plataforma: c.platform, clips: c.clips, estado: c.state })),
    clips: q('SELECT campaign_id, clip_id, filename, score, score_origin, qa_score, file_state, resolved_via FROM clips ORDER BY campaign_id, filename'),
    avisos_y_errores: q("SELECT level, type, code, campaign_id, clip_id, message FROM sync_events WHERE level <> 'info'"),
    archivos_en_campaigns: Object.keys(antes).length
  }
  fs.mkdirSync(path.dirname(REPORT), { recursive: true })
  fs.writeFileSync(REPORT, JSON.stringify(informe, null, 1))
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('sync real de solo lectura', () => {
  it('se ejecuta dentro del runtime de Electron', () => {
    expect(process.versions.electron).toBeTruthy()
  })

  it('importa 4 campañas y 48 clips sin avisos ni errores', () => {
    expect(r1).toMatchObject({ status: 'ok', rootsScanned: 1, campaignsSeen: 4, clipsSeen: 48, created: 52, updated: 0, disappeared: 0, warnings: 0, errors: 0 })
    expect(q('SELECT COUNT(*) AS n FROM campaigns')[0].n).toBe(4)
    expect(q('SELECT COUNT(*) AS n FROM clips')[0].n).toBe(48)
    expect(q('SELECT COUNT(DISTINCT clip_id) AS n FROM clips')[0].n).toBe(48)
  })

  it('la segunda pasada no cambia nada y no recalcula ningún hash', () => {
    expect(r2).toMatchObject({ status: 'ok', created: 0, updated: 0, disappeared: 0, warnings: 0, errors: 0, hashesComputed: 0, hashesReused: 48 })
    expect(r1.hashesComputed).toBe(48)
  })

  it('los 48 IDs son exactamente los de los clip_ids.json (ninguno inventado)', () => {
    const esperados: Record<string, string[]> = {}
    for (const folder of fs.readdirSync(ROOT)) {
      const p = path.join(ROOT, folder, 'clip_ids.json')
      if (!fs.existsSync(p)) continue
      const libro = JSON.parse(fs.readFileSync(p, 'utf8'))
      esperados[libro.campaign_id] = libro.clips.map((c: Row) => c.clip_id).sort()
    }
    const importados: Record<string, string[]> = {}
    for (const k of q('SELECT campaign_id, clip_id FROM clips ORDER BY clip_id')) (importados[k.campaign_id] ??= []).push(k.clip_id)
    expect(Object.keys(esperados)).toHaveLength(4)
    expect(importados).toEqual(esperados)
    expect(q("SELECT COUNT(*) AS n FROM campaigns WHERE campaign_id_origin = 'clip_ids'")[0].n).toBe(4)
    // y cada clip lleva el tramo pedido que consta en el registro
    expect(q('SELECT COUNT(*) AS n FROM clips WHERE requested_start_time IS NULL OR requested_end_time IS NULL')[0].n).toBe(0)
  })

  it('los 48 full_path apuntan a MP4 existentes y los hashes coinciden', () => {
    const filas = q('SELECT clip_id, full_path, resolved_path, resolved_via, file_state, sha256, file_sha256 FROM clips')
    expect(filas.filter((k) => !fs.existsSync(k.full_path))).toEqual([])
    expect(filas.filter((k) => k.file_state !== 'ok' || k.resolved_via !== 'campaign_clips')).toEqual([])
    expect(filas.filter((k) => k.sha256 !== k.file_sha256)).toEqual([])
    expect(filas.filter((k) => path.resolve(k.full_path) !== path.resolve(k.resolved_path))).toEqual([])
    // comprobación independiente de la caché: se vuelve a calcular el hash de cada archivo
    expect(filas.filter((k) => sha(k.full_path) !== k.sha256)).toEqual([])
  })

  it('scores: Shark Tank a null, Kevin Langue y MrBeast conservados', () => {
    const porCampaña = q(
      `SELECT campaign_id, COUNT(*) AS n, SUM(score IS NULL) AS sin_score, MIN(score) AS minimo, MAX(score) AS maximo
       FROM clips GROUP BY campaign_id ORDER BY campaign_id`
    )
    expect(porCampaña).toEqual([
      { campaign_id: 'kevin-langue-5-guys-face-their-crush-2026-10-05', n: 5, sin_score: 0, minimo: 90, maximo: 95 },
      { campaign_id: 'mrbeast-eat-everything-in-a-grocery-store-2026-10-06', n: 10, sin_score: 0, minimo: 90, maximo: 97 },
      { campaign_id: 'shark-tank-1801-2026-10-07', n: 15, sin_score: 15, minimo: null, maximo: null },
      { campaign_id: 'shark-tank-s18e02-2026-10-07', n: 18, sin_score: 18, minimo: null, maximo: null }
    ])
    // el score importado es el de la ficha, clip a clip
    for (const k of q('SELECT metadata_path, score FROM clips')) {
      expect(JSON.parse(fs.readFileSync(k.metadata_path, 'utf8')).score).toBe(k.score)
    }
  })

  it('prediction y selection_reason son null en los 48', () => {
    expect(q('SELECT COUNT(*) AS n FROM clips WHERE prediction IS NOT NULL OR selection_reason IS NOT NULL')[0].n).toBe(0)
    expect(q('SELECT COUNT(*) AS n FROM prediction_snapshots')[0].n).toBe(0)
  })

  it('portadas, QA y orden', () => {
    expect(q('SELECT COUNT(*) AS n FROM clips WHERE qa_path IS NULL OR qa_sheet_path IS NULL')[0].n).toBe(0)
    // hay miniatura exactamente para los clips cuya ficha tiene portada al lado; no se inventa ninguna
    // (la campaña de Kevin Langue se generó antes de que existieran las portadas)
    expect(q('SELECT COUNT(*) AS n FROM clips WHERE (thumb_path IS NULL) <> (cover_path IS NULL)')[0].n).toBe(0)
    for (const k of q('SELECT metadata_path, cover_path FROM clips')) {
      expect(fs.existsSync(k.metadata_path.replace(/\.json$/, '_portada.jpg'))).toBe(k.cover_path !== null)
    }
    expect(q('SELECT campaign_id, COUNT(*) AS n FROM clips WHERE cover_path IS NULL GROUP BY campaign_id')).toEqual([
      { campaign_id: 'kevin-langue-5-guys-face-their-crush-2026-10-05', n: 5 }
    ])
    const kl = listClips(db, 'kevin-langue-5-guys-face-their-crush-2026-10-05')
    expect(kl.map((k) => k.score)).toEqual([...kl.map((k) => k.score)].sort((a, b) => (b ?? 0) - (a ?? 0)))
    const st = listClips(db, 'shark-tank-1801-2026-10-07')
    expect(st.map((k) => k.qaScore)).toEqual([...st.map((k) => k.qaScore)].sort((a, b) => (b ?? 0) - (a ?? 0)))
  })

  it('no se ha modificado, creado ni borrado ningún archivo de CAMPAIGNS', () => {
    const despues = huella(ROOT)
    const cambiados = Object.keys(antes).filter((k) => k in despues && antes[k] !== despues[k])
    const creados = Object.keys(despues).filter((k) => !(k in antes))
    const borrados = Object.keys(antes).filter((k) => !(k in despues))
    expect({ cambiados, creados, borrados }).toEqual({ cambiados: [], creados: [], borrados: [] })
    expect(Object.keys(antes).length).toBeGreaterThan(300)
  })
})
