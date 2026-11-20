/**
 * Demo web: sustituye a window.contentOS (el puente con el proceso principal de Electron) por
 * respuestas guardadas de antemano con datos de ejemplo (demo/build-data.ts). La interfaz es la
 * misma de la aplicación; las acciones que escriben, abren archivos o llaman a APIs no hacen nada.
 */
import type { ContentOsApi } from '../core/api'
import datos from '../../demo/out/api.json'

type Api = Record<string, any>
const { generatedAt, api } = datos as unknown as { generatedAt: string; api: Api }

// Las fechas se desplazan para que la demo parezca medida hoy, la abras cuando la abras.
const DIA = 86_400_000
const desfase = Math.max(0, Math.round((Date.now() - Date.parse(generatedAt)) / DIA)) * DIA
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const FECHA = /^\d{4}-\d{2}-\d{2}$/
const mover = (v: unknown): unknown => {
  if (typeof v === 'string') {
    if (ISO.test(v)) return new Date(Date.parse(v) + desfase).toISOString()
    if (FECHA.test(v)) return new Date(Date.parse(v + 'T12:00:00Z') + desfase).toISOString().slice(0, 10)
    return v
  }
  if (Array.isArray(v)) return v.map(mover)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mover(x)]))
  return v
}
const A: Api = desfase ? (mover(api) as Api) : api
const copia = <T>(v: T): T => (v === undefined ? v : structuredClone(v))
const leer = <T>(v: T) => Promise.resolve(copia(v))

;(globalThis as { __COS_MEDIA__?: string }).__COS_MEDIA__ = './media/'

const lectura: Partial<Record<keyof ContentOsApi, (...a: any[]) => Promise<unknown>>> = {
  getState: () => leer(A.getState),
  listClips: (campaignId?: string | null) => leer(A.listClips[campaignId || ''] ?? []),
  getClip: (clipId: string) => leer(A.getClip[clipId] ?? null),
  listPublished: () => leer(A.listPublished),
  listSyncProblems: () => leer(A.listSyncProblems),
  youtubeDashboard: (kind?: string) => leer(A.youtubeDashboard[kind === 'personal' ? 'personal' : 'clips']),
  socialDashboard: () => leer(A.socialDashboard),
  getStats: () => leer(A.getStats),
  getStatsSeries: () => leer(A.getStatsSeries),
  getPlan: () => leer(A.getPlan),
  getWeekendPlan: () => leer(A.getWeekendPlan),
  getVyroPending: () => leer(A.getVyroPending),
  getCalendar: () => leer(A.getCalendar),
  getVyro: () => leer(A.getVyro),
  getVideoControl: () => leer(A.getVideoControl),
  getAccountBook: () => leer(A.getAccountBook),
  getVyroAccount: () => leer(A.getVyroAccount),
  listExtras: () => leer(A.listExtras),
  listLongVideos: (kind?: string) => leer(A.listLongVideos[kind && A.listLongVideos[kind] ? kind : 'long']),
  getOwnStats: (channel: string) => leer(A.getOwnStats[channel] ?? A.getOwnStats.gta),
  getFabrica: () => leer(A.getFabrica),
  getMetricoolQueue: () => leer(A.getMetricoolQueue),
  getRawFiles: () => leer({ files: [], totalBytes: 0, folder: null }),
  // acciones que devuelven la vista actualizada: en la demo, la misma de siempre
  youtubeRefresh: () => leer({ channels: 1, videos: 15, linkedNow: 0, unmatched: 0, measured: 0 }),
  tiktokRefresh: () => leer({ publications: 0, measured: 0, skippedRecent: 0, withoutUrl: 0, failed: 0, error: null }),
  socialRefresh: () => leer({ accounts: [], error: null }),
  sync: () => leer({ state: A.getState, summary: { roots: 1, campaigns: 3, clips: 15, clipsSeen: 15, created: 0, updated: 0, disappeared: 0, warnings: 0, errors: 0 } }),
  copyText: (t: string) => navigator.clipboard?.writeText(t).then(() => ({ ok: true })).catch(() => ({ ok: false })) ?? leer({ ok: false })
}

function aviso(): void {
  const id = 'demo-toast'
  document.getElementById(id)?.remove()
  const el = document.createElement('div')
  el.id = id
  el.className = 'demo-toast'
  el.textContent = 'Demo con datos de ejemplo: esta acción no hace nada aquí.'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2600)
}

const contentOS = new Proxy({} as ContentOsApi, {
  get(_t, nombre: string) {
    if (nombre === 'onNavigate' || nombre === 'onStateChanged' || nombre === 'onLibraryChanged') return () => () => undefined
    const f = lectura[nombre as keyof ContentOsApi]
    if (f) return f
    // cualquier acción que escriba o abra algo: aviso y la vista correspondiente sin cambios
    return () => {
      aviso()
      return Promise.reject(new Error('Demo con datos de ejemplo: esta acción no está disponible en la versión web.'))
    }
  }
})

;(window as unknown as { contentOS: ContentOsApi }).contentOS = contentOS
