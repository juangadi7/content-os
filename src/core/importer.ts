/**
 * Sincronización:  CAMPAIGNS --lectura--> importador --> SQLite.
 *
 * Nunca escribe dentro de las bibliotecas. Lo único que escribe en disco, aparte de la
 * base de datos, son copias de portadas en la carpeta thumbs\ de CONTENT OS.
 * La identidad de un clip es su clip_id; aquí no se crea ni se deduce ninguno.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { isDir, resolveClipFile, type HashStats } from './files'
import { listCampaignFolders, scanCampaign, type ParsedCampaign, type ParsedClip } from './scan'

export interface SyncOptions {
  /** Bibliotecas a recorrer (de la configuración). */
  roots: string[]
  /** Carpeta de CONTENT OS donde copiar las portadas. Sin ella no se copian. */
  thumbsDir?: string
  /** Reloj inyectable para pruebas. */
  now?: () => string
}

export interface SyncSummary {
  runId: number
  status: 'ok' | 'ok_with_warnings' | 'error'
  startedAt: string
  finishedAt: string
  rootsScanned: number
  campaignsSeen: number
  clipsSeen: number
  created: number
  updated: number
  disappeared: number
  warnings: number
  errors: number
  hashesComputed: number
  hashesReused: number
}

type EventType =
  | 'clip_created' | 'clip_updated' | 'render_changed' | 'clip_disappeared' | 'clip_reappeared'
  | 'campaign_created' | 'campaign_updated' | 'campaign_disappeared' | 'campaign_reappeared'
  | 'warning' | 'error'

/** Campos de `clips` que vienen del generador y se sobrescriben en cada sincronización. */
const CLIP_EXTERNAL = [
  'metadata_version', 'filename', 'full_path', 'title', 'caption', 'hashtags', 'language', 'duration',
  'source', 'start_time', 'end_time', 'score', 'score_origin', 'selection_reason', 'prediction',
  'qa_score', 'status', 'sha256', 'created_at', 'cover_second', 'metadata_errors', 'metadata_path',
  'metadata_json', 'requested_start_time', 'requested_end_time', 'qa_path', 'qa_summary',
  'qa_sheet_path', 'cover_path'
] as const satisfies readonly (keyof ParsedClip)[]

const CAMPAIGN_EXTERNAL = [
  'root_id', 'folder_name', 'display_name', 'source_path', 'campaign_json_path', 'platform',
  'language', 'campaign_id_origin', 'report_date', 'clips_generated', 'clips_rejected', 'publish_checklist'
] as const

type Row = Record<string, unknown>

const distinto = (a: unknown, b: unknown): boolean => (a ?? null) !== (b ?? null)

export function syncLibraries(db: DB, opts: SyncOptions): SyncSummary {
  const now = opts.now ?? (() => new Date().toISOString())
  const startedAt = now()
  const hashStats: HashStats = { computed: 0, reused: 0 }
  const c = { roots: 0, campaigns: 0, clips: 0, created: 0, updated: 0, disappeared: 0, warnings: 0, errors: 0 }

  const runId = Number(
    db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").run(startedAt).lastInsertRowid
  )
  const insEvent = db.prepare(
    `INSERT INTO sync_events (sync_run_id, created_at, level, type, code, campaign_id, clip_id, path, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const event = (
    type: EventType,
    message: string,
    extra: { level?: 'info' | 'warning' | 'error'; code?: string; campaignId?: string | null; clipId?: string | null; path?: string | null } = {}
  ) => {
    const level = extra.level ?? (type === 'warning' ? 'warning' : type === 'error' ? 'error' : 'info')
    if (level === 'warning') c.warnings++
    if (level === 'error') c.errors++
    insEvent.run(runId, now(), level, type, extra.code ?? null, extra.campaignId ?? null, extra.clipId ?? null, extra.path ?? null, message)
  }

  try {
    // ---- bibliotecas: las de la configuración quedan activas; las demás, desactivadas (no se borran)
    const raices = [...new Set(opts.roots.map((r) => path.normalize(r)))]
    db.transaction(() => {
      for (const r of raices) {
        db.prepare(
          `INSERT INTO library_roots (path, enabled, created_at) VALUES (?, 1, ?)
           ON CONFLICT(path) DO UPDATE SET enabled = 1`
        ).run(r, startedAt)
      }
      const marcas = raices.map(() => '?').join(',')
      db.prepare(`UPDATE library_roots SET enabled = 0 WHERE path NOT IN (${marcas || "''"})`).run(...raices)
    })()

    const campañasVistas = new Map<string, string>() // campaign_id -> carpeta donde se vio
    const carpetasIlegibles = new Set<string>() // `${root_id}|${folder}` vistas pero no importables
    const raicesLeidas: number[] = []

    for (const rootPath of raices) {
      const root = db.prepare('SELECT id FROM library_roots WHERE path = ?').get(rootPath) as { id: number }
      if (!isDir(rootPath)) {
        // biblioteca no disponible (disco desconectado, carpeta movida): no se da nada por desaparecido
        event('error', 'la biblioteca no existe o no es accesible; se conservan sus datos', { code: 'root_unavailable', path: rootPath })
        continue
      }
      c.roots++
      raicesLeidas.push(root.id)

      for (const folder of listCampaignFolders(rootPath)) {
        const parsed = scanCampaign(rootPath, folder)
        c.campaigns++
        for (const i of parsed.issues) {
          event(i.level, i.message, { code: i.code, campaignId: parsed.campaignId, clipId: i.clipId ?? null, path: i.path ?? null })
        }
        if (parsed.fatal || !parsed.campaignId) {
          carpetasIlegibles.add(`${root.id}|${folder}`)
          db.prepare("UPDATE campaigns SET state = 'unreadable', last_sync_at = ? WHERE root_id = ? AND folder_name = ?").run(now(), root.id, folder)
          continue
        }
        const previa = campañasVistas.get(parsed.campaignId)
        if (previa) {
          event('error', `campaign_id ${parsed.campaignId} repetido en dos carpetas (${previa} y ${parsed.sourcePath}): se ignora la segunda`, {
            code: 'duplicate_campaign_id', campaignId: parsed.campaignId, path: parsed.sourcePath
          })
          carpetasIlegibles.add(`${root.id}|${folder}`)
          continue
        }
        campañasVistas.set(parsed.campaignId, parsed.sourcePath)
        db.transaction(() => applyCampaign(root.id, parsed))()
      }
      db.prepare('UPDATE library_roots SET last_sync_at = ? WHERE id = ?').run(now(), root.id)
    }

    // ---- campañas que ya no están en una biblioteca que sí se ha podido leer: se marcan, no se borran
    db.transaction(() => {
      for (const rootId of raicesLeidas) {
        const filas = db.prepare('SELECT campaign_id, folder_name, source_path FROM campaigns WHERE root_id = ? AND present_in_source = 1').all(rootId) as Row[]
        for (const f of filas) {
          if (campañasVistas.has(f.campaign_id as string) || carpetasIlegibles.has(`${rootId}|${f.folder_name}`)) continue
          db.prepare('UPDATE campaigns SET present_in_source = 0, missing_since = ?, last_sync_at = ? WHERE campaign_id = ?').run(now(), now(), f.campaign_id)
          c.disappeared++
          event('campaign_disappeared', 'la carpeta de la campaña ya no está en la biblioteca; se conservan sus datos', {
            level: 'warning', campaignId: f.campaign_id as string, path: f.source_path as string
          })
        }
      }
    })()
  } catch (e) {
    event('error', `sincronización interrumpida: ${(e as Error).message}`, { code: 'sync_failed' })
  }

  const finishedAt = now()
  const status: SyncSummary['status'] = c.errors ? 'error' : c.warnings ? 'ok_with_warnings' : 'ok'
  db.prepare(
    `UPDATE sync_runs SET finished_at = ?, status = ?, roots_scanned = ?, campaigns_seen = ?, clips_seen = ?,
       created = ?, updated = ?, disappeared = ?, warnings = ?, errors = ? WHERE id = ?`
  ).run(finishedAt, status, c.roots, c.campaigns, c.clips, c.created, c.updated, c.disappeared, c.warnings, c.errors, runId)

  return {
    runId, status, startedAt, finishedAt, rootsScanned: c.roots, campaignsSeen: c.campaigns, clipsSeen: c.clips,
    created: c.created, updated: c.updated, disappeared: c.disappeared, warnings: c.warnings, errors: c.errors,
    hashesComputed: hashStats.computed, hashesReused: hashStats.reused
  }

  // ------------------------------------------------------------------ una campaña
  function applyCampaign(rootId: number, p: ParsedCampaign): void {
    const cid = p.campaignId as string
    const t = now()
    const ext: Row = {
      root_id: rootId, folder_name: p.folderName, display_name: p.displayName, source_path: p.sourcePath,
      campaign_json_path: p.campaignJsonPath, platform: p.platform, language: p.language,
      campaign_id_origin: p.campaignIdOrigin, report_date: p.reportDate, clips_generated: p.clipsGenerated,
      clips_rejected: p.clipsRejected, publish_checklist: p.publishChecklist
    }
    const actual = db.prepare('SELECT * FROM campaigns WHERE campaign_id = ?').get(cid) as Row | undefined
    const presentes = actual
      ? (db.prepare('SELECT COUNT(*) AS n FROM clips WHERE campaign_id = ? AND present_in_source = 1').get(cid) as { n: number }).n
      : 0

    // estado propio de la campaña en esta pasada
    let state = 'ok'
    if (p.metadataFiles === 0) state = presentes > 0 ? 'generating' : 'empty'
    else if (p.clipFiles === 0) state = 'clips_empty'

    if (!actual) {
      db.prepare(
        `INSERT INTO campaigns (campaign_id, ${CAMPAIGN_EXTERNAL.join(', ')}, state, created_at, updated_at, last_sync_at)
         VALUES (@campaign_id, ${CAMPAIGN_EXTERNAL.map((k) => '@' + k).join(', ')}, @state, @t, @t, @t)`
      ).run({ campaign_id: cid, ...ext, state, t })
      c.created++
      event('campaign_created', `campaña nueva: ${p.displayName ?? p.folderName}`, { campaignId: cid, path: p.sourcePath })
    } else {
      const cambios = CAMPAIGN_EXTERNAL.filter((k) => distinto(actual[k], ext[k]))
      if (cambios.length) {
        db.prepare(`UPDATE campaigns SET ${cambios.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @t WHERE campaign_id = @campaign_id`).run({ campaign_id: cid, t, ...Object.fromEntries(cambios.map((k) => [k, ext[k]])) })
        c.updated++
        event('campaign_updated', `cambios en: ${cambios.join(', ')}`, { campaignId: cid, path: p.sourcePath })
      }
      if (actual.present_in_source === 0) {
        db.prepare('UPDATE campaigns SET present_in_source = 1, missing_since = NULL WHERE campaign_id = ?').run(cid)
        event('campaign_reappeared', 'la campaña vuelve a estar en la biblioteca', { campaignId: cid, path: p.sourcePath })
      }
      db.prepare('UPDATE campaigns SET state = ?, last_sync_at = ? WHERE campaign_id = ?').run(state, t, cid)
    }

    const estadoPrevio = actual?.state as string | undefined
    if (state === 'generating') {
      // METADATA vacía con clips ya importados: casi seguro una regeneración en curso
      if (estadoPrevio !== 'generating') {
        event('warning', `METADATA está vacía y había ${presentes} clips: posible generación en curso. Se conservan los datos anteriores`, {
          code: 'metadata_empty', campaignId: cid, path: path.join(p.sourcePath, 'METADATA')
        })
      }
      return
    }
    if (state === 'empty' && estadoPrevio !== 'empty') {
      event('warning', 'la campaña no tiene fichas en METADATA', { code: 'metadata_empty', campaignId: cid, path: path.join(p.sourcePath, 'METADATA') })
    }
    if (state === 'clips_empty' && estadoPrevio !== 'clips_empty') {
      event('warning', 'la carpeta CLIPS no tiene ningún MP4', { code: 'clips_folder_empty', campaignId: cid, path: path.join(p.sourcePath, 'CLIPS') })
    }

    const nombres = new Set(p.clips.map((k) => (k.filename ?? '').toLowerCase()).filter(Boolean))
    const vistos = new Set<string>()
    for (const clip of p.clips) {
      c.clips++
      if (applyClip(cid, p, clip, nombres)) vistos.add(clip.clip_id)
    }

    // ---- clips que ya no tienen ficha: se marcan, nunca se borran. Solo si la lectura fue completa.
    if (!p.complete) {
      const pendientes = (db.prepare('SELECT clip_id FROM clips WHERE campaign_id = ? AND present_in_source = 1').all(cid) as Row[])
        .filter((f) => !vistos.has(f.clip_id as string)).length
      if (pendientes) {
        event('warning', `${pendientes} clips sin ficha legible en esta pasada: no se marcan como desaparecidos porque la lectura fue incompleta`, {
          code: 'disappearance_deferred', campaignId: cid, path: p.sourcePath
        })
      }
      return
    }
    const filas = db.prepare('SELECT clip_id FROM clips WHERE campaign_id = ? AND present_in_source = 1').all(cid) as Row[]
    for (const f of filas) {
      if (vistos.has(f.clip_id as string)) continue
      db.prepare('UPDATE clips SET present_in_source = 0, missing_since = ?, last_sync_at = ? WHERE clip_id = ?').run(t, t, f.clip_id)
      c.disappeared++
      event('clip_disappeared', 'el clip ya no tiene ficha en METADATA; se conservan sus datos', { level: 'warning', campaignId: cid, clipId: f.clip_id as string })
    }
  }

  // ------------------------------------------------------------------ un clip
  function applyClip(cid: string, p: ParsedCampaign, clip: ParsedClip, nombres: Set<string>): boolean {
    const t = now()
    const actual = db.prepare('SELECT * FROM clips WHERE clip_id = ?').get(clip.clip_id) as Row | undefined
    if (actual && actual.campaign_id !== cid) {
      event('error', `clip_id ya importado en otra campaña (${actual.campaign_id}): no se sobrescribe`, {
        code: 'duplicate_clip_id', campaignId: cid, clipId: clip.clip_id, path: clip.metadata_path
      })
      return false
    }
    const ext: Row = {}
    for (const k of CLIP_EXTERNAL) ext[k] = clip[k]

    if (!actual) {
      db.prepare(
        `INSERT INTO clips (clip_id, campaign_id, ${CLIP_EXTERNAL.join(', ')}, first_seen_at, updated_at, last_sync_at)
         VALUES (@clip_id, @campaign_id, ${CLIP_EXTERNAL.map((k) => '@' + k).join(', ')}, @t, @t, @t)`
      ).run({ clip_id: clip.clip_id, campaign_id: cid, ...ext, t })
      c.created++
      event('clip_created', `clip nuevo: ${clip.title ?? clip.filename ?? clip.clip_id}`, { campaignId: cid, clipId: clip.clip_id, path: clip.metadata_path })
    } else {
      const cambios = CLIP_EXTERNAL.filter((k) => distinto(actual[k], ext[k]))
      const render = cambios.includes('sha256') && actual.sha256 != null && clip.sha256 != null
      if (cambios.length) {
        db.prepare(
          `UPDATE clips SET ${cambios.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @t${render ? ', render_changed_at = @t' : ''} WHERE clip_id = @clip_id`
        ).run({ clip_id: clip.clip_id, t, ...Object.fromEntries(cambios.map((k) => [k, ext[k]])) })
        c.updated++
        // metadata_json cambia siempre que cambia cualquier campo de la ficha: no aporta información
        const visibles = cambios.filter((k) => k !== 'metadata_json')
        event('clip_updated', `cambios en: ${(visibles.length ? visibles : cambios).join(', ')}`, { campaignId: cid, clipId: clip.clip_id, path: clip.metadata_path })
      }
      if (render) {
        event('render_changed', `el render ha cambiado: ${String(actual.sha256).slice(0, 12)} -> ${clip.sha256!.slice(0, 12)}`, { campaignId: cid, clipId: clip.clip_id })
        const pubs = db.prepare(
          'SELECT platform, account, sha256_at_publish FROM publications WHERE clip_id = ? AND sha256_at_publish IS NOT NULL AND sha256_at_publish <> ?'
        ).all(clip.clip_id, clip.sha256) as Row[]
        for (const pub of pubs) {
          event('warning', `publicado en ${pub.platform}${pub.account ? ' (' + pub.account + ')' : ''} con un render anterior (${String(pub.sha256_at_publish).slice(0, 12)}); la publicación se conserva`, {
            code: 'published_render_differs', campaignId: cid, clipId: clip.clip_id
          })
        }
      }
      if (actual.present_in_source === 0) {
        db.prepare('UPDATE clips SET present_in_source = 1, missing_since = NULL WHERE clip_id = ?').run(clip.clip_id)
        event('clip_reappeared', 'el clip vuelve a tener ficha', { campaignId: cid, clipId: clip.clip_id })
      }
      db.prepare('UPDATE clips SET last_sync_at = ? WHERE clip_id = ?').run(t, clip.clip_id)
    }

    // ---- archivo MP4: dónde está y si es el que dice la ficha (datos propios, no generan "clip_updated")
    const otros = new Set(nombres)
    if (clip.filename) otros.delete(clip.filename.toLowerCase())
    const f = resolveClipFile(db, p.sourcePath, { filename: clip.filename, fullPath: clip.full_path, sha256: clip.sha256 }, otros, t, hashStats)
    const estadoPrevio = (actual?.file_state as string | undefined) ?? 'unknown'
    db.prepare(
      `UPDATE clips SET resolved_path = ?, resolved_via = ?, file_state = ?, file_size = ?, file_mtime_ms = ?, file_sha256 = ? WHERE clip_id = ?`
    ).run(f.path, f.via, f.state, f.size, f.mtimeMs, f.sha256, clip.clip_id)
    if (f.state !== estadoPrevio) {
      if (f.state === 'missing') {
        event('warning', `no se encuentra el MP4 (${clip.filename ?? 'sin nombre'})`, { code: 'file_missing', campaignId: cid, clipId: clip.clip_id, path: clip.full_path })
      } else if (f.state === 'hash_mismatch') {
        event('warning', `el MP4 no coincide con el sha256 de la ficha (archivo ${f.sha256?.slice(0, 12)}, ficha ${clip.sha256?.slice(0, 12)})`, {
          code: 'hash_mismatch', campaignId: cid, clipId: clip.clip_id, path: f.path
        })
      } else if (f.state === 'unverified') {
        event('warning', 'la ficha no trae sha256: no se puede verificar el archivo', { code: 'hash_unverified', campaignId: cid, clipId: clip.clip_id, path: f.path })
      }
    }

    // ---- portada: copia propia, porque METADATA se borra al regenerar
    if (opts.thumbsDir && clip.cover_path) {
      try {
        const st = fs.statSync(clip.cover_path)
        const destino = path.join(opts.thumbsDir, `${clip.clip_id}.jpg`)
        const size = st.size
        const mtime = Math.round(st.mtimeMs)
        if (!actual || actual.cover_size !== size || actual.cover_mtime_ms !== mtime || !fs.existsSync(destino)) {
          fs.mkdirSync(opts.thumbsDir, { recursive: true })
          fs.copyFileSync(clip.cover_path, destino)
          db.prepare('UPDATE clips SET thumb_path = ?, cover_size = ?, cover_mtime_ms = ? WHERE clip_id = ?').run(destino, size, mtime, clip.clip_id)
        }
      } catch (e) {
        event('warning', `no se pudo copiar la portada: ${(e as Error).message}`, { code: 'thumb_failed', campaignId: cid, clipId: clip.clip_id, path: clip.cover_path })
      }
    }
    return true
  }
}
