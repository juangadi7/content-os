/**
 * YouTube Data API v3, solo lectura de datos PÚBLICOS con una clave de API: cifras de vídeos
 * (visitas, likes, comentarios) y la lista de vídeos subidos a un canal. No se inicia sesión en
 * ningún canal. La petición se inyecta (fetchImpl) para poder probarlo sin red.
 */

export interface VideoStats {
  videoId: string
  views: number | null
  /** null si el canal oculta los likes. */
  likes: number | null
  /** null si los comentarios están desactivados. */
  comments: number | null
  raw: unknown
}

export interface VideoDetails extends VideoStats {
  channelId: string | null
  title: string | null
  description: string | null
  publishedAt: string | null
  durationSeconds: number | null
}

export interface ChannelInfo {
  channelId: string
  handle: string | null
  title: string | null
  uploadsPlaylist: string
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

export type YouTubeErrorCode = 'key_invalid' | 'api_disabled' | 'quota' | 'network' | 'api' | 'not_found'

export class YouTubeApiError extends Error {
  constructor(readonly code: YouTubeErrorCode, message: string) {
    super(message)
  }
}

const ID = /^[A-Za-z0-9_-]{11}$/
const API = 'https://www.googleapis.com/youtube/v3'

/** Identificador del vídeo a partir de su URL (Shorts, watch, youtu.be, embed, live). */
export function parseYouTubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  let id: string | null = null
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const partes = u.pathname.split('/').filter(Boolean)
    if (partes[0] === 'watch') id = u.searchParams.get('v')
    else if (['shorts', 'embed', 'live', 'v'].includes(partes[0])) id = partes[1] ?? null
  }
  return id && ID.test(id) ? id : null
}

export const shortUrl = (videoId: string) => `https://www.youtube.com/shorts/${videoId}`

/** Lo que el usuario escribe para decir cuál es su canal: @nombre, URL del canal o UC… */
export function parseChannelRef(texto: string | null | undefined): { handle?: string; channelId?: string } | null {
  const t = (texto ?? '').trim()
  if (!t) return null
  const comoId = /^UC[A-Za-z0-9_-]{22}$/
  const comoHandle = /^@?[A-Za-z0-9._-]{3,30}$/
  if (comoId.test(t)) return { channelId: t }
  if (/^https?:\/\//i.test(t)) {
    let u: URL
    try {
      u = new URL(t)
    } catch {
      return null
    }
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null
    const partes = decodeURIComponent(u.pathname).split('/').filter(Boolean)
    if (partes[0] === 'channel' && comoId.test(partes[1] ?? '')) return { channelId: partes[1] }
    if (partes[0]?.startsWith('@') && comoHandle.test(partes[0])) return { handle: partes[0] }
    return null
  }
  return comoHandle.test(t) ? { handle: t.startsWith('@') ? t : '@' + t } : null
}

const entero = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** "PT1M5S" -> 65 */
export function parseIsoDuration(iso: unknown): number | null {
  if (typeof iso !== 'string') return null
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso)
  if (!m) return null
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
}

function errorDeApi(status: number, cuerpo: any): YouTubeApiError {
  const razon: string = cuerpo?.error?.errors?.[0]?.reason ?? cuerpo?.error?.status ?? ''
  const texto: string = cuerpo?.error?.message ?? `HTTP ${status}`
  if (/quota|rateLimit|dailyLimit/i.test(razon)) return new YouTubeApiError('quota', 'Se ha agotado la cuota diaria de la API de YouTube. Vuelve a intentarlo mañana.')
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(razon) || /has not been used|is disabled/i.test(texto)) {
    return new YouTubeApiError('api_disabled', 'La clave existe, pero «YouTube Data API v3» no está activada en ese proyecto de Google Cloud.')
  }
  if (/keyInvalid|API_KEY_INVALID|badRequest|forbidden/i.test(razon) || /API key not valid|API key expired/i.test(texto) || status === 400 || status === 401) {
    return new YouTubeApiError('key_invalid', 'La clave de API no es válida.')
  }
  return new YouTubeApiError('api', `YouTube respondió con un error: ${texto}`)
}

async function pedir(recurso: string, params: Record<string, string>, apiKey: string, fetchImpl: FetchLike): Promise<any> {
  const url = `${API}/${recurso}?${new URLSearchParams(params).toString()}`
  let res: Awaited<ReturnType<FetchLike>>
  try {
    // la clave viaja en una cabecera, no en la URL
    res = await fetchImpl(url, { headers: { 'X-goog-api-key': apiKey, Accept: 'application/json' } })
  } catch (e) {
    throw new YouTubeApiError('network', `No se pudo conectar con YouTube: ${(e as Error).message}`)
  }
  let cuerpo: any = null
  try {
    cuerpo = await res.json()
  } catch {
    cuerpo = null
  }
  if (!res.ok) throw errorDeApi(res.status, cuerpo)
  return cuerpo
}

/**
 * Cifras y datos de vídeos, de 50 en 50 (máximo por petición; cada petición cuesta 1 unidad de
 * las 10.000 diarias gratuitas). Los vídeos privados, borrados o inexistentes no aparecen.
 */
export async function fetchVideoDetails(videoIds: string[], apiKey: string, fetchImpl: FetchLike): Promise<Map<string, VideoDetails>> {
  const out = new Map<string, VideoDetails>()
  const ids = [...new Set(videoIds.filter((v) => ID.test(v)))]
  for (let i = 0; i < ids.length; i += 50) {
    const cuerpo = await pedir('videos', { part: 'snippet,contentDetails,statistics', maxResults: '50', id: ids.slice(i, i + 50).join(',') }, apiKey, fetchImpl)
    for (const item of cuerpo?.items ?? []) {
      if (typeof item?.id !== 'string') continue
      const s = item.statistics ?? {}
      out.set(item.id, {
        videoId: item.id, views: entero(s.viewCount), likes: entero(s.likeCount), comments: entero(s.commentCount), raw: s,
        channelId: item.snippet?.channelId ?? null, title: item.snippet?.title ?? null, description: item.snippet?.description ?? null,
        publishedAt: item.snippet?.publishedAt ?? null, durationSeconds: parseIsoDuration(item.contentDetails?.duration)
      })
    }
  }
  return out
}

/** Solo las cifras. */
export async function fetchVideoStats(videoIds: string[], apiKey: string, fetchImpl: FetchLike): Promise<Map<string, VideoStats>> {
  return fetchVideoDetails(videoIds, apiKey, fetchImpl)
}

/** Busca un canal por @nombre o por su identificador. */
export async function fetchChannel(ref: { handle?: string; channelId?: string }, apiKey: string, fetchImpl: FetchLike): Promise<ChannelInfo> {
  const filtro: Record<string, string> = ref.channelId ? { id: ref.channelId } : { forHandle: ref.handle ?? '' }
  const cuerpo = await pedir('channels', { part: 'snippet,contentDetails', maxResults: '1', ...filtro }, apiKey, fetchImpl)
  const item = cuerpo?.items?.[0]
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads
  if (!item || typeof item.id !== 'string' || typeof uploads !== 'string') {
    throw new YouTubeApiError('not_found', 'YouTube no encuentra ese canal. Comprueba el @nombre o pega la URL del canal.')
  }
  const handle: string | null = item.snippet?.customUrl ?? ref.handle ?? null
  return { channelId: item.id, handle: handle ? (handle.startsWith('@') ? handle : '@' + handle) : null, title: item.snippet?.title ?? null, uploadsPlaylist: uploads }
}

export interface ChannelStats {
  /** null si el canal oculta sus suscriptores. YouTube los da redondeados. */
  subscribers: number | null
  totalViews: number | null
  videoCount: number | null
}

/** Cifras públicas de varios canales en una sola petición (1 unidad de cuota). */
export async function fetchChannelStats(channelIds: string[], apiKey: string, fetchImpl: FetchLike): Promise<Map<string, ChannelStats>> {
  const out = new Map<string, ChannelStats>()
  const ids = [...new Set(channelIds)]
  for (let i = 0; i < ids.length; i += 50) {
    const cuerpo = await pedir('channels', { part: 'statistics', maxResults: '50', id: ids.slice(i, i + 50).join(',') }, apiKey, fetchImpl)
    for (const item of cuerpo?.items ?? []) {
      if (typeof item?.id !== 'string') continue
      const s = item.statistics ?? {}
      out.set(item.id, { subscribers: s.hiddenSubscriberCount ? null : entero(s.subscriberCount), totalViews: entero(s.viewCount), videoCount: entero(s.videoCount) })
    }
  }
  return out
}

/** Dirección de la imagen (avatar) de varios canales. 1 unidad de cuota por cada 50. */
export async function fetchChannelAvatars(channelIds: string[], apiKey: string, fetchImpl: FetchLike): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(channelIds)]
  for (let i = 0; i < ids.length; i += 50) {
    const cuerpo = await pedir('channels', { part: 'snippet', maxResults: '50', id: ids.slice(i, i + 50).join(',') }, apiKey, fetchImpl)
    for (const item of cuerpo?.items ?? []) {
      const t = item?.snippet?.thumbnails
      const url = t?.medium?.url ?? t?.default?.url ?? t?.high?.url
      if (typeof item?.id === 'string' && typeof url === 'string') out.set(item.id, url)
    }
  }
  return out
}

/** Solo se descargan imágenes de los servidores de avatares de Google, por https. */
export function isAvatarUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && /(^|\.)(ggpht\.com|googleusercontent\.com)$/i.test(u.hostname)
  } catch {
    return false
  }
}

export const isChannelId = (v: unknown): v is string => typeof v === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(v)

/** Identificadores de los vídeos subidos a un canal, del más reciente al más antiguo. */
export async function fetchUploads(uploadsPlaylist: string, apiKey: string, fetchImpl: FetchLike, max = 200): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  while (ids.length < max) {
    const params: Record<string, string> = { part: 'contentDetails', maxResults: '50', playlistId: uploadsPlaylist }
    if (pageToken) params.pageToken = pageToken
    let cuerpo: any
    try {
      cuerpo = await pedir('playlistItems', params, apiKey, fetchImpl)
    } catch (e) {
      // un canal sin vídeos todavía no tiene lista de subidas
      if (e instanceof YouTubeApiError && e.code === 'api' && /cannot be found|playlistNotFound/i.test(e.message)) return ids
      throw e
    }
    for (const item of cuerpo?.items ?? []) {
      const id = item?.contentDetails?.videoId
      if (typeof id === 'string' && ID.test(id)) ids.push(id)
    }
    pageToken = cuerpo?.nextPageToken
    if (!pageToken) break
  }
  return ids.slice(0, max)
}
