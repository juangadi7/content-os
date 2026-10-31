/** Datos de la pantalla de estadísticas. Solo lectura sobre lo que ya hay guardado. */
import type { DB } from './db'
import type { Platform } from './format'
import { estimateEarning, type EarningState } from './money'
import { listChannels, type ChannelView } from './youtube-channels'

export interface StatsVideo {
  publicationId: number
  clipId: string
  title: string | null
  campaignId: string
  campaignName: string
  platform: Platform
  account: string
  url: string | null
  publishedAt: string | null
  hasThumb: boolean
  thumbVersion: number | null
  score: number | null
  qaScore: number | null
  /** Última medición; null si aún no se ha podido medir. */
  views: number | null
  likes: number | null
  comments: number | null
  measuredAt: string | null
  /** Número de mediciones guardadas. */
  measurements: number
  /** Visitas ganadas desde la medición anterior, y cuándo fue esa medición. */
  viewsDelta: number | null
  previousAt: string | null
  /** Visitas por día desde que se publicó. */
  viewsPerDay: number | null
  /** (likes + comentarios) / visitas. */
  engagement: number | null
  /** auto | manual: cómo se asoció el vídeo de YouTube a este clip. null si se puso la URL a mano. */
  matchState: string | null
  matchReason: string | null
  videoId: string | null
  /** Dólares estimados según las condiciones de la campaña; null si no se puede calcular. */
  earning: number | null
  earningState: EarningState
  /** Visitas que faltan para llegar al mínimo de cobro. */
  missingViews: number | null
}

export interface StatsCampaign {
  campaignId: string
  name: string
  clips: number
  published: number
  measured: number
  views: number
  likes: number
  comments: number
  bestTitle: string | null
  bestViews: number | null
  /** Dólares estimados sumando sus vídeos; null si la campaña no tiene condiciones de pago. */
  earning: number | null
  /** Vídeos medidos que aún no llegan al mínimo de visitas. */
  belowMin: number
}

export interface StatsAccount {
  platform: Platform
  account: string
  published: number
  measured: number
  views: number
  /** Media de visitas por vídeo medido. */
  average: number | null
  earning: number
  bestTitle: string | null
  bestViews: number | null
}

export interface UnmatchedVideo {
  videoId: string
  channelId: string
  channel: string | null
  title: string | null
  publishedAt: string | null
  durationSeconds: number | null
  views: number | null
  likes: number | null
  comments: number | null
  state: string
}

export interface ClipOption {
  clipId: string
  title: string
  campaignName: string
  duration: number | null
}

export interface StatsView {
  totals: { views: number; likes: number; comments: number; measured: number; published: number; lastMeasuredAt: string | null; earning: number; belowMin: number }
  videos: StatsVideo[]
  campaigns: StatsCampaign[]
  /** Lo mismo, por canal de publicación: para comparar cuál rinde mejor. */
  accounts: StatsAccount[]
  channels: ChannelView[]
  unmatched: UnmatchedVideo[]
  ignored: number
  /** Clips entre los que elegir al emparejar a mano. */
  clipOptions: ClipOption[]
}

type Row = Record<string, any>

export function getStats(db: DB, now: Date = new Date()): StatsView {
  const pubs = db.prepare(
    `SELECT p.*, k.title, k.campaign_id, k.score, k.qa_score, k.thumb_path, k.cover_mtime_ms,
       COALESCE(c.display_name, c.folder_name) AS campaign_name, c.pay_rate, c.min_views, c.max_payout,
       y.video_id, y.match_state, y.match_reason
     FROM publications p
     JOIN clips k ON k.clip_id = p.clip_id
     JOIN campaigns c ON c.campaign_id = k.campaign_id
     LEFT JOIN youtube_videos y ON y.publication_id = p.id
     WHERE p.status = 'published'`
  ).all() as Row[]
  const mediciones = db.prepare('SELECT measured_at, views, likes, comments FROM analytics_snapshots WHERE publication_id = ? ORDER BY measured_at DESC, id DESC LIMIT 2')
  const cuantas = db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots WHERE publication_id = ?')

  const videos: StatsVideo[] = pubs.map((p) => {
    const [ult, ant] = mediciones.all(p.id) as Row[]
    const views: number | null = ult?.views ?? null
    const ganado = estimateEarning(views, { payRate: p.pay_rate, minViews: p.min_views, maxPayout: p.max_payout })
    const dias = p.published_at ? (now.getTime() - new Date(p.published_at).getTime()) / 86_400_000 : null
    return {
      publicationId: p.id, clipId: p.clip_id, title: p.title, campaignId: p.campaign_id, campaignName: p.campaign_name,
      platform: p.platform, account: p.account, url: p.url, publishedAt: p.published_at, hasThumb: !!p.thumb_path,
      thumbVersion: p.cover_mtime_ms ?? null, score: p.score, qaScore: p.qa_score,
      views, likes: ult?.likes ?? null, comments: ult?.comments ?? null, measuredAt: ult?.measured_at ?? null,
      measurements: (cuantas.get(p.id) as Row).n,
      viewsDelta: ult && ant && ult.views != null && ant.views != null ? ult.views - ant.views : null,
      previousAt: ant?.measured_at ?? null,
      viewsPerDay: views != null && dias != null && dias > 0 ? views / Math.max(dias, 1 / 24) : null,
      engagement: views ? ((ult.likes ?? 0) + (ult.comments ?? 0)) / views : null,
      matchState: p.match_state ?? null, matchReason: p.match_reason ?? null, videoId: p.video_id ?? null,
      earning: ganado.amount, earningState: ganado.state, missingViews: ganado.missingViews
    }
  })
  // primero los medidos, de más a menos visitas; después los que aún no tienen cifras
  videos.sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.publicationId - b.publicationId)

  const campañas = new Map<string, StatsCampaign>()
  const filasCamp = db.prepare(
    `SELECT c.campaign_id, COALESCE(c.display_name, c.folder_name) AS name, c.pay_rate,
       (SELECT COUNT(*) FROM clips k WHERE k.campaign_id = c.campaign_id AND k.present_in_source = 1) AS clips
     FROM campaigns c`
  ).all() as Row[]
  for (const c of filasCamp) {
    campañas.set(c.campaign_id, { campaignId: c.campaign_id, name: c.name, clips: c.clips, published: 0, measured: 0, views: 0, likes: 0, comments: 0, bestTitle: null, bestViews: null, earning: c.pay_rate == null ? null : 0, belowMin: 0 })
  }
  const clipsPublicados = new Map<string, Set<string>>()
  for (const v of videos) {
    const c = campañas.get(v.campaignId)
    if (!c) continue
    if (!clipsPublicados.has(v.campaignId)) clipsPublicados.set(v.campaignId, new Set())
    clipsPublicados.get(v.campaignId)!.add(v.clipId)
    if (v.views == null) continue
    c.measured++
    c.views += v.views
    c.likes += v.likes ?? 0
    c.comments += v.comments ?? 0
    if (c.earning != null) c.earning = Math.round((c.earning + (v.earning ?? 0)) * 100) / 100
    if (v.earningState === 'below_min') c.belowMin++
    if (c.bestViews == null || v.views > c.bestViews) {
      c.bestViews = v.views
      c.bestTitle = v.title
    }
  }
  for (const [id, set] of clipsPublicados) campañas.get(id)!.published = set.size
  const campaigns = [...campañas.values()].filter((c) => c.published > 0).sort((a, b) => b.views - a.views || a.name.localeCompare(b.name))

  const porCanal = new Map<string, StatsAccount>()
  for (const v of videos) {
    const clave = `${v.platform}|${v.account.toLowerCase()}`
    const a = porCanal.get(clave) ?? { platform: v.platform, account: v.account || '(sin cuenta)', published: 0, measured: 0, views: 0, average: null, earning: 0, bestTitle: null, bestViews: null }
    a.published++
    if (v.views != null) {
      a.measured++
      a.views += v.views
      a.earning = Math.round((a.earning + (v.earning ?? 0)) * 100) / 100
      if (a.bestViews == null || v.views > a.bestViews) {
        a.bestViews = v.views
        a.bestTitle = v.title
      }
    }
    a.average = a.measured ? a.views / a.measured : null
    porCanal.set(clave, a)
  }
  const accounts = [...porCanal.values()].sort((a, b) => b.views - a.views || a.account.localeCompare(b.account))

  const medidos = videos.filter((v) => v.views != null)
  const sinEmparejar = db.prepare(
    `SELECT y.*, COALESCE(c.handle, c.title) AS channel FROM youtube_videos y JOIN youtube_channels c ON c.channel_id = y.channel_id
     WHERE c.kind = 'clips' AND y.publication_id IS NULL AND y.match_state IN ('unmatched', 'review') ORDER BY y.published_at DESC`
  ).all() as Row[]
  const opciones = db.prepare(
    `SELECT k.clip_id, k.title, k.filename, k.duration, COALESCE(c.display_name, c.folder_name) AS campaign_name
     FROM clips k JOIN campaigns c ON c.campaign_id = k.campaign_id ORDER BY campaign_name, k.title`
  ).all() as Row[]

  return {
    totals: {
      views: medidos.reduce((s, v) => s + (v.views ?? 0), 0),
      likes: medidos.reduce((s, v) => s + (v.likes ?? 0), 0),
      comments: medidos.reduce((s, v) => s + (v.comments ?? 0), 0),
      measured: medidos.length,
      published: videos.length,
      lastMeasuredAt: medidos.map((v) => v.measuredAt!).sort().pop() ?? null,
      earning: Math.round(videos.reduce((s, v) => s + (v.earning ?? 0), 0) * 100) / 100,
      belowMin: videos.filter((v) => v.earningState === 'below_min').length
    },
    videos,
    campaigns,
    accounts,
    channels: listChannels(db),
    unmatched: sinEmparejar.map((y) => ({
      videoId: y.video_id, channelId: y.channel_id, channel: y.channel, title: y.title, publishedAt: y.published_at,
      durationSeconds: y.duration_seconds, views: y.views, likes: y.likes, comments: y.comments, state: y.match_state
    })),
    ignored: (db.prepare("SELECT COUNT(*) AS n FROM youtube_videos y JOIN youtube_channels c ON c.channel_id = y.channel_id WHERE c.kind = 'clips' AND y.match_state = 'ignored'").get() as Row).n,
    clipOptions: opciones.map((k) => ({ clipId: k.clip_id, title: k.title ?? k.filename ?? k.clip_id, campaignName: k.campaign_name, duration: k.duration }))
  }
}


