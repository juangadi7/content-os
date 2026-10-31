/**
 * Tus envíos en Vyro («My submissions»), leídos con tu sesión de Vyro: estado (pendiente, aprobado, rechazado),
 * visitas que cuenta Vyro y lo ganado. La app nunca envía nada a Vyro: solo lee lo que la propia web recibe.
 *
 * Cada envío se empareja con su publicación por el id del vídeo (YouTube, TikTok o Instagram). Al emparejar, la
 * publicación queda marcada como enviada a Vyro (sale de «Enviar a Vyro» sin tocar nada).
 */
import type { DB } from './db'
import { parseYouTubeVideoId } from './youtube'

type Row = Record<string, any>

export interface VyroSubmission {
  vyroClipId: string
  vyroCampaignId: string
  platform: string
  videoId: string | null
  videoUrl: string | null
  username: string | null
  status: string | null
  views: number | null
  likes: number | null
  comments: number | null
  earned: number | null
  cpm: number | null
  error: string | null
  submittedAt: string | null
  metricsAt: string | null
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Respuesta de «My submissions» de Vyro (JSON) → envíos. Solo se quedan los datos que usa la app. */
export function parseSubmissions(body: string): { items: VyroSubmission[]; nextPage: number | null } {
  const j = JSON.parse(body) as { data?: unknown; meta?: { page?: { next?: unknown } } }
  if (!Array.isArray(j.data)) throw new Error('Vyro no devolvió la lista de envíos.')
  const items: VyroSubmission[] = []
  for (const x of j.data as Row[]) {
    const id = txt(x?.id)
    const campaign = txt(x?.campaignId)
    const platform = txt(x?.platform)?.toLowerCase()
    if (!id || !campaign || !platform) continue
    items.push({
      vyroClipId: id, vyroCampaignId: campaign, platform,
      videoId: txt(x.videoId), videoUrl: txt(x.videoUrl) ?? txt(x.videoRawUrl), username: txt(x.platformUsername),
      status: txt(x.status?.id), views: num(x.metrics?.totalViews), likes: num(x.metrics?.totalLikes), comments: num(x.metrics?.totalComments),
      earned: num(x.earnings?.totalEarnings), cpm: num(x.earnings?.cpm),
      error: x.error == null ? null : typeof x.error === 'string' ? x.error : txt(x.error?.message) ?? JSON.stringify(x.error).slice(0, 300),
      submittedAt: txt(x.submissionDate) ?? txt(x.createdAt), metricsAt: txt(x.metrics?.lastMetricsUpdatedAt),
    })
  }
  const next = num(j.meta?.page?.next)
  return { items, nextPage: next }
}

/** Id del vídeo en su plataforma a partir del enlace guardado en la publicación. */
export function videoIdOf(platform: string, url: string | null | undefined): string | null {
  if (!url) return null
  if (platform === 'youtube') return parseYouTubeVideoId(url)
  if (platform === 'tiktok') return url.match(/\/video\/(\d+)/)?.[1] ?? null
  if (platform === 'instagram') return url.match(/instagram\.com\/(?:[^/]+\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]+)/)?.[1] ?? null
  return null
}

/** Campañas de Vyro cuyos envíos hay que leer: las enlazadas a una campaña tuya que no acabaron hace más de 3 semanas. */
export function campaignsToSync(db: DB, now: Date = new Date()): { vyroId: string; name: string }[] {
  const limite = new Date(now.getTime() - 21 * 86_400_000).toISOString()
  return (db.prepare(
    `SELECT vyro_id, COALESCE(name, slug) AS name FROM vyro_campaigns
     WHERE campaign_id IS NOT NULL AND (ends_at IS NULL OR ends_at >= ?) ORDER BY ends_at IS NULL, ends_at DESC`
  ).all(limite) as Row[]).map((r) => ({ vyroId: r.vyro_id as string, name: r.name as string }))
}

/**
 * Guarda los envíos leídos de una campaña y los empareja con tus publicaciones por el id del vídeo.
 * Devuelve cuántas publicaciones quedaron marcadas como enviadas por primera vez.
 */
/** Cuenta comparable: sin @, sin el « · id» que añade la app a veces, en minúsculas. */
const cuenta = (x: unknown) => String(x ?? '').replace(/ · .*$/, '').replace(/^@/, '').trim().toLowerCase()

export function saveSubmissions(db: DB, items: VyroSubmission[], now: Date = new Date()): { saved: number; newlySent: number } {
  const t = now.toISOString()
  const pubs = db.prepare("SELECT id, platform, account, url, published_at, vyro_sent_at FROM publications WHERE status = 'published'").all() as Row[]
  const porVideo = new Map<string, Row>()
  const sinId: Row[] = []
  for (const p of pubs) {
    const v = videoIdOf(p.platform, p.url)
    if (v) porVideo.set(`${p.platform}:${v}`, p)
    else sinId.push(p)
  }
  const usadas = new Set((db.prepare('SELECT publication_id FROM vyro_submissions WHERE publication_id IS NOT NULL').all() as Row[]).map((r) => r.publication_id as number))
  let newlySent = 0
  db.transaction(() => {
    for (const s of items) {
      const vid = s.videoId ?? videoIdOf(s.platform, s.videoUrl)
      const previa = db.prepare('SELECT publication_id FROM vyro_submissions WHERE vyro_clip_id = ?').get(s.vyroClipId) as Row | undefined
      let pub = vid ? porVideo.get(`${s.platform}:${vid}`) : undefined
      if (!pub && previa?.publication_id != null) pub = pubs.find((p) => p.id === previa.publication_id)
      // sin id del vídeo en la app (marcado sin enlace o con un enlace corto): misma plataforma, misma cuenta y publicado
      // poco antes del envío; si hay varias, la claramente más cercana. Entonces se le guarda el enlace que tiene Vyro.
      if (!pub && s.submittedAt) {
        const env = Date.parse(s.submittedAt)
        const candidatas = sinId.filter((p) => p.platform === s.platform && !usadas.has(p.id) && p.published_at && cuenta(p.account) === cuenta(s.username) &&
          Date.parse(p.published_at) <= env + 2 * 3600_000 && Date.parse(p.published_at) >= env - 3 * 86_400_000)
        // la más cercana al envío (se envía nada más publicar), si está a menos de un día y claramente más cerca que la siguiente
        const porCercania = candidatas.map((p) => ({ p, gap: Math.abs(env - Date.parse(p.published_at)) })).sort((x, y) => x.gap - y.gap)
        const clara = porCercania[0] && porCercania[0].gap <= 86_400_000 && (!porCercania[1] || porCercania[1].gap - porCercania[0].gap >= 3600_000)
        if (clara) {
          pub = porCercania[0].p
          if (s.videoUrl) db.prepare('UPDATE publications SET url = ?, updated_at = ? WHERE id = ? AND (url IS NULL OR url = ?)').run(s.videoUrl, t, pub.id, pub.url ?? null)
        }
      }
      if (pub) usadas.add(pub.id)
      db.prepare(
        `INSERT INTO vyro_submissions (vyro_clip_id, vyro_campaign_id, platform, video_id, video_url, username, status, views, likes, comments, earned, cpm, error, submitted_at, metrics_at, synced_at, publication_id)
         VALUES (@id, @campaign, @platform, @vid, @url, @user, @status, @views, @likes, @comments, @earned, @cpm, @error, @submitted, @metrics, @t, @pub)
         ON CONFLICT(vyro_clip_id) DO UPDATE SET status = excluded.status, views = excluded.views, likes = excluded.likes, comments = excluded.comments,
           earned = excluded.earned, cpm = excluded.cpm, error = excluded.error, metrics_at = excluded.metrics_at, synced_at = excluded.synced_at,
           video_url = excluded.video_url, username = excluded.username, publication_id = COALESCE(excluded.publication_id, vyro_submissions.publication_id)`
      ).run({
        id: s.vyroClipId, campaign: s.vyroCampaignId, platform: s.platform, vid, url: s.videoUrl, user: s.username, status: s.status,
        views: s.views, likes: s.likes, comments: s.comments, earned: s.earned, cpm: s.cpm, error: s.error, submitted: s.submittedAt,
        metrics: s.metricsAt, t, pub: pub?.id ?? null,
      })
      if (pub && !pub.vyro_sent_at) {
        db.prepare('UPDATE publications SET vyro_sent_at = ? WHERE id = ? AND vyro_sent_at IS NULL').run(s.submittedAt ?? t, pub.id)
        pub.vyro_sent_at = s.submittedAt ?? t
        newlySent++
      }
    }
  })()
  return { saved: items.length, newlySent }
}

export interface VyroSubmissionView {
  status: string | null
  views: number | null
  earned: number | null
  error: string | null
  syncedAt: string
}

/** Lo que dice Vyro de una publicación (el envío más reciente si hubiera varios). */
export function submissionFor(db: DB, publicationId: number): VyroSubmissionView | null {
  const r = db.prepare('SELECT status, views, earned, error, synced_at FROM vyro_submissions WHERE publication_id = ? ORDER BY submitted_at DESC LIMIT 1').get(publicationId) as Row | undefined
  return r ? { status: r.status, views: r.views, earned: r.earned, error: r.error, syncedAt: r.synced_at } : null
}

export interface VyroSubmissionsSummary {
  campaigns: {
    vyroId: string
    name: string
    total: number
    pending: number
    approved: number
    rejected: number
    views: number
    earned: number
    /** Envíos que la app no sabe de qué clip son (publicados sin enlace guardado, o de otra cuenta). */
    unmatched: number
  }[]
  earned: number
  lastSyncAt: string | null
}

const APROBADO = new Set(['active', 'approved'])
const RECHAZADO = new Set(['rejected', 'declined', 'removed', 'disqualified'])

export function submissionsSummary(db: DB): VyroSubmissionsSummary {
  const filas = db.prepare(
    `SELECT s.*, COALESCE(v.name, v.slug, s.vyro_campaign_id) AS campaign_name FROM vyro_submissions s
     LEFT JOIN vyro_campaigns v ON v.vyro_id = s.vyro_campaign_id`
  ).all() as Row[]
  const por = new Map<string, VyroSubmissionsSummary['campaigns'][number]>()
  for (const r of filas) {
    const c = por.get(r.vyro_campaign_id) ?? { vyroId: r.vyro_campaign_id, name: r.campaign_name, total: 0, pending: 0, approved: 0, rejected: 0, views: 0, earned: 0, unmatched: 0 }
    c.total++
    if (APROBADO.has(r.status)) c.approved++
    else if (RECHAZADO.has(r.status)) c.rejected++
    else c.pending++
    c.views += r.views ?? 0
    c.earned += r.earned ?? 0
    if (r.publication_id == null) c.unmatched++
    por.set(r.vyro_campaign_id, c)
  }
  const campaigns = [...por.values()].sort((a, b) => b.earned - a.earned || b.views - a.views)
  const last = db.prepare('SELECT MAX(synced_at) AS t FROM vyro_submissions').get() as Row
  return { campaigns, earned: Math.round(campaigns.reduce((s, c) => s + c.earned, 0) * 100) / 100, lastSyncAt: last.t ?? null }
}

/** Clasifica el estado de Vyro para enseñarlo: pendiente, aprobado o rechazado. */
export function statusKind(status: string | null): 'pending' | 'approved' | 'rejected' {
  return status && APROBADO.has(status) ? 'approved' : status && RECHAZADO.has(status) ? 'rejected' : 'pending'
}
