/** Contrato entre la interfaz y el proceso principal. Es TODO lo que React puede pedir. */
import type { RefreshSummary, SnapshotView } from './analytics'
import type { CampaignStatusInput, CampaignTermsInput } from './campaigns'
import type { ChannelDashboard } from './channel-dashboard'
import type { SyncSummary } from './importer'
import type { RawInfo, RawRemoval } from './raw'
import type { AccountInput, AccountView, PlanView } from './plan'
import type { PublicationInput } from './publications'
import type { StatsView } from './stats'
import type { SeriesPoint } from './stats-series'
import type { OrderFile, OrderView } from './orders'
import type { TikTokAddResult, TikTokRefreshSummary } from './tiktok'
import type { VyroView } from './vyro'
import type { SocialAccountView, SocialPlatform, SocialRefreshResult } from './social'
import type { ChannelKind, ChannelSyncSummary, ChannelView } from './youtube-channels'
import type { ExtraPlatform, ExtrasView } from './extras'
import type { LongKind, LongLetter, LongVideosView } from './long-videos'
import type { WeekendPlan } from './weekend'
import type { VideoControl } from './video-control'
import type { AccountBook } from './account-book'
import type { VyroPending } from './vyro-pending'
import type { CalendarTaskInput, CalendarView } from './calendar'
import type { CampaignView, ClipDetail, ClipView, Counts, LibraryView, PublishedRow, SyncEventView, SyncRunView } from './queries'

export const CHANNELS = {
  getState: 'cos:get-state',
  sync: 'cos:sync',
  addLibrary: 'cos:add-library',
  listClips: 'cos:list-clips',
  getClip: 'cos:get-clip',
  listPublished: 'cos:list-published',
  savePublication: 'cos:save-publication',
  deletePublication: 'cos:delete-publication',
  openClipFile: 'cos:open-clip-file',
  showClipInFolder: 'cos:show-clip-in-folder',
  copyText: 'cos:copy-text',
  listSyncProblems: 'cos:list-sync-problems',
  youtubeConnect: 'cos:youtube-connect',
  youtubeDisconnect: 'cos:youtube-disconnect',
  youtubeRefresh: 'cos:youtube-refresh',
  youtubeAddChannel: 'cos:youtube-add-channel',
  youtubeRemoveChannel: 'cos:youtube-remove-channel',
  youtubeMoveToClips: 'cos:youtube-move-to-clips',
  youtubeLinkVideo: 'cos:youtube-link-video',
  youtubeUnlinkVideo: 'cos:youtube-unlink-video',
  youtubeIgnoreVideo: 'cos:youtube-ignore-video',
  youtubeDashboard: 'cos:youtube-dashboard',
  socialRefresh: 'cos:social-refresh',
  socialDashboard: 'cos:social-dashboard',
  socialLinkVideo: 'cos:social-link-video',
  socialUnlinkVideo: 'cos:social-unlink-video',
  getStats: 'cos:get-stats',
  getStatsSeries: 'cos:get-stats-series',
  setCampaignStatus: 'cos:set-campaign-status',
  setCampaignTerms: 'cos:set-campaign-terms',
  getRawFiles: 'cos:get-raw-files',
  deleteRawFiles: 'cos:delete-raw-files',
  getPlan: 'cos:get-plan',
  saveAccount: 'cos:save-account',
  removeAccount: 'cos:remove-account',
  setCampaignAccounts: 'cos:set-campaign-accounts',
  libraryChanged: 'cos:library-changed',
  tiktokAdd: 'cos:tiktok-add',
  tiktokRefresh: 'cos:tiktok-refresh',
  getVyro: 'cos:get-vyro',
  getVideoControl: 'cos:get-video-control',
  setControlIgnored: 'cos:set-control-ignored',
  getAccountBook: 'cos:get-account-book',
  getVyroAccount: 'cos:get-vyro-account',
  vyroConnect: 'cos:vyro-connect',
  vyroDisconnect: 'cos:vyro-disconnect',
  vyroSyncSubmissions: 'cos:vyro-sync-submissions',
  vyroCheck: 'cos:vyro-check',
  vyroLink: 'cos:vyro-link',
  vyroAcknowledge: 'cos:vyro-acknowledge',
  orderCreate: 'cos:order-create',
  orderUpdate: 'cos:order-update',
  orderCancel: 'cos:order-cancel',
  showInFolder: 'cos:show-order-folder',
  listExtras: 'cos:list-extras',
  setExtraUploaded: 'cos:set-extra-uploaded',
  openExtra: 'cos:open-extra',
  showExtraInFolder: 'cos:show-extra-in-folder',
  trashExtras: 'cos:trash-extras',
  listLongVideos: 'cos:list-long-videos',
  setLongUploaded: 'cos:set-long-uploaded',
  openLongVideo: 'cos:open-long-video',
  showLongInFolder: 'cos:show-long-in-folder',
  trashCampaign: 'cos:trash-campaign',
  getWeekendPlan: 'cos:get-weekend-plan',
  getVyroPending: 'cos:get-vyro-pending',
  setVyroSent: 'cos:set-vyro-sent',
  getCalendar: 'cos:get-calendar',
  addCalendarTask: 'cos:add-calendar-task',
  setCalendarTaskDone: 'cos:set-calendar-task-done',
  deleteCalendarTask: 'cos:delete-calendar-task',
  stateChanged: 'cos:state-changed',
  navigate: 'cos:navigate'
} as const

/** Esquema propio para servir vídeo y miniaturas: cos://clip/<clip_id> y cos://thumb/<clip_id>. */
export const MEDIA_SCHEME = 'cos'
/**
 * Dirección de un archivo multimedia. En la aplicación es cos://<tipo>/<ruta>; en la demo web
 * (globalThis.__COS_MEDIA__ = carpeta base) es un archivo estático con extensión.
 */
const media = (tipo: string, ruta: string, ext: 'jpg' | 'mp4', query = ''): string => {
  const base = (globalThis as { __COS_MEDIA__?: string }).__COS_MEDIA__
  return base ? `${base}${tipo}/${ruta}.${ext}` : `${MEDIA_SCHEME}://${tipo}/${ruta}${query}`
}
export const clipUrl = (clipId: string) => media('clip', encodeURIComponent(clipId), 'mp4')
/** Imagen de un canal de YouTube seguido, guardada en el equipo: cos://avatar/<channel_id>. */
export const avatarUrl = (channelId: string) => media('avatar', encodeURIComponent(channelId), 'jpg')
/** Vídeo de «Fuera de campaña»: cos://extra/<grupo>/<archivo>.mp4 (la ruta real la resuelve el proceso principal). */
export const extraUrl = (id: string) => media('extra', id.split('/').map(encodeURIComponent).join('/'), 'mp4')
/** Miniatura del vídeo original de un grupo de «Fuera de campaña»: cos://extra-thumb/<grupo>. */
export const extraThumbUrl = (groupId: string) => media('extra-thumb', encodeURIComponent(groupId), 'jpg')
/** Vídeo largo: cos://long/<carpeta>; de música: cos://music/<carpeta> (la ruta real la resuelve el proceso principal). */
export const longUrl = (id: string, kind: LongKind = 'long') => media(kind, encodeURIComponent(id), 'mp4')
/** Miniatura A, B o C: cos://long-thumb/<carpeta>/<letra> (o music-thumb). */
export const longThumbUrl = (id: string, letter: LongLetter, kind: LongKind = 'long') =>
  media(`${kind}-thumb`, `${encodeURIComponent(id)}/${letter}`, 'jpg')
/** Miniatura de un vídeo de YouTube (la descarga y guarda el proceso principal): cos://ytthumb/<id>. */
export const ytThumbUrl = (videoId: string) => media('ytthumb', encodeURIComponent(videoId), 'jpg')
export const thumbUrl = (clipId: string, version?: number | null) =>
  media('thumb', encodeURIComponent(clipId), 'jpg', version ? `?v=${version}` : '')

export interface AppState {
  appVersion: string
  dataDir: string
  configPath: string
  configError: string | null
  /** Bibliotecas escritas en config.json (pueden no haberse sincronizado todavía). */
  configuredRoots: string[]
  libraries: LibraryView[]
  campaigns: CampaignView[]
  counts: Counts
  lastRun: SyncRunView | null
  syncing: boolean
  /** true si hay una clave de API de YouTube guardada. La clave nunca llega a la interfaz. */
  youtubeConnected: boolean
  youtubeChannels: ChannelView[]
  /** Cuentas de TikTok e Instagram con clave en .secretos (la clave nunca llega a la interfaz). */
  socialConnected: { platform: SocialPlatform; account: string }[]
  /** Canales del usuario ajenos a los clips: solo se miran sus cifras, en «Canales personales». */
  personalChannels: ChannelView[]
  /** Subidas que el plan de «Hoy» propone y aún no se han hecho. */
  todayLeft: number
  /** Canales de publicación, con las campañas que tiene asignadas cada uno. */
  accounts: AccountView[]
  /** Campañas de Vyro que han salido y aún no has visto. */
  vyroNew: number
  /** Vídeos que faltan en Vyro o que marcaste como enviados y Vyro no tiene. */
  videosAlert: number
  /** Publicaciones ya públicas que falta enviar a Vyro. */
  vyroToSend: number
  /** Vídeos en «Fuera de campaña». */
  extrasCount: number
  /** Vídeos largos (canales propios) sin marcar como subidos. */
  longPending: number
  /** Vídeos de música sin marcar como subidos. */
  musicPending: number
}

/** Resultado de pedir cifras: canales recorridos + publicaciones con URL puesta a mano. */
export interface YouTubeRefreshResult {
  channels: ChannelSyncSummary
  byUrl: RefreshSummary
}

export interface SyncResult {
  summary: SyncSummary
  state: AppState
}

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface ContentOsApi {
  getState(): Promise<AppState>
  /** Vuelve a leer las bibliotecas (solo lectura) y actualiza la base de datos. */
  sync(): Promise<SyncResult>
  /** Abre el selector de carpetas de Windows y añade la elegida a config.json. null si se cancela. */
  addLibrary(): Promise<AppState | null>
  /** Clips en orden de calidad; con null, los de todas las campañas. */
  listClips(campaignId: string | null): Promise<ClipView[]>
  getClip(clipId: string): Promise<ClipDetail | null>
  listPublished(): Promise<PublishedRow[]>
  savePublication(input: PublicationInput): Promise<ClipDetail>
  deletePublication(clipId: string, publicationId: number): Promise<ClipDetail>
  /** Abre el MP4 con la aplicación predeterminada de Windows. */
  openClipFile(clipId: string): Promise<ActionResult>
  /** Abre el Explorador con el MP4 seleccionado. */
  showClipInFolder(clipId: string): Promise<ActionResult>
  copyText(text: string): Promise<ActionResult>
  listSyncProblems(): Promise<SyncEventView[]>
  /** Comprueba la clave contra YouTube y, si vale, la guarda cifrada. */
  youtubeConnect(apiKey: string): Promise<AppState>
  youtubeDisconnect(): Promise<AppState>
  /** Pide a YouTube las cifras públicas de las publicaciones con URL y guarda una medición nueva. */
  youtubeRefresh(force: boolean): Promise<YouTubeRefreshResult>
  /** Añade un canal (@nombre o URL): sus vídeos se descubren y emparejan solos. */
  youtubeAddChannel(ref: string, kind?: ChannelKind): Promise<AppState>
  youtubeRemoveChannel(channelId: string): Promise<AppState>
  /** Pasa un canal personal a «Canales» (los de clips) conservando sus vídeos y su historial. */
  youtubeMoveToClips(channelId: string): Promise<AppState>
  /** Empareja a mano un vídeo del canal con un clip. */
  youtubeLinkVideo(videoId: string, clipId: string): Promise<StatsView>
  /** Deshace un emparejamiento equivocado. */
  youtubeUnlinkVideo(videoId: string): Promise<StatsView>
  youtubeIgnoreVideo(videoId: string, ignored: boolean): Promise<StatsView>
  /** Panel de cada canal seguido: sus vídeos públicos en orden de subida y el estudio del canal. Solo lectura. */
  youtubeDashboard(kind?: ChannelKind): Promise<ChannelDashboard[]>
  /** Lee tus cuentas de TikTok e Instagram con sus API oficiales (solo lectura) y empareja sus vídeos con los clips. */
  socialRefresh(force: boolean): Promise<SocialRefreshResult>
  /** Panel de cada cuenta de TikTok e Instagram con sus vídeos y cifras guardadas. Solo lectura. */
  socialDashboard(): Promise<SocialAccountView[]>
  socialLinkVideo(platform: SocialPlatform, videoId: string, clipId: string): Promise<SocialAccountView[]>
  socialUnlinkVideo(platform: SocialPlatform, videoId: string): Promise<SocialAccountView[]>
  getStats(): Promise<StatsView>
  /** Mediciones reales por fecha (solo lectura), para la evolución temporal. */
  getStatsSeries(): Promise<SeriesPoint[]>
  /** Cierra o reabre una campaña y/o fija su último día de plazo. Solo cambia datos de CONTENT OS. */
  setCampaignStatus(input: CampaignStatusInput): Promise<AppState>
  /** Condiciones de pago de una campaña (pago por 1.000 visitas, mínimo, tope por vídeo). */
  setCampaignTerms(input: CampaignTermsInput): Promise<AppState>
  /** Vídeos originales (SOURCE) de una campaña y lo que ocupan. */
  getRawFiles(campaignId: string): Promise<RawInfo | null>
  /** Quita esos vídeos, a la Papelera o definitivamente. Solo lo llama el usuario desde su botón. */
  deleteRawFiles(campaignId: string, mode: 'trash' | 'permanent'): Promise<RawRemoval>
  /** Plan de «Hoy»: qué clips subir y en qué canal. */
  getPlan(): Promise<PlanView>
  /** Plan del fin de semana (sábado y domingo): qué clip programar en cada canal y a qué hora. */
  getWeekendPlan(): Promise<WeekendPlan>
  /** Lo ya publicado que falta enviar a Vyro. */
  getVyroPending(): Promise<VyroPending[]>
  setVyroSent(publicationId: number, sent: boolean): Promise<VyroPending[]>
  /** Calendario entre dos días (AAAA-MM-DD, ambos incluidos). */
  getCalendar(from: string, to: string): Promise<CalendarView>
  addCalendarTask(input: CalendarTaskInput): Promise<void>
  /** id numérico = tarea apuntada; texto = nota de Claude (PLAN\calendario.json). */
  setCalendarTaskDone(id: number | string, done: boolean): Promise<void>
  deleteCalendarTask(id: number): Promise<void>
  /** Añade un canal o cambia su tope diario. */
  saveAccount(input: AccountInput): Promise<PlanView>
  /** Quita un canal del plan; sus publicaciones se conservan. */
  removeAccount(id: number): Promise<PlanView>
  /** Asigna una campaña a unos canales concretos (lista vacía = sin asignar). */
  setCampaignAccounts(campaignId: string, accountIds: number[]): Promise<AppState>
  /** Avisa cuando la aplicación se ha sincronizado sola (cambios en la carpeta de campañas). Devuelve cómo dejar de escuchar. */
  onLibraryChanged(listener: (r: SyncResult) => void): () => void
  /** Apunta un vídeo de TikTok por su URL: encuentra el clip, crea la publicación y guarda sus cifras. */
  tiktokAdd(url: string): Promise<TikTokAddResult>
  /** Vuelve a leer las cifras públicas de los vídeos de TikTok con URL. */
  tiktokRefresh(force: boolean): Promise<TikTokRefreshSummary>
  /** Campañas publicadas en Vyro (última lectura guardada). */
  getVyro(): Promise<VyroView>
  /** Cada vídeo subido o programado, con su estado en Vyro. */
  getVideoControl(): Promise<VideoControl>
  /** Ignorar un vídeo del control (o dejar de ignorarlo). */
  setControlIgnored(key: string, ignored: boolean): Promise<VideoControl>
  /** Qué correo usa cada canal (PLAN\cuentas.json; solo lectura). */
  getAccountBook(): Promise<AccountBook>
  /** Tu cuenta de Vyro: si está conectada, cuándo se leyeron tus envíos y su resumen por campaña. */
  getVyroAccount(): Promise<VyroAccountView>
  /** Abre la web de Vyro para iniciar sesión (lo haces tú); al cerrar la ventana, lee tus envíos. */
  vyroConnect(): Promise<VyroAccountView>
  vyroDisconnect(): Promise<VyroAccountView>
  vyroSyncSubmissions(): Promise<VyroAccountView>
  /** Vuelve a leer ahora la lista pública de Vyro. */
  vyroCheck(): Promise<VyroView>
  /** Enlaza una campaña de Vyro con una tuya (null = ninguna). */
  vyroLink(vyroId: string, campaignId: string | null): Promise<VyroView>
  /** Da por vistas las campañas nuevas. */
  vyroAcknowledge(): Promise<void>
  /** Crea el pedido «hacer esta campaña» y abre el material en el navegador para descargarlo. */
  orderCreate(vyroId: string, notes: string | null): Promise<VyroView>
  /** Cambia las notas o el estado del pedido, o quita un archivo de su lista (sin tocar el archivo). */
  orderUpdate(vyroId: string, cambio: { notes?: string | null; status?: 'waiting' | 'ready'; removeFile?: string }): Promise<VyroView>
  orderCancel(vyroId: string): Promise<VyroView>
  /** Abre la carpeta del pedido en el Explorador. */
  showOrderFolder(vyroId: string): Promise<ActionResult>
  /** «Fuera de campaña»: los vídeos de la carpeta FUERA_DE_CAMPAÑA, por grupos. Solo lectura. */
  listExtras(): Promise<ExtrasView>
  /** Marca o desmarca un vídeo de «Fuera de campaña» como subido a una plataforma. */
  setExtraUploaded(id: string, platform: ExtraPlatform, uploaded: boolean): Promise<ExtrasView>
  /** Abre el vídeo con el reproductor de Windows. */
  openExtra(id: string): Promise<ActionResult>
  /** Abre el Explorador con el vídeo seleccionado (o la carpeta, con null). */
  showExtraInFolder(id: string | null): Promise<ActionResult>
  /** Manda a la Papelera un grupo de «Fuera de campaña» (o todos, con null). Solo lo llama el usuario desde su botón. */
  trashExtras(groupId: string | null): Promise<ExtrasView>
  /** «Vídeos largos» (VIDEOS_LARGOS) o, con 'music', «Vídeos de música» (VIDEOS_MUSICA): 3 títulos y 3 miniaturas. Solo lectura. */
  listLongVideos(kind?: LongKind): Promise<LongVideosView>
  /** Marca o desmarca un vídeo como subido a YouTube. */
  setLongUploaded(id: string, uploaded: boolean, kind?: LongKind): Promise<LongVideosView>
  /** Abre el vídeo con el reproductor de Windows. */
  openLongVideo(id: string, kind?: LongKind): Promise<ActionResult>
  /** Abre en el Explorador la carpeta del vídeo (o la de todos, con null). */
  showLongInFolder(id: string | null, kind?: LongKind): Promise<ActionResult>
  /** Manda ya a la Papelera la carpeta de una campaña (clips y material). Solo lo llama el usuario desde su botón. */
  trashCampaign(campaignId: string): Promise<AppState>
  /** Avisa cuando algo cambia sin que lo pidas (p. ej. la comprobación periódica de Vyro). */
  onStateChanged(listener: (s: AppState) => void): () => void
  /** El proceso principal pide abrir un apartado (p. ej. al pulsar un aviso). */
  onNavigate(listener: (section: string) => void): () => void
}

export type {
  CampaignView, ClipDetail, ClipView, Counts, LibraryView, PublicationInput, PublishedRow, SyncEventView, SyncRunView, SyncSummary
}
export type { PublicationView } from './queries'
export type { RawInfo, RawRemoval }
export type { VyroCampaignView, VyroView } from './vyro'
export type { OrderFile, OrderView }
export type { TikTokAddResult, TikTokRefreshSummary }
export type { AccountInput, AccountView, PlanAccount, PlanClip, PlanDone, PlanPlatform, PlanSkipped, PlanView, PlanWarning } from './plan'
export type { CampaignTermsInput }
export type { CampaignStatusInput, ChannelSyncSummary, ChannelView, RefreshSummary, SnapshotView, StatsView }
export type { SeriesPoint }
export type { VyroPending } from './vyro-pending'
export type { ControlVideo, VideoControl, VyroState } from './video-control'
export type { AccountBook, AccountBookEntry } from './account-book'
export type { VyroSubmissionsSummary, VyroSubmissionView } from './vyro-submissions'

/** Estado de la conexión con tu cuenta de Vyro. */
export interface VyroAccountView {
  connected: boolean
  /** Leyendo tus envíos ahora mismo. */
  syncing: boolean
  lastSyncAt: string | null
  /** Último error (p. ej. sesión caducada). */
  error: string | null
  summary: import('./vyro-submissions').VyroSubmissionsSummary
}
export type { CalendarDay, CalendarItem, CalendarKind, CalendarTaskInput, CalendarView } from './calendar'
export type { ChannelDashboard, ChannelDay, ChannelStudy, ChannelVideo, StudyFinding, StudyLevel } from './channel-dashboard'
export type { ChannelKind }
export type { SocialAccountView, SocialPlatform, SocialRefreshResult, SocialVideoView } from './social'
export type { ExtraGroup, ExtraPlatform, ExtraVideo, ExtrasView } from './extras'
export type { LongKind, LongLetter, LongTitle, LongVideo, LongVideosView } from './long-videos'
export type { WeekendAccount, WeekendPlan, WeekendSlot } from './weekend'
export type { StatsAccount, StatsCampaign, StatsVideo, UnmatchedVideo, ClipOption } from './stats'
