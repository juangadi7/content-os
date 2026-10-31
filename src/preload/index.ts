import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type AppState, type ContentOsApi, type SyncResult } from '../core/api'

// Única puerta de la interfaz al sistema: funciones concretas, sin acceso a Node ni a ipcRenderer.
// Las acciones sobre archivos reciben un clip_id, nunca una ruta.
const api: ContentOsApi = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  sync: () => ipcRenderer.invoke(CHANNELS.sync),
  addLibrary: () => ipcRenderer.invoke(CHANNELS.addLibrary),
  listClips: (campaignId) => ipcRenderer.invoke(CHANNELS.listClips, campaignId),
  getClip: (clipId) => ipcRenderer.invoke(CHANNELS.getClip, clipId),
  listPublished: () => ipcRenderer.invoke(CHANNELS.listPublished),
  savePublication: (input) => ipcRenderer.invoke(CHANNELS.savePublication, input),
  deletePublication: (clipId, publicationId) => ipcRenderer.invoke(CHANNELS.deletePublication, clipId, publicationId),
  openClipFile: (clipId) => ipcRenderer.invoke(CHANNELS.openClipFile, clipId),
  showClipInFolder: (clipId) => ipcRenderer.invoke(CHANNELS.showClipInFolder, clipId),
  copyText: (text) => ipcRenderer.invoke(CHANNELS.copyText, text),
  listSyncProblems: () => ipcRenderer.invoke(CHANNELS.listSyncProblems),
  youtubeConnect: (apiKey) => ipcRenderer.invoke(CHANNELS.youtubeConnect, apiKey),
  youtubeDisconnect: () => ipcRenderer.invoke(CHANNELS.youtubeDisconnect),
  youtubeRefresh: (force) => ipcRenderer.invoke(CHANNELS.youtubeRefresh, force),
  youtubeAddChannel: (ref, kind) => ipcRenderer.invoke(CHANNELS.youtubeAddChannel, ref, kind),
  youtubeRemoveChannel: (channelId) => ipcRenderer.invoke(CHANNELS.youtubeRemoveChannel, channelId),
  youtubeMoveToClips: (channelId) => ipcRenderer.invoke(CHANNELS.youtubeMoveToClips, channelId),
  youtubeLinkVideo: (videoId, clipId) => ipcRenderer.invoke(CHANNELS.youtubeLinkVideo, videoId, clipId),
  youtubeUnlinkVideo: (videoId) => ipcRenderer.invoke(CHANNELS.youtubeUnlinkVideo, videoId),
  youtubeIgnoreVideo: (videoId, ignored) => ipcRenderer.invoke(CHANNELS.youtubeIgnoreVideo, videoId, ignored),
  youtubeDashboard: (kind) => ipcRenderer.invoke(CHANNELS.youtubeDashboard, kind),
  socialRefresh: (force) => ipcRenderer.invoke(CHANNELS.socialRefresh, force),
  socialDashboard: () => ipcRenderer.invoke(CHANNELS.socialDashboard),
  socialLinkVideo: (platform, videoId, clipId) => ipcRenderer.invoke(CHANNELS.socialLinkVideo, platform, videoId, clipId),
  socialUnlinkVideo: (platform, videoId) => ipcRenderer.invoke(CHANNELS.socialUnlinkVideo, platform, videoId),
  getStats: () => ipcRenderer.invoke(CHANNELS.getStats),
  getStatsSeries: () => ipcRenderer.invoke(CHANNELS.getStatsSeries),
  setCampaignStatus: (input) => ipcRenderer.invoke(CHANNELS.setCampaignStatus, input),
  setCampaignTerms: (input) => ipcRenderer.invoke(CHANNELS.setCampaignTerms, input),
  getRawFiles: (campaignId) => ipcRenderer.invoke(CHANNELS.getRawFiles, campaignId),
  deleteRawFiles: (campaignId, mode) => ipcRenderer.invoke(CHANNELS.deleteRawFiles, campaignId, mode),
  getPlan: () => ipcRenderer.invoke(CHANNELS.getPlan),
  getWeekendPlan: () => ipcRenderer.invoke(CHANNELS.getWeekendPlan),
  getVyroPending: () => ipcRenderer.invoke(CHANNELS.getVyroPending),
  setVyroSent: (publicationId, sent) => ipcRenderer.invoke(CHANNELS.setVyroSent, publicationId, sent),
  getCalendar: (from, to) => ipcRenderer.invoke(CHANNELS.getCalendar, from, to),
  addCalendarTask: (input) => ipcRenderer.invoke(CHANNELS.addCalendarTask, input),
  setCalendarTaskDone: (id, done) => ipcRenderer.invoke(CHANNELS.setCalendarTaskDone, id, done),
  deleteCalendarTask: (id) => ipcRenderer.invoke(CHANNELS.deleteCalendarTask, id),
  saveAccount: (input) => ipcRenderer.invoke(CHANNELS.saveAccount, input),
  removeAccount: (id) => ipcRenderer.invoke(CHANNELS.removeAccount, id),
  setCampaignAccounts: (campaignId, accountIds) => ipcRenderer.invoke(CHANNELS.setCampaignAccounts, campaignId, accountIds),
  tiktokAdd: (url) => ipcRenderer.invoke(CHANNELS.tiktokAdd, url),
  tiktokRefresh: (force) => ipcRenderer.invoke(CHANNELS.tiktokRefresh, force),
  getVyro: () => ipcRenderer.invoke(CHANNELS.getVyro),
  getVideoControl: () => ipcRenderer.invoke(CHANNELS.getVideoControl),
  setControlIgnored: (key, ignored) => ipcRenderer.invoke(CHANNELS.setControlIgnored, key, ignored),
  getAccountBook: () => ipcRenderer.invoke(CHANNELS.getAccountBook),
  getVyroAccount: () => ipcRenderer.invoke(CHANNELS.getVyroAccount),
  vyroConnect: () => ipcRenderer.invoke(CHANNELS.vyroConnect),
  vyroDisconnect: () => ipcRenderer.invoke(CHANNELS.vyroDisconnect),
  vyroSyncSubmissions: () => ipcRenderer.invoke(CHANNELS.vyroSyncSubmissions),
  vyroCheck: () => ipcRenderer.invoke(CHANNELS.vyroCheck),
  vyroLink: (vyroId, campaignId) => ipcRenderer.invoke(CHANNELS.vyroLink, vyroId, campaignId),
  vyroAcknowledge: () => ipcRenderer.invoke(CHANNELS.vyroAcknowledge),
  orderCreate: (vyroId, notes) => ipcRenderer.invoke(CHANNELS.orderCreate, vyroId, notes),
  orderUpdate: (vyroId, cambio) => ipcRenderer.invoke(CHANNELS.orderUpdate, vyroId, cambio),
  orderCancel: (vyroId) => ipcRenderer.invoke(CHANNELS.orderCancel, vyroId),
  showOrderFolder: (vyroId) => ipcRenderer.invoke(CHANNELS.showInFolder, vyroId),
  listExtras: () => ipcRenderer.invoke(CHANNELS.listExtras),
  setExtraUploaded: (id, platform, uploaded) => ipcRenderer.invoke(CHANNELS.setExtraUploaded, id, platform, uploaded),
  openExtra: (id) => ipcRenderer.invoke(CHANNELS.openExtra, id),
  showExtraInFolder: (id) => ipcRenderer.invoke(CHANNELS.showExtraInFolder, id),
  trashExtras: (groupId) => ipcRenderer.invoke(CHANNELS.trashExtras, groupId),
  listLongVideos: (kind) => ipcRenderer.invoke(CHANNELS.listLongVideos, kind),
  setLongUploaded: (id, uploaded, kind) => ipcRenderer.invoke(CHANNELS.setLongUploaded, id, uploaded, kind),
  openLongVideo: (id, kind) => ipcRenderer.invoke(CHANNELS.openLongVideo, id, kind),
  showLongInFolder: (id, kind) => ipcRenderer.invoke(CHANNELS.showLongInFolder, id, kind),
  trashCampaign: (campaignId) => ipcRenderer.invoke(CHANNELS.trashCampaign, campaignId),
  onNavigate: (listener) => {
    const f = (_e: unknown, s: string) => listener(s)
    ipcRenderer.on(CHANNELS.navigate, f)
    return () => ipcRenderer.removeListener(CHANNELS.navigate, f)
  },
  onStateChanged: (listener) => {
    const f = (_e: unknown, s: AppState) => listener(s)
    ipcRenderer.on(CHANNELS.stateChanged, f)
    return () => ipcRenderer.removeListener(CHANNELS.stateChanged, f)
  },
  onLibraryChanged: (listener) => {
    const f = (_e: unknown, r: SyncResult) => listener(r)
    ipcRenderer.on(CHANNELS.libraryChanged, f)
    return () => ipcRenderer.removeListener(CHANNELS.libraryChanged, f)
  }
}

contextBridge.exposeInMainWorld('contentOS', api)
