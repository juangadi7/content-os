/**
 * «Control de vídeos»: cada vídeo que tienes subido o programado, con su estado en Vyro, sin margen para dudas.
 *
 * Fuentes (de las últimas semanas):
 *   - tus publicaciones (lo marcado en la app: programado, TikTok, Instagram…);
 *   - los vídeos REALES de tus canales de YouTube de clips, estén o no emparejados con un clip;
 *   - tus envíos de Vyro leídos con tu sesión (por si hay alguno que la app no conoce).
 * El estado en Vyro se decide comparando por el id del vídeo con tus envíos reales, no con lo que se haya marcado.
 */
import type { DB } from './db'
import { isPlatform, PLATFORMS, type Platform } from './format'
import { today } from './queries'
import { videoIdOf } from './vyro-submissions'
import { clipsProbablyOnYouTube } from './youtube-channels'

type Row = Record<string, any>

export type VyroState = 'duplicate' | 'missing' | 'manual' | 'not_found' | 'unchecked' | 'scheduled' | 'in_vyro' | 'no_campaign' | 'ignored' | 'expired'

export interface ControlVideo {
  key: string
  platform: Platform
  account: string
  /** Id del vídeo en su plataforma (si se sabe). */
  videoId: string | null
  url: string | null
  title: string
  description: string | null
  /** Miniatura: la portada del clip o la de YouTube. */
  thumb: { kind: 'clip'; clipId: string; version: number | null } | { kind: 'youtube'; videoId: string } | null
  /** Cuándo sale o salió. */
  publishedAt: string | null
  scheduled: boolean
  /** Visitas en la plataforma (última medición). */
  views: number | null
  clipId: string | null
  publicationId: number | null
  campaignName: string | null
  /** Último día de la campaña (AAAA-MM-DD) y si ya pasó: entonces Vyro ya no lo acepta. */
  campaignEndsAt: string | null
  campaignEnded: boolean
  vyro: {
    state: VyroState
    /** Estado que da Vyro (pending, active, rejected…), si está allí. */
    status: string | null
    views: number | null
    earned: number | null
    submittedAt: string | null
    error: string | null
    /** Por qué tiene este estado (en palabras), cuando no es evidente. */
    reason: string | null
    /** Cuándo se leyeron por última vez tus envíos de esa campaña en Vyro. */
    checkedAt: string | null
  }
  /** Falta en Vyro y ya tiene visitas: lo que entre antes de enviarlo no se paga. */
  urgent: boolean
}

export interface VideoControl {
  videos: ControlVideo[]
  counts: Record<VyroState, number>
}

/** Tiempo tras publicar en el que todavía no se da por «falta» (se suele enviar a los pocos minutos). */
const MARGEN_MS = 15 * 60_000

/** Visitas a partir de las cuales un vídeo sin enviar es urgente. */
export const URGENT_VIEWS = 500

const ORDEN: Record<VyroState, number> = { duplicate: -1, missing: 0, manual: 1, not_found: 2, unchecked: 3, scheduled: 4, in_vyro: 5, no_campaign: 6, expired: 7, ignored: 8 }

const claveIgnorado = (key: string) => `control_ignorado:${key}`

/** «Ignorar» un vídeo en el control (p. ej. no lo envías a Vyro porque se quedó a cero), o deshacerlo. */
export function setControlIgnored(db: DB, key: unknown, ignored: boolean, now: Date = new Date()): void {
  if (typeof key !== 'string' || !/^[pyv][\w-]{1,80}$/.test(key)) throw new Error('Vídeo no válido.')
  if (ignored) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(claveIgnorado(key), now.toISOString())
  else db.prepare('DELETE FROM settings WHERE key = ?').run(claveIgnorado(key))
}

export function getVideoControl(db: DB, now: Date = new Date(), opts: { days?: number } = {}): VideoControl {
  const desde = new Date(now.getTime() - (opts.days ?? 21) * 86_400_000).toISOString()
  const ahora = now.toISOString()
  const hoy = today(now)

  // envíos de Vyro, por publicación y por vídeo
  const envios = db.prepare('SELECT * FROM vyro_submissions').all() as Row[]
  const envioPorPub = new Map<number, Row>()
  const envioPorVideo = new Map<string, Row>()
  for (const e of envios) {
    if (e.publication_id != null) envioPorPub.set(e.publication_id, e)
    if (e.video_id) envioPorVideo.set(`${e.platform}:${e.video_id}`, e)
  }
  const leidas = new Map((db.prepare("SELECT substr(key, 12) AS id, value FROM settings WHERE key LIKE 'vyro_leida:%'").all() as Row[]).map((r) => [r.id as string, r.value as string]))
  const vyroDeCampaña = new Map((db.prepare('SELECT campaign_id, vyro_id FROM vyro_campaigns WHERE campaign_id IS NOT NULL').all() as Row[]).map((r) => [r.campaign_id as string, r.vyro_id as string]))

  const videos: ControlVideo[] = []
  const vistos = new Set<string>() // platform:videoId ya puestos

  /**
   * «Falta en Vyro» solo con certeza: se sabe el id del vídeo y tus envíos de esa campaña se leyeron DESPUÉS de que saliera.
   * Si no, se dice «sin comprobar» con el motivo. Mejor un aviso naranja de más que un rojo falso.
   */
  const estadoVyro = (o: { envio: Row | undefined; campaignId: string | null; campaignPlatform: string | null; scheduled: boolean; manual: boolean; publishedAt: string | null; videoId: string | null }) => {
    const e = o.envio
    const vyroId = o.campaignId ? vyroDeCampaña.get(o.campaignId) : undefined
    const checkedAt = vyroId ? leidas.get(vyroId) ?? null : null
    if (e) return { state: 'in_vyro' as VyroState, status: e.status ?? null, views: e.views ?? null, earned: e.earned ?? null, submittedAt: e.submitted_at ?? null, error: e.error ?? null, reason: null, checkedAt: e.synced_at ?? checkedAt }
    const base = { status: null, views: null, earned: null, submittedAt: null, error: null, checkedAt }
    const esVyro = !!o.campaignId && (o.campaignPlatform == null || String(o.campaignPlatform).toLowerCase() === 'vyro')
    if (!esVyro) return { state: 'no_campaign' as VyroState, ...base, reason: null }
    if (o.scheduled) return { state: 'scheduled' as VyroState, ...base, reason: null }
    // marcado a mano como enviado: solo si lo marcaste tú (no lo que puso la app al instalar o al leer Vyro)
    const aMano = o.manual
    if (!vyroId) return { state: (aMano ? 'manual' : 'unchecked') as VyroState, ...base, reason: 'Esta campaña no está enlazada con su campaña de Vyro (pantalla Vyro → «Tu campaña»), así que no se pueden leer sus envíos.' }
    if (!checkedAt) return { state: 'unchecked' as VyroState, ...base, reason: 'Aún no se han leído tus envíos de esta campaña en Vyro.' }
    if (!o.videoId) return { state: 'unchecked' as VyroState, ...base, reason: 'La app no tiene el enlace de este vídeo y no lo encontró en Vyro por cuenta y hora. Pega su enlace en el clip («Editar») para comprobarlo.' }
    // margen: lo normal es enviarlo unos minutos después de publicar; una lectura en medio no basta para decir que falta
    if (o.publishedAt && Date.parse(checkedAt) < Date.parse(o.publishedAt) + MARGEN_MS) return { state: 'unchecked' as VyroState, ...base, reason: 'Recién publicado: se comprobará en la próxima lectura de Vyro.' }
    if (aMano) return { state: 'manual' as VyroState, ...base, reason: null }
    return { state: 'missing' as VyroState, ...base, reason: null }
  }

  // 1) publicaciones (de las últimas semanas o programadas)
  const pubs = db.prepare(
    `SELECT p.*, k.title AS clip_title, k.filename, k.thumb_path, k.cover_mtime_ms, k.caption AS clip_caption,
       c.campaign_id, COALESCE(c.display_name, c.folder_name) AS campaign_name, c.ends_at, c.platform AS campaign_platform, c.closed AS campaign_closed,
       (SELECT MAX(CASE WHEN v.locked = 1 OR (v.status IS NOT NULL AND v.status <> 'active') THEN 1 ELSE 0 END) FROM vyro_campaigns v WHERE v.campaign_id = c.campaign_id) AS vyro_closed,
       y.video_id AS yt_id, y.title AS yt_title, y.description AS yt_description, y.views AS yt_views
     FROM publications p JOIN clips k ON k.clip_id = p.clip_id JOIN campaigns c ON c.campaign_id = k.campaign_id
     LEFT JOIN youtube_videos y ON y.publication_id = p.id
     WHERE p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at >= ?`
  ).all(desde) as Row[]
  for (const p of pubs) {
    // TikTok no se tiene en cuenta aquí (lo pidió el usuario: no se ve bien desde la app)
    if (!isPlatform(p.platform) || p.platform === 'tiktok') continue
    const videoId = p.yt_id ?? videoIdOf(p.platform, p.url)
    if (videoId) vistos.add(`${p.platform}:${videoId}`)
    const scheduled = p.published_at > ahora
    const envio = envioPorPub.get(p.id) ?? (videoId ? envioPorVideo.get(`${p.platform}:${videoId}`) : undefined)
    const ultima = db.prepare('SELECT views FROM analytics_snapshots WHERE publication_id = ? ORDER BY measured_at DESC, id DESC LIMIT 1').get(p.id) as Row | undefined
    const views = (ultima?.views as number | undefined) ?? p.yt_views ?? null
    const vyro = estadoVyro({ envio, campaignId: p.campaign_id, campaignPlatform: p.campaign_platform, scheduled, manual: p.vyro_sent_manual === 1 && !!p.vyro_sent_at, publishedAt: p.published_at, videoId })
    // campaña cerrada (plazo pasado, cerrada a mano o bloqueada en Vyro): ya no se puede enviar; no es para «Atención»
    const ended = (!!p.ends_at && p.ends_at < hoy) || p.campaign_closed === 1 || p.vyro_closed === 1
    if (ended && (vyro.state === 'missing' || vyro.state === 'manual' || vyro.state === 'unchecked')) {
      vyro.state = 'expired'
      vyro.reason = 'No se envió y la campaña ya cerró: Vyro ya no lo acepta.'
    }
    videos.push({
      key: `p${p.id}`, platform: p.platform, account: String(p.account ?? '').replace(/ · .*$/, ''), videoId, url: p.url ?? (videoId && p.platform === 'youtube' ? `https://youtu.be/${videoId}` : null),
      title: p.yt_title ?? p.title_used ?? p.clip_title ?? p.filename ?? p.clip_id, description: p.yt_description ?? p.caption_used ?? p.clip_caption ?? null,
      thumb: p.thumb_path ? { kind: 'clip', clipId: p.clip_id, version: p.cover_mtime_ms ?? null } : videoId && p.platform === 'youtube' ? { kind: 'youtube', videoId } : null,
      publishedAt: p.published_at, scheduled, views, clipId: p.clip_id, publicationId: p.id,
      campaignName: p.campaign_name, campaignEndsAt: p.ends_at ?? null, campaignEnded: ended,
      vyro, urgent: (vyro.state === 'missing' || vyro.state === 'manual') && !ended && (views ?? 0) >= URGENT_VIEWS,
    })
  }

  // 2) vídeos reales de tus canales de YouTube que la app no ha emparejado con un clip
  const sueltos = db.prepare(
    `SELECT y.*, ch.handle, ch.title AS channel_title FROM youtube_videos y JOIN youtube_channels ch ON ch.channel_id = y.channel_id
     WHERE ch.kind = 'clips' AND y.publication_id IS NULL AND y.match_state <> 'ignored' AND y.published_at >= ?`
  ).all(desde) as Row[]
  for (const y of sueltos) {
    if (vistos.has(`youtube:${y.video_id}`)) continue
    vistos.add(`youtube:${y.video_id}`)
    const envio = envioPorVideo.get(`youtube:${y.video_id}`)
    videos.push({
      key: `y${y.video_id}`, platform: 'youtube', account: y.handle ?? y.channel_title ?? '', videoId: y.video_id, url: `https://youtu.be/${y.video_id}`,
      title: y.title ?? y.video_id, description: y.description ?? null, thumb: { kind: 'youtube', videoId: y.video_id },
      publishedAt: y.published_at, scheduled: false, views: y.views ?? null, clipId: null, publicationId: null,
      campaignName: null, campaignEndsAt: null, campaignEnded: false,
      vyro: envio
        ? { state: 'in_vyro', status: envio.status ?? null, views: envio.views ?? null, earned: envio.earned ?? null, submittedAt: envio.submitted_at ?? null, error: envio.error ?? null, reason: null, checkedAt: envio.synced_at ?? null }
        : { state: 'no_campaign', status: null, views: null, earned: null, submittedAt: null, error: null, reason: 'La app no sabe de qué clip es (título distinto o vídeo propio). Si es de una campaña y no lo has enviado, envíalo.', checkedAt: null },
      urgent: false,
    })
  }

  // 3) envíos de Vyro que la app no conoce por ningún otro lado
  for (const e of envios) {
    if (!isPlatform(e.platform) || e.platform === 'tiktok' || (e.submitted_at && e.submitted_at < desde)) continue
    if (e.publication_id != null || (e.video_id && vistos.has(`${e.platform}:${e.video_id}`))) continue
    if (e.video_id) vistos.add(`${e.platform}:${e.video_id}`)
    const camp = db.prepare('SELECT COALESCE(c.display_name, c.folder_name, v.name) AS name, c.ends_at FROM vyro_campaigns v LEFT JOIN campaigns c ON c.campaign_id = v.campaign_id WHERE v.vyro_id = ?').get(e.vyro_campaign_id) as Row | undefined
    videos.push({
      key: `v${e.vyro_clip_id}`, platform: e.platform, account: e.username ? `@${String(e.username).replace(/^@/, '')}` : '', videoId: e.video_id ?? null, url: e.video_url ?? null,
      title: e.video_url ?? 'Envío de Vyro', description: null, thumb: e.platform === 'youtube' && e.video_id ? { kind: 'youtube', videoId: e.video_id } : null,
      publishedAt: e.submitted_at ?? null, scheduled: false, views: null, clipId: null, publicationId: null,
      campaignName: camp?.name ?? null, campaignEndsAt: camp?.ends_at ?? null, campaignEnded: !!camp?.ends_at && camp.ends_at < hoy,
      vyro: { state: 'in_vyro', status: e.status ?? null, views: e.views ?? null, earned: e.earned ?? null, submittedAt: e.submitted_at ?? null, error: e.error ?? null, reason: null, checkedAt: e.synced_at ?? null },
      urgent: false,
    })
  }

  // REGLA Nº1 (Vyro): un clip nunca en dos canales de YouTube. Se cuentan los canales donde está cada clip: lo emparejado
  // y lo que probablemente es ese clip aunque no esté emparejado (mismo título, en cualquiera de tus canales seguidos).
  const probables = clipsProbablyOnYouTube(db)
  const nombre = (x: unknown) => String(x ?? '').replace(/ · .*$/, '').replace(/^@/, '').trim().toLowerCase()
  const canalesDe = new Map<string, Set<string>>()
  const añadir = (clipId: string, canal: string) => {
    if (!canal) return
    const s = canalesDe.get(clipId) ?? new Set<string>()
    s.add(canal)
    canalesDe.set(clipId, s)
  }
  for (const v of videos) if (v.platform === 'youtube' && v.clipId && !v.scheduled && v.videoId) añadir(v.clipId, nombre(v.account))
  for (const [id, cs] of probables) for (const c of cs) añadir(id, nombre(c))
  for (const v of videos) {
    const cs = v.platform === 'youtube' && v.clipId ? canalesDe.get(v.clipId) : undefined
    if (cs && cs.size >= 2 && !v.scheduled) {
      v.vyro.state = 'duplicate'
      v.vyro.reason = `Este clip está en ${cs.size} canales de YouTube (${[...cs].map((c) => '@' + c).join(', ')}). Vyro no lo permite: deja solo uno y borra los demás.`
      v.urgent = true
    }
  }
  // marcado como subido en YouTube, pero no aparece en NINGUNO de tus canales 24 h después (revisados todos después)
  const revisados = (db.prepare("SELECT MIN(last_scan_at) AS t, COUNT(*) AS n FROM youtube_channels WHERE kind = 'clips'").get() as Row)
  for (const v of videos) {
    if (v.platform !== 'youtube' || v.publicationId == null || v.videoId || v.scheduled || !v.clipId || !v.publishedAt) continue
    if (v.vyro.state === 'in_vyro' || v.vyro.state === 'duplicate' || probables.has(v.clipId)) continue
    const salio = Date.parse(v.publishedAt)
    if (!revisados.n || !revisados.t || now.getTime() - salio < 86_400_000 || Date.parse(revisados.t) < salio + 86_400_000) continue
    v.vyro.state = 'not_found'
    v.vyro.reason = 'No aparece en ninguno de tus canales de YouTube. Si no llegaste a subirlo (o lo borraste), quita la marca: el clip vuelve a estar disponible para subirlo en UN canal.'
    v.urgent = false
  }

  // ignorados: fuera de «Atención», salvo que hayan empezado a coger visitas con la campaña abierta
  const ignorados = new Set((db.prepare("SELECT substr(key, 18) AS k FROM settings WHERE key LIKE 'control_ignorado:%'").all() as Row[]).map((r) => r.k as string))
  for (const v of videos) {
    // un duplicado no se puede ignorar: hay que resolverlo
    if (!ignorados.has(v.key) || v.vyro.state === 'in_vyro' || v.vyro.state === 'scheduled' || v.vyro.state === 'duplicate') continue
    if ((v.views ?? 0) >= URGENT_VIEWS && !v.campaignEnded && v.vyro.state !== 'no_campaign') {
      v.vyro.reason = `Lo ignoraste, pero ya lleva ${v.views} visitas: si es de campaña, envíalo a Vyro. ${v.vyro.reason ?? ''}`.trim()
      continue
    }
    v.vyro.state = 'ignored'
    v.urgent = false
  }

  videos.sort((a, b) =>
    Number(b.urgent) - Number(a.urgent) || ORDEN[a.vyro.state] - ORDEN[b.vyro.state] ||
    (a.vyro.state === 'scheduled' ? String(a.publishedAt).localeCompare(String(b.publishedAt)) : String(b.publishedAt).localeCompare(String(a.publishedAt))) ||
    PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform))
  const counts = { duplicate: 0, missing: 0, manual: 0, not_found: 0, unchecked: 0, scheduled: 0, in_vyro: 0, no_campaign: 0, ignored: 0, expired: 0 } as Record<VyroState, number>
  for (const v of videos) counts[v.vyro.state]++
  return { videos, counts }
}
