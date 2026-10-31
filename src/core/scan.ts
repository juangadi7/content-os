/**
 * Lectura de una carpeta de campaña de mundial-clipper. SOLO LECTURA y sin base de datos:
 * devuelve lo que hay en disco y los problemas encontrados; no decide qué se guarda.
 *
 * Se lee únicamente: campaign.json, clip_ids.json, METADATA\, QA\, REPORT\ y CLIPS\.
 * No se lee: .env, _work, SOURCE, FAILED, backups, resultados ni código Python.
 */
import path from 'node:path'
import { isDir, isFile, listDir, readJson } from './files'

export interface ScanIssue {
  level: 'warning' | 'error'
  code: string
  message: string
  path?: string
  clipId?: string
}

export interface ParsedClip {
  clip_id: string
  campaign_id: string | null
  metadata_version: number | null
  filename: string | null
  full_path: string | null
  title: string | null
  caption: string | null
  hashtags: string | null
  language: string | null
  duration: number | null
  source: string | null
  start_time: number | null
  end_time: number | null
  score: number | null
  score_origin: string | null
  selection_reason: string | null
  prediction: string | null
  qa_score: number | null
  status: string | null
  sha256: string | null
  created_at: string | null
  cover_second: number | null
  metadata_errors: string | null
  metadata_path: string
  metadata_json: string
  requested_start_time: number | null
  requested_end_time: number | null
  qa_path: string | null
  qa_summary: string | null
  qa_sheet_path: string | null
  cover_path: string | null
}

export interface ParsedCampaign {
  folderName: string
  sourcePath: string
  campaignJsonPath: string
  campaignId: string | null
  campaignIdOrigin: 'clip_ids' | 'report' | 'metadata' | null
  displayName: string | null
  /** campaign.json "publish_checklist": lista de cosas que hacer al publicar, como JSON; null si no hay. */
  publishChecklist: string | null
  platform: string | null
  language: string | null
  reportDate: string | null
  clipsGenerated: number | null
  clipsRejected: number | null
  /** Fichas clip_*.json encontradas en METADATA (legibles o no). */
  metadataFiles: number
  /** MP4 presentes en CLIPS. */
  clipFiles: number
  /** false si alguna ficha no se pudo leer o asociar: no se puede saber qué clips faltan de verdad. */
  complete: boolean
  /** true si la campaña no se puede importar en esta pasada (se conserva lo que hubiera). */
  fatal: boolean
  clips: ParsedClip[]
  issues: ScanIssue[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v))

/** Una subcarpeta es una campaña si contiene campaign.json. */
export function listCampaignFolders(root: string): string[] {
  return listDir(root).filter((n) => !n.startsWith('.') && isDir(path.join(root, n)) && isFile(path.join(root, n, 'campaign.json')))
}

export function scanCampaign(root: string, folderName: string): ParsedCampaign {
  const dir = path.join(root, folderName)
  const out: ParsedCampaign = {
    folderName,
    sourcePath: dir,
    campaignJsonPath: path.join(dir, 'campaign.json'),
    campaignId: null,
    campaignIdOrigin: null,
    displayName: null,
    publishChecklist: null,
    platform: null,
    language: null,
    reportDate: null,
    clipsGenerated: null,
    clipsRejected: null,
    metadataFiles: 0,
    clipFiles: 0,
    complete: true,
    fatal: false,
    clips: [],
    issues: []
  }
  const issue = (level: ScanIssue['level'], code: string, message: string, p?: string, clipId?: string) =>
    out.issues.push({ level, code, message, path: p, clipId })

  // ---- campaign.json
  const cfgRead = readJson(out.campaignJsonPath)
  const cfg = cfgRead.ok ? obj(cfgRead.value) : null
  if (!cfg) {
    issue('error', 'campaign_json_corrupt', `campaign.json ilegible: ${cfgRead.ok ? 'no es un objeto' : cfgRead.error}`, out.campaignJsonPath)
    out.fatal = true
    out.complete = false
    return out
  }
  out.displayName = str(cfg.name)
  out.platform = str(cfg.platform)
  const lista = Array.isArray(cfg.publish_checklist)
    ? cfg.publish_checklist.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '').map((x: string) => x.trim().slice(0, 500)).slice(0, 40)
    : []
  out.publishChecklist = lista.length ? JSON.stringify(lista) : null
  out.language = str(cfg.language)

  // ---- clip_ids.json (registro de identidades del generador)
  const ledgerPath = path.join(dir, 'clip_ids.json')
  const ledgerRead = readJson(ledgerPath)
  let ledgerId: string | null = null
  const anchors = new Map<string, { start: number | null; end: number | null }>()
  if (ledgerRead.ok) {
    const ledger = obj(ledgerRead.value)
    if (ledger && Array.isArray(ledger.clips)) {
      ledgerId = str(ledger.campaign_id)
      for (const c of ledger.clips) {
        const o = obj(c)
        const id = o ? str(o.clip_id) : null
        if (o && id) anchors.set(id, { start: num(o.start_time), end: num(o.end_time) })
      }
    } else {
      issue('warning', 'clip_ids_corrupt', 'clip_ids.json con formato no reconocido: se usan las fichas', ledgerPath)
    }
  } else if (!ledgerRead.missing) {
    issue('warning', 'clip_ids_corrupt', `clip_ids.json ilegible: ${ledgerRead.error}. Se usan las fichas`, ledgerPath)
  }

  // ---- REPORT\campaign_report.json
  let reportId: string | null = null
  const reportPath = path.join(dir, 'REPORT', 'campaign_report.json')
  const reportRead = readJson(reportPath)
  if (reportRead.ok) {
    const rep = obj(reportRead.value)
    if (rep) {
      reportId = str(rep.campaign_id)
      out.reportDate = str(rep.date)
      out.clipsGenerated = num(rep.clips_generated)
      out.clipsRejected = num(rep.clips_rejected)
    }
  } else if (!reportRead.missing) {
    issue('warning', 'report_corrupt', `campaign_report.json ilegible: ${reportRead.error}`, reportPath)
  }

  // ---- QA\clip_*.json: se asocian a la ficha por clip_id y, si no lo llevan, por nombre de archivo
  const qaDir = path.join(dir, 'QA')
  const qaById = new Map<string, { path: string; summary: string | null }>()
  const qaByFile = new Map<string, { path: string; summary: string | null }>()
  for (const f of listDir(qaDir)) {
    if (!/^clip_.*\.json$/i.test(f)) continue
    const r = readJson(path.join(qaDir, f))
    const q = r.ok ? obj(r.value) : null
    if (!q) continue
    const dato = { path: path.join(qaDir, f), summary: json(q.summary) }
    const id = str(q.clip_id)
    const fn = str(q.filename)
    if (id) qaById.set(id, dato)
    if (fn) qaByFile.set(fn.toLowerCase(), dato)
  }

  // ---- CLIPS
  out.clipFiles = listDir(path.join(dir, 'CLIPS')).filter((f) => f.toLowerCase().endsWith('.mp4')).length

  // ---- METADATA\clip_*.json
  const metaDir = path.join(dir, 'METADATA')
  const fichas = listDir(metaDir).filter((f) => /^clip_.*\.json$/i.test(f))
  out.metadataFiles = fichas.length
  const leidas: { clip: ParsedClip; fichaCampaignId: string | null }[] = []
  for (const f of fichas) {
    const ruta = path.join(metaDir, f)
    const r = readJson(ruta)
    const m = r.ok ? obj(r.value) : null
    if (!m) {
      issue('error', 'metadata_corrupt', `ficha ilegible: ${r.ok ? 'no es un objeto' : r.error}`, ruta)
      out.complete = false
      continue
    }
    const clipId = str(m.clip_id)
    if (!clipId) {
      issue('warning', 'metadata_without_clip_id', 'ficha sin clip_id: no se importa (CONTENT OS no inventa identidades)', ruta)
      out.complete = false
      continue
    }
    const stem = f.replace(/\.json$/i, '')
    const portada = path.join(metaDir, `${stem}_portada.jpg`)
    const filename = str(m.filename)
    const qa = qaById.get(clipId) ?? (filename ? qaByFile.get(filename.toLowerCase()) : undefined)
    const hoja = qa ? qa.path.replace(/\.json$/i, '.png') : null
    const ancla = anchors.get(clipId)
    const clip: ParsedClip = {
      clip_id: clipId,
      campaign_id: str(m.campaign_id),
      metadata_version: num(m.metadata_version),
      filename,
      full_path: str(m.full_path),
      title: str(m.title),
      caption: str(m.caption),
      hashtags: Array.isArray(m.hashtags) ? JSON.stringify(m.hashtags) : null,
      language: str(m.language),
      duration: num(m.duration),
      source: str(m.source),
      start_time: num(m.start_time),
      end_time: num(m.end_time),
      score: num(m.score),
      score_origin: str(m.score_origin),
      selection_reason: str(m.selection_reason),
      prediction: json(m.prediction),
      qa_score: num(m.qa_score),
      status: str(m.status),
      sha256: str(m.sha256),
      created_at: str(m.created_at),
      cover_second: num(m.cover_second),
      metadata_errors: Array.isArray(m.metadata_errors) && m.metadata_errors.length ? JSON.stringify(m.metadata_errors) : null,
      metadata_path: ruta,
      metadata_json: JSON.stringify(m),
      requested_start_time: ancla?.start ?? null,
      requested_end_time: ancla?.end ?? null,
      qa_path: qa?.path ?? null,
      qa_summary: qa?.summary ?? null,
      qa_sheet_path: hoja && isFile(hoja) ? hoja : null,
      cover_path: isFile(portada) ? portada : null
    }
    const faltan = (['filename', 'title', 'caption', 'duration', 'sha256', 'full_path', 'created_at'] as const).filter((k) => clip[k] === null)
    if (faltan.length) {
      issue('warning', 'metadata_partial', `ficha incompleta, faltan: ${faltan.join(', ')}`, ruta, clipId)
    }
    leidas.push({ clip, fichaCampaignId: clip.campaign_id })
  }

  // ---- dos fichas con el mismo clip_id dentro de la campaña: no se importa ninguna
  const veces = new Map<string, number>()
  for (const l of leidas) veces.set(l.clip.clip_id, (veces.get(l.clip.clip_id) ?? 0) + 1)
  const unicas = leidas.filter((l) => {
    if ((veces.get(l.clip.clip_id) ?? 0) > 1) {
      issue('error', 'duplicate_clip_id', 'clip_id repetido en dos fichas de la misma campaña: no se importa ninguna', l.clip.metadata_path, l.clip.clip_id)
      out.complete = false
      return false
    }
    return true
  })

  // ---- campaign_id: 1) clip_ids.json  2) informe  3) fichas. Sin decidir en silencio si discrepan.
  const idsFichas = [...new Set(unicas.map((l) => l.fichaCampaignId).filter((x): x is string => !!x))]
  if (ledgerId && reportId && ledgerId !== reportId) {
    issue('error', 'campaign_id_conflict', `campaign_id distinto en clip_ids.json (${ledgerId}) y en el informe (${reportId})`, dir)
    out.fatal = true
    out.complete = false
    return out
  }
  if (ledgerId) {
    out.campaignId = ledgerId
    out.campaignIdOrigin = 'clip_ids'
  } else if (reportId) {
    out.campaignId = reportId
    out.campaignIdOrigin = 'report'
  } else if (idsFichas.length === 1) {
    out.campaignId = idsFichas[0]
    out.campaignIdOrigin = 'metadata'
  } else if (idsFichas.length > 1) {
    issue('error', 'campaign_id_conflict', `las fichas declaran varios campaign_id: ${idsFichas.join(', ')}`, dir)
    out.fatal = true
    out.complete = false
    return out
  } else {
    issue('warning', 'campaign_without_id', 'campaña sin campaign_id (sin clip_ids.json, informe ni fichas con identidad): no se importa', dir)
    out.fatal = true
    out.complete = false
    return out
  }

  for (const l of unicas) {
    if (l.fichaCampaignId && l.fichaCampaignId !== out.campaignId) {
      issue('error', 'campaign_id_conflict', `la ficha declara campaign_id ${l.fichaCampaignId} y la campaña es ${out.campaignId}: no se importa`, l.clip.metadata_path, l.clip.clip_id)
      out.complete = false
      continue
    }
    out.clips.push(l.clip)
  }
  return out
}
