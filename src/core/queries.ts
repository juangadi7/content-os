/** Consultas de lectura para la interfaz. Los tipos son los que cruzan el IPC. */
import { latestSnapshot, type SnapshotView } from './analytics'
import { purgedAt, purgeOn } from './purge'
import { submissionFor, type VyroSubmissionView } from './vyro-submissions'
import type { DB } from './db'
import { isDir } from './files'
import { parseHashtags, PLATFORMS, type Platform } from './format'

export interface LibraryView {
  id: number
  path: string
  enabled: boolean
  available: boolean
  lastSyncAt: string | null
  campaigns: number
}

export interface CampaignView {
  campaignId: string
  displayName: string
  folderName: string
  platform: string | null
  language: string | null
  date: string | null
  state: string
  presentInSource: boolean
  missingSince: string | null
  lastSyncAt: string
  clips: number
  clipsReady: number
  clipsMissingFile: number
  clipsRejected: number | null
  clipsPublished: number
  bestScore: number | null
  /** Último día de plazo (AAAA-MM-DD), si el usuario lo ha indicado. */
  endsAt: string | null
  /** Cerrada: la marcó el usuario o ya pasó su último día. */
  closed: boolean
  closedManually: boolean
  /** Días que quedan contando hoy; null si no hay fecha de fin o ya está cerrada. */
  daysLeft: number | null
  /** Condiciones de pago: dólares por 1.000 visitas, mínimo de visitas y tope por vídeo. null = sin dato. */
  payRate: number | null
  minViews: number | null
  maxPayout: number | null
  /** Lo que piden las reglas de la campaña al publicar (campaign.json "publish_checklist"). */
  checklist: string[]
  /** Día en que su carpeta irá a la Papelera (una semana después de acabar); null si no tiene fin. */
  purgeOn: string | null
  /** Cuándo se mandó a la Papelera, si ya se hizo. */
  purgedAt: string | null
  /** Portadas de sus mejores clips (hasta 4, en orden de calidad), para reconocerla de un vistazo. */
  covers: { clipId: string; thumbVersion: number | null }[]
}

export interface ClipView {
  /** Puesto en el orden de calidad dentro de la lista pedida (1 = mejor). */
  position: number
  clipId: string
  campaignId: string
  campaignName: string
  filename: string | null
  title: string | null
  duration: number | null
  score: number | null
  scoreOrigin: string | null
  qaScore: number | null
  status: string | null
  fileState: string
  presentInSource: boolean
  hasThumb: boolean
  thumbVersion: number | null
  /** La campaña de este clip ya está cerrada: no cuenta como pendiente. */
  campaignClosed: boolean
  /** Cuándo terminó de generarse el clip (ISO), según su ficha. */
  createdAt: string | null
  /** Plataformas en las que está publicado. */
  published: string[]
  /** Dónde está publicado: plataforma y canal (vacío si no se sabe el canal). */
  publishedOn: { platform: string; account: string }[]
}

export interface PublicationView {
  id: number
  clipId: string
  platform: Platform
  account: string
  status: string
  url: string | null
  publishedAt: string | null
  notes: string | null
  titleUsed: string | null
  captionUsed: string | null
  sha256AtPublish: string | null
  /** true si el clip se ha vuelto a renderizar después de publicarlo. */
  renderChangedSince: boolean
  /** Última medición guardada (visitas, likes, comentarios), si hay alguna. */
  latest: SnapshotView | null
  /** Lo que dice Vyro de este envío (estado, visitas, ganado), si tu cuenta de Vyro está conectada. */
  vyro: VyroSubmissionView | null
  /** Cuándo se envió a Vyro (o se dio por enviado). */
  vyroSentAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ClipDetail extends ClipView {
  caption: string | null
  hashtags: string[]
  language: string | null
  source: string | null
  startTime: number | null
  endTime: number | null
  requestedStartTime: number | null
  requestedEndTime: number | null
  selectionReason: string | null
  /** Predicción heredada de la ficha (hoy siempre null). CONTENT OS aún no predice nada. */
  prediction: string | null
  sha256: string | null
  fileSha256: string | null
  createdAt: string | null
  renderChangedAt: string | null
  fullPath: string | null
  resolvedPath: string | null
  missingSince: string | null
  qaSummary: Record<string, string> | null
  hasQaSheet: boolean
  publications: PublicationView[]
  /** Cuentas ya usadas en cada plataforma, para sugerirlas al publicar. */
  knownAccounts: Record<Platform, string[]>
  /** Lo que piden las reglas de su campaña al publicar. */
  checklist: string[]
}

export interface PublishedRow {
  publication: PublicationView
  clip: ClipView
}

export interface Counts {
  campaigns: number
  clips: number
  published: number
  pending: number
}

export interface SyncRunView {
  id: number
  startedAt: string
  finishedAt: string | null
  status: string
  rootsScanned: number
  campaignsSeen: number
  clipsSeen: number
  created: number
  updated: number
  disappeared: number
  warnings: number
  errors: number
}

export interface SyncEventView {
  id: number
  createdAt: string
  level: string
  type: string
  code: string | null
  campaignId: string | null
  clipId: string | null
  path: string | null
  message: string | null
}

type Row = Record<string, any>

/** Fecha local de hoy, AAAA-MM-DD. */
export function today(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Una campaña está cerrada si el usuario la cerró o si ya pasó su último día de plazo. */
const CERRADA = '(c.closed = 1 OR (c.ends_at IS NOT NULL AND c.ends_at < @hoy))'

/**
 * Orden de calidad mientras no exista predicción:
 *   score DESC (los clips sin score van después, nunca como 0) -> qa_score DESC -> clip_id ASC.
 * Los clips que ya no están en el generador quedan al final.
 */
const ORDEN = `k.present_in_source DESC, (k.score IS NULL), k.score DESC, (k.qa_score IS NULL), k.qa_score DESC, k.clip_id ASC`

const CLIP_SELECT = `
  SELECT k.*, COALESCE(c.display_name, c.folder_name) AS campaign_name, c.publish_checklist AS campaign_checklist, ${CERRADA} AS campaign_closed,
    (SELECT GROUP_CONCAT(DISTINCT p.platform) FROM publications p
     WHERE p.clip_id = k.clip_id AND p.status = 'published') AS published,
    (SELECT GROUP_CONCAT(p.platform || char(31) || COALESCE(p.account, ''), char(30)) FROM publications p
     WHERE p.clip_id = k.clip_id AND p.status = 'published') AS published_on
  FROM clips k JOIN campaigns c ON c.campaign_id = k.campaign_id`

/** "youtube\x1f@canal\x1etiktok\x1f" -> [{ platform, account }], sin repetidos y en el orden de PLATFORMS. La cuenta "@canal · <id>" (segundo vídeo en el mismo canal) se queda en "@canal". */
function dondePublicado(v: unknown): { platform: string; account: string }[] {
  if (!v) return []
  const vistos = new Set<string>()
  const out: { platform: string; account: string }[] = []
  for (const par of String(v).split('\x1e')) {
    const [platform, cuenta = ''] = par.split('\x1f')
    const account = cuenta.replace(/ · .*$/, '').trim()
    const clave = platform + '|' + account.toLowerCase()
    if (!platform || vistos.has(clave)) continue
    vistos.add(clave)
    out.push({ platform, account })
  }
  return out.sort((a, b) => PLATFORMS.indexOf(a.platform as never) - PLATFORMS.indexOf(b.platform as never))
}

function clipView(k: Row, position: number): ClipView {
  const pubs = k.published ? String(k.published).split(',') : []
  return {
    position, clipId: k.clip_id, campaignId: k.campaign_id, campaignName: k.campaign_name, filename: k.filename, title: k.title,
    duration: k.duration, score: k.score, scoreOrigin: k.score_origin, qaScore: k.qa_score, status: k.status,
    fileState: k.file_state, presentInSource: k.present_in_source === 1, hasThumb: !!k.thumb_path, campaignClosed: k.campaign_closed === 1, createdAt: k.created_at ?? null,
    thumbVersion: k.cover_mtime_ms ?? null, published: PLATFORMS.filter((p) => pubs.includes(p)),
    publishedOn: dondePublicado(k.published_on)
  }
}

function publicationView(db: DB, p: Row, clipSha: string | null): PublicationView {
  return {
    id: p.id, clipId: p.clip_id, platform: p.platform, account: p.account, status: p.status, url: p.url,
    publishedAt: p.published_at, notes: p.notes, titleUsed: p.title_used, captionUsed: p.caption_used,
    sha256AtPublish: p.sha256_at_publish,
    renderChangedSince: !!p.sha256_at_publish && !!clipSha && p.sha256_at_publish !== clipSha,
    latest: latestSnapshot(db, p.id), vyro: submissionFor(db, p.id), vyroSentAt: p.vyro_sent_at ?? null, createdAt: p.created_at, updatedAt: p.updated_at
  }
}

export function listLibraries(db: DB): LibraryView[] {
  const filas = db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM campaigns c WHERE c.root_id = r.id) AS campaigns
     FROM library_roots r ORDER BY r.enabled DESC, r.path`
  ).all() as Row[]
  return filas.map((r) => ({
    id: r.id, path: r.path, enabled: r.enabled === 1, available: isDir(r.path), lastSyncAt: r.last_sync_at, campaigns: r.campaigns
  }))
}

/** Campañas: primero las abiertas, y dentro de cada grupo la más reciente primero. */
export function listCampaigns(db: DB, now: Date = new Date()): CampaignView[] {
  const hoy = today(now)
  const filas = db.prepare(
    `SELECT c.*, ${CERRADA} AS is_closed,
       (SELECT COUNT(*) FROM clips k WHERE k.campaign_id = c.campaign_id AND k.present_in_source = 1) AS n_clips,
       (SELECT COUNT(*) FROM clips k WHERE k.campaign_id = c.campaign_id AND k.present_in_source = 1 AND k.status = 'READY') AS n_ready,
       (SELECT COUNT(*) FROM clips k WHERE k.campaign_id = c.campaign_id AND k.present_in_source = 1 AND k.file_state = 'missing') AS n_missing,
       (SELECT MAX(k.score) FROM clips k WHERE k.campaign_id = c.campaign_id AND k.present_in_source = 1) AS best_score,
       (SELECT COUNT(DISTINCT p.clip_id) FROM publications p JOIN clips k ON k.clip_id = p.clip_id
          WHERE k.campaign_id = c.campaign_id AND p.status = 'published') AS n_published
     FROM campaigns c
     ORDER BY c.present_in_source DESC, is_closed ASC, COALESCE(c.report_date, c.created_at) DESC, c.created_at DESC, c.campaign_id`
  ).all({ hoy }) as Row[]
  const portadas = db.prepare(`SELECT k.clip_id, k.cover_mtime_ms FROM clips k WHERE k.campaign_id = ? AND k.present_in_source = 1 AND k.thumb_path IS NOT NULL ORDER BY ${ORDEN} LIMIT 4`)
  return filas.map((c) => ({
    campaignId: c.campaign_id, displayName: c.display_name ?? c.folder_name, folderName: c.folder_name, platform: c.platform,
    language: c.language, date: c.report_date, state: c.state, presentInSource: c.present_in_source === 1,
    missingSince: c.missing_since, lastSyncAt: c.last_sync_at, clips: c.n_clips, clipsReady: c.n_ready,
    clipsMissingFile: c.n_missing, clipsRejected: c.clips_rejected, clipsPublished: c.n_published, bestScore: c.best_score,
    endsAt: c.ends_at, closed: c.is_closed === 1, closedManually: c.closed === 1, payRate: c.pay_rate, minViews: c.min_views, maxPayout: c.max_payout, checklist: parseHashtags(c.publish_checklist),
    daysLeft: c.is_closed === 1 || !c.ends_at ? null : Math.round((Date.parse(c.ends_at + 'T00:00:00Z') - Date.parse(hoy + 'T00:00:00Z')) / 86_400_000) + 1,
    purgeOn: purgeOn(c.ends_at, c.closed === 1 ? c.closed_at : null), purgedAt: purgedAt(db, c.campaign_id),
    covers: (portadas.all(c.campaign_id) as Row[]).map((k) => ({ clipId: k.clip_id as string, thumbVersion: (k.cover_mtime_ms as number | null) ?? null }))
  }))
}

export function getCampaign(db: DB, campaignId: string, now: Date = new Date()): CampaignView | null {
  return listCampaigns(db, now).find((c) => c.campaignId === campaignId) ?? null
}

/** Clips de una campaña (o de todas, con campaignId null), en orden de calidad. */
export function listClips(db: DB, campaignId: string | null, now: Date = new Date()): ClipView[] {
  const hoy = today(now)
  const filas = (campaignId
    ? db.prepare(`${CLIP_SELECT} WHERE k.campaign_id = @id ORDER BY ${ORDEN}`).all({ id: campaignId, hoy })
    : db.prepare(`${CLIP_SELECT} ORDER BY ${ORDEN}`).all({ hoy })) as Row[]
  return filas.map((k, i) => clipView(k, i + 1))
}

export function getClip(db: DB, clipId: string): ClipDetail | null {
  const k = db.prepare(`${CLIP_SELECT} WHERE k.clip_id = @id`).get({ id: clipId, hoy: today() }) as Row | undefined
  if (!k) return null
  // el puesto es el que tiene dentro de su campaña
  const orden = db.prepare(`SELECT k.clip_id FROM clips k WHERE k.campaign_id = ? ORDER BY ${ORDEN}`).all(k.campaign_id) as Row[]
  const position = orden.findIndex((o) => o.clip_id === clipId) + 1
  const pubs = db.prepare('SELECT * FROM publications WHERE clip_id = ? ORDER BY platform, account').all(clipId) as Row[]
  const cuentas = db.prepare(
    "SELECT platform, name AS account FROM accounts UNION SELECT platform, account FROM publications WHERE account <> '' ORDER BY account"
  ).all() as Row[]
  const knownAccounts = { youtube: [], instagram: [], tiktok: [] } as Record<Platform, string[]>
  for (const c of cuentas) knownAccounts[c.platform as Platform]?.push(c.account)
  let qaSummary: Record<string, string> | null = null
  try {
    qaSummary = k.qa_summary ? JSON.parse(k.qa_summary) : null
  } catch {
    qaSummary = null
  }
  return {
    ...clipView(k, position),
    caption: k.caption, hashtags: parseHashtags(k.hashtags), language: k.language, source: k.source,
    startTime: k.start_time, endTime: k.end_time, requestedStartTime: k.requested_start_time, requestedEndTime: k.requested_end_time,
    selectionReason: k.selection_reason, prediction: k.prediction, sha256: k.sha256, fileSha256: k.file_sha256,
    createdAt: k.created_at, renderChangedAt: k.render_changed_at, fullPath: k.full_path, resolvedPath: k.resolved_path,
    missingSince: k.missing_since, qaSummary, hasQaSheet: !!k.qa_sheet_path,
    publications: pubs.map((p) => publicationView(db, p, k.sha256)), knownAccounts, checklist: parseHashtags(k.campaign_checklist)
  }
}

/** Una fila por publicación, la más reciente primero. */
export function listPublished(db: DB): PublishedRow[] {
  const filas = db.prepare(
    `SELECT p.id AS pub_id FROM publications p WHERE p.status = 'published'
     ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC`
  ).all() as Row[]
  const out: PublishedRow[] = []
  for (const f of filas) {
    const p = db.prepare('SELECT * FROM publications WHERE id = ?').get(f.pub_id) as Row
    const k = db.prepare(`${CLIP_SELECT} WHERE k.clip_id = @id`).get({ id: p.clip_id, hoy: today() }) as Row
    out.push({ publication: publicationView(db, p, k.sha256), clip: clipView(k, 0) })
  }
  return out
}

export function counts(db: DB, now: Date = new Date()): Counts {
  const r = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM campaigns) AS campaigns,
       (SELECT COUNT(*) FROM clips k JOIN campaigns c ON c.campaign_id = k.campaign_id WHERE NOT ${CERRADA}) AS clips,
       (SELECT COUNT(DISTINCT clip_id) FROM publications WHERE status = 'published') AS published,
       (SELECT COUNT(*) FROM clips k JOIN campaigns c ON c.campaign_id = k.campaign_id WHERE k.present_in_source = 1 AND NOT ${CERRADA}
          AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.clip_id = k.clip_id AND p.status = 'published')) AS pending`
  ).get({ hoy: today(now) }) as Row
  return { campaigns: r.campaigns, clips: r.clips, published: r.published, pending: r.pending }
}

/** Ruta real del MP4 y de la miniatura de un clip: lo único que el proceso principal sirve o abre. */
export function clipPaths(db: DB, clipId: string): { video: string | null; thumb: string | null; qaSheet: string | null } | null {
  const k = db.prepare('SELECT resolved_path, thumb_path, qa_sheet_path FROM clips WHERE clip_id = ?').get(clipId) as Row | undefined
  return k ? { video: k.resolved_path, thumb: k.thumb_path, qaSheet: k.qa_sheet_path } : null
}

export function lastSyncRun(db: DB): SyncRunView | null {
  const r = db.prepare("SELECT * FROM sync_runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1").get() as Row | undefined
  if (!r) return null
  return {
    id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, rootsScanned: r.roots_scanned,
    campaignsSeen: r.campaigns_seen, clipsSeen: r.clips_seen, created: r.created, updated: r.updated,
    disappeared: r.disappeared, warnings: r.warnings, errors: r.errors
  }
}

/** Avisos y errores de una sincronización (o de la última terminada). */
export function listSyncProblems(db: DB, runId?: number): SyncEventView[] {
  const id = runId ?? lastSyncRun(db)?.id
  if (id == null) return []
  const filas = db.prepare(
    "SELECT * FROM sync_events WHERE sync_run_id = ? AND level IN ('warning', 'error') ORDER BY id LIMIT 500"
  ).all(id) as Row[]
  return filas.map((e) => ({
    id: e.id, createdAt: e.created_at, level: e.level, type: e.type, code: e.code, campaignId: e.campaign_id,
    clipId: e.clip_id, path: e.path, message: e.message
  }))
}
