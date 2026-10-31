import { app, BrowserWindow, clipboard, dialog, ipcMain, net, Notification, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHANNELS, type ActionResult, type AppState, type SyncResult } from '../core/api'
import { refreshYouTubeStats } from '../core/analytics'
import { getChannelDashboards } from '../core/channel-dashboard'
import { setCampaignStatus, setCampaignTerms, type CampaignStatusInput, type CampaignTermsInput } from '../core/campaigns'
import { loadConfig, saveConfig } from '../core/config'
import { openDatabase, type DB } from '../core/db'
import { EXTRAS_FOLDER, listExtras, resolveExtra, setExtraUploaded, trashExtras } from '../core/extras'
import { LONG_FOLDER, MUSIC_FOLDER, asLongKind, listLongVideos, resolveLongFolder, resolveLongVideo, setLongUploaded } from '../core/long-videos'
import { purgeEndedCampaigns, trashCampaign } from '../core/purge'
import { getWeekendPlan } from '../core/weekend'
import { getVideoControl, setControlIgnored } from '../core/video-control'
import { loadAccountBook } from '../core/account-book'
import { listVyroPending, markVyroCampaignRead, setVyroSent } from '../core/vyro-pending'
import { campaignsToSync, parseSubmissions, saveSubmissions, submissionsSummary } from '../core/vyro-submissions'
import { clearVyroSession, hasVyroSession, openVyroLogin, readVyroSubmissions, VyroNotLoggedIn } from './vyro-session'
import type { VyroAccountView } from '../core/api'
import { addCalendarTask, deleteCalendarTask, getCalendar, loadCalendarNotes, setCalendarTaskDone } from '../core/calendar'
import { loadAdvice } from '../core/advice'
import { getPlan as getPlanBase, listAccounts, removeAccount, saveAccount, setCampaignAccounts, type AccountInput } from '../core/plan'
import { attachMaterial, cancelOrder, createOrder, getOrder, hasWaitingOrders, updateOrder } from '../core/orders'
import { deletePublication, savePublication, type PublicationInput } from '../core/publications'
import { clipPaths, counts, getCampaign, getClip, lastSyncRun, listCampaigns, listClips, listLibraries, listPublished, listSyncProblems } from '../core/queries'
import { listRawFiles, removeRawFiles } from '../core/raw'
import { getStats } from '../core/stats'
import { getStatsSeries } from '../core/stats-series'
import { addTikTokVideo, refreshTikTokStats } from '../core/tiktok'
import { acknowledgeVyro, fetchVyroCampaigns, getVyro, linkVyroCampaign, recordVyroError, syncVyro, vyroNewCount, type TextFetch } from '../core/vyro'
import { fetchChannelAvatars, fetchVideoStats, isAvatarUrl, isChannelId, type FetchLike } from '../core/youtube'
import { getSocialDashboards, linkSocialVideo, unlinkSocialVideo, type SocialFetch } from '../core/social'
import { refreshSocial, socialConnections } from './social-sync'
import { addChannel, ignoreVideo, linkVideo, listChannels, moveChannelToClips, removeChannel, syncChannels, syncChannelStats, unlinkVideo } from '../core/youtube-channels'
import { handleMedia, registerMediaScheme } from './protocol'
import { deleteSecret, getSecret, hasSecret, setSecret } from './secrets'
import { runSmokeTest } from './smoke'
import { runSyncInWorker } from './sync'
import { watchLibraries } from './watch'

// ---- datos de CONTENT OS: %APPDATA%\ContentOS (fuera del código y fuera del generador)
const dataDir = process.env.CONTENT_OS_DATA_DIR || path.join(app.getPath('appData'), 'ContentOS')
const dirs = {
  data: dataDir,
  config: path.join(dataDir, 'config'),
  thumbs: path.join(dataDir, 'thumbs'),
  avatars: path.join(dataDir, 'avatars'),
  backups: path.join(dataDir, 'backups')
}
const dbPath = path.join(dirs.data, 'content-os.db')
// los archivos internos de Chromium van aparte para no mezclarse con los datos
app.setPath('userData', path.join(dataDir, 'electron'))
registerMediaScheme()
// solo en la prueba de humo: que la ventana siga pintando aunque quede tapada por otras (para las capturas)
if (process.env.CONTENT_OS_SMOKE) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
}

/**
 * Propuesta de biblioteca para el primer arranque: solo si la carpeta existe. Se guarda en
 * config.json y a partir de ahí manda ese archivo; el dominio no conoce ninguna ruta.
 */
function bibliotecasPorDefecto(): string[] {
  if (process.env.CONTENT_OS_NO_DEFAULT_LIBRARY) return []
  const candidata = path.join(os.homedir(), 'mundial-clipper', 'CAMPAIGNS')
  return fs.existsSync(candidata) ? [candidata] : []
}

let db: DB

/** La ventana de la aplicación (no las de Vyro: la de iniciar sesión ni la invisible que lee tus envíos). */
let principal: BrowserWindow | null = null
const ventanaPrincipal = (): BrowserWindow | undefined => (principal && !principal.isDestroyed() ? principal : undefined)

/**
 * Plan de «Hoy» con las recomendaciones del operador: la clave "plan" de cada campaign.json y, junto a la
 * biblioteca, PLAN\\canales.json. Solo se leen. En la prueba de humo no se usa el archivo de canales.
 */
function getPlan(base: DB) {
  const raiz = loadConfig(dirs.config, bibliotecasPorDefecto).config.library_roots[0]
  const canales = raiz && !process.env.CONTENT_OS_SMOKE ? path.join(path.dirname(path.resolve(raiz)), 'PLAN', 'canales.json') : null
  return getPlanBase(base, new Date(), loadAdvice(base, canales))
}
/** Plan del fin de semana, con las mismas recomendaciones de canal que «Hoy». */
function planFinde(base: DB) {
  const raiz = loadConfig(dirs.config, bibliotecasPorDefecto).config.library_roots[0]
  const canales = raiz && !process.env.CONTENT_OS_SMOKE ? path.join(path.dirname(path.resolve(raiz)), 'PLAN', 'canales.json') : null
  return getWeekendPlan(base, new Date(), loadAdvice(base, canales))
}
/**
 * Calendario: lo de «Hoy» y «Fin de semana» más las tareas apuntadas y las que deja Claude en
 * <biblioteca>..PLANcalendario.json (solo se lee; en la prueba de humo no se usa).
 */
function calendario(base: DB, from: unknown, to: unknown) {
  if (typeof from !== 'string' || typeof to !== 'string') throw new Error('Fechas no válidas.')
  const raiz = loadConfig(dirs.config, bibliotecasPorDefecto).config.library_roots[0]
  const archivo = raiz && !process.env.CONTENT_OS_SMOKE ? path.join(path.dirname(path.resolve(raiz)), 'PLAN', 'calendario.json') : null
  const { notes, error } = loadCalendarNotes(archivo)
  return getCalendar(base, from, to, new Date(), { plan: getPlan(base), weekend: planFinde(base), notes, notesFile: archivo, notesError: error })
}
const YOUTUBE_KEY = 'youtube_api_key'
/** Peticiones a YouTube desde el proceso principal (respeta el proxy del sistema). La interfaz no hace red. */
const pedir: FetchLike = (url, init) => net.fetch(url, { headers: init.headers })
/** Peticiones a TikTok e Instagram (GET y POST) desde el proceso principal. */
const pedirSocial: SocialFetch = (url, init) => net.fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body })
let sincronizacion: Promise<SyncResult> | null = null

/** «Fuera de campaña»: junto a la biblioteca (en la prueba de humo, dentro de sus datos temporales). */
function carpetaExtras(): string {
  const raiz = loadConfig(dirs.config, bibliotecasPorDefecto).config.library_roots[0]
  return raiz && !process.env.CONTENT_OS_SMOKE ? path.join(path.dirname(path.resolve(raiz)), EXTRAS_FOLDER) : path.join(dirs.data, 'fuera-de-campana')
}

/** «Vídeos largos»: junto a la biblioteca, como «Fuera de campaña» (en la prueba de humo, en sus datos temporales). */
function carpetaLargos(): string {
  const raiz = loadConfig(dirs.config, bibliotecasPorDefecto).config.library_roots[0]
  return raiz && !process.env.CONTENT_OS_SMOKE ? path.join(path.dirname(path.resolve(raiz)), LONG_FOLDER) : path.join(dirs.data, 'videos-largos')
}

/** «Vídeos de música»: al lado de «Vídeos largos» (en la prueba de humo, en sus datos temporales). */
function carpetaMusica(): string {
  const raiz = loadConfig(dirs.config, bibliotecasPorDefecto).config.library_roots[0]
  return raiz && !process.env.CONTENT_OS_SMOKE ? path.join(path.dirname(path.resolve(raiz)), MUSIC_FOLDER) : path.join(dirs.data, 'videos-musica')
}
const carpetaDeTipo = (kind: unknown) => (asLongKind(kind) === 'music' ? carpetaMusica() : carpetaLargos())

function estado(): AppState {
  const cfg = loadConfig(dirs.config, bibliotecasPorDefecto)
  return {
    appVersion: app.getVersion(),
    dataDir: dirs.data,
    configPath: cfg.path,
    configError: cfg.error,
    configuredRoots: cfg.config.library_roots,
    libraries: listLibraries(db),
    campaigns: listCampaigns(db),
    counts: counts(db),
    lastRun: lastSyncRun(db),
    syncing: sincronizacion !== null,
    youtubeConnected: hasSecret(dirs.config, YOUTUBE_KEY),
    youtubeChannels: listChannels(db, 'clips'),
    socialConnected: socialConnections(),
    personalChannels: listChannels(db, 'personal'),
    todayLeft: getPlan(db).left,
    accounts: listAccounts(db),
    vyroNew: vyroNewCount(db),
    videosAlert: (() => { const c = getVideoControl(db).counts; return c.duplicate + c.missing + c.manual + c.not_found + c.unchecked })(),
    vyroToSend: listVyroPending(db).length,
    extrasCount: listExtras(db, carpetaExtras()).total,
    longPending: listLongVideos(db, carpetaLargos()).videos.filter((v) => !v.uploadedAt).length,
    musicPending: listLongVideos(db, carpetaMusica(), 'music').videos.filter((v) => !v.uploadedAt).length
  }
}

/** Una sola sincronización a la vez; si ya hay una en marcha, se espera a esa. */
function sincronizar(): Promise<SyncResult> {
  if (sincronizacion) return sincronizacion
  const cfg = loadConfig(dirs.config, bibliotecasPorDefecto)
  if (cfg.error) return Promise.reject(new Error(cfg.error))
  sincronizacion = runSyncInWorker({ dbPath, roots: cfg.config.library_roots, thumbsDir: dirs.thumbs })
    .then((summary) => {
      sincronizacion = null
      return { summary, state: estado() }
    })
    .catch((e) => {
      sincronizacion = null
      throw e
    })
  return sincronizacion
}

// ---- sincronización automática: al cambiar la carpeta de campañas y, por si acaso, cada 10 minutos
const vigilante = watchLibraries({ quietMs: 12_000, maxWaitMs: 180_000, onChange: () => sincronizarSola() })
function vigilarBibliotecas(): void {
  const cfg = loadConfig(dirs.config, bibliotecasPorDefecto)
  if (!cfg.error) vigilante.setRoots(cfg.config.library_roots)
}
/**
 * Campañas terminadas hace una semana: su carpeta va a la Papelera de Windows (se puede recuperar desde
 * ahí). Lo apuntado en CONTENT OS (publicaciones, cifras, pagos) se conserva.
 */
async function limpiarCampanas(): Promise<void> {
  const cfg = loadConfig(dirs.config, bibliotecasPorDefecto)
  if (cfg.error || sincronizacion) return
  const r = await purgeEndedCampaigns(db, cfg.config.library_roots, (carpeta) => shell.trashItem(carpeta), {
    linksDir: path.join(app.getPath('desktop'), 'Campañas clips')
  })
  if (!r.trashed.length) return
  new Notification({
    title: r.trashed.length === 1 ? 'Campaña terminada enviada a la Papelera' : `${r.trashed.length} campañas terminadas enviadas a la Papelera`,
    body: [...r.trashed.slice(0, 4).map((c) => c.name), 'Sus cifras y publicaciones siguen en CONTENT OS.'].join('\n')
  }).show()
  sincronizarSola()
}

/**
 * Recordatorio de Vyro: cuando un vídeo pasa a ser público (llega la hora de uno programado o la sincronización
 * con YouTube lo encuentra), un aviso de Windows dice que toca enviarlo. Cada publicación avisa una sola vez
 * por sesión; lo que ya estaba pendiente al abrir la app no se avisa (está en «Hoy»).
 */
let vyroAvisados: Set<string> | null = null
function avisarVyro(): void {
  // lo ya público que falta enviar: lo marcado en la app (también TikTok) y lo que el control ve en tus canales
  const porAvisar = new Map<string, { title: string; donde: string }>()
  for (const p of listVyroPending(db)) porAvisar.set(`p${p.publicationId}`, { title: p.title, donde: p.account || p.platform })
  const hace2dias = Date.now() - 2 * 86_400_000
  for (const v of getVideoControl(db).videos) {
    if ((v.vyro.state === 'missing' || v.vyro.state === 'unchecked') && !v.scheduled && v.publishedAt && Date.parse(v.publishedAt) >= hace2dias) {
      porAvisar.set(v.key, { title: v.title, donde: v.account || v.platform })
    }
  }
  if (vyroAvisados === null) {
    vyroAvisados = new Set(porAvisar.keys())
    return
  }
  const nuevos = [...porAvisar].filter(([k]) => !vyroAvisados!.has(k))
  if (!nuevos.length) return
  for (const [k] of nuevos) vyroAvisados.add(k)
  if (!process.env.CONTENT_OS_SMOKE) {
    const aviso = new Notification({
      title: nuevos.length === 1 ? 'Ya es público: envíalo a Vyro' : `${nuevos.length} vídeos ya son públicos: envíalos a Vyro`,
      body: [...nuevos.slice(0, 4).map(([, v]) => `${v.title} · ${v.donde}`), 'Pulsa aquí: «Control de vídeos», con el enlace listo.'].join('\n')
    })
    // al pulsar el aviso se abre la app en «Control de vídeos»
    aviso.on('click', () => {
      const w = ventanaPrincipal()
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
      w.webContents.send(CHANNELS.navigate, 'control')
    })
    aviso.show()
  }
  const win = ventanaPrincipal()
  if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.stateChanged, estado())
}

/**
 * Tus envíos en Vyro: con la sesión que inicias tú en «Conectar Vyro», se leen cada 30 minutos (solo lectura).
 * Lo que ya está en Vyro se marca como enviado y deja de pedirse.
 */
let leyendoEnvios: Promise<void> | null = null
const leerAjuste = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null
const guardarAjuste = (k: string, v: string | null) =>
  v === null ? db.prepare('DELETE FROM settings WHERE key = ?').run(k) : db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)
async function cuentaVyro(): Promise<VyroAccountView> {
  const summary = submissionsSummary(db)
  return { connected: await hasVyroSession(), syncing: leyendoEnvios !== null, lastSyncAt: leerAjuste('vyro_envios_leidos'), error: leerAjuste('vyro_envios_error'), summary }
}
/**
 * Informe de la última lectura de Vyro, para revisar con Claude si algo no cuadra: qué campañas se leyeron y el estado
 * de cada vídeo. Va a Documentos\CONTENT OS (fuera de la carpeta de datos de la app). Sin contraseñas ni correos.
 */
function escribirDiagnostico(lecturas: unknown): void {
  try {
    const dir = path.join(app.getPath('documents'), 'CONTENT OS')
    fs.mkdirSync(dir, { recursive: true })
    const control = getVideoControl(db)
    const envios = db.prepare('SELECT vyro_campaign_id, platform, video_id, username, status, views, submitted_at, publication_id, synced_at FROM vyro_submissions ORDER BY submitted_at DESC').all()
    fs.writeFileSync(path.join(dir, 'diagnostico-vyro.json'), JSON.stringify({ generado: new Date().toISOString(), lecturas, control: control.videos.map((v) => ({
      clave: v.key, plataforma: v.platform, cuenta: v.account, videoId: v.videoId, titulo: v.title, publicado: v.publishedAt, campaña: v.campaignName,
      estado: v.vyro.state, motivo: v.vyro.reason, comprobado: v.vyro.checkedAt,
    })), envios }, null, 1))
  } catch {
    /* el diagnóstico nunca debe romper la lectura */
  }
}

function leerEnviosVyro(): Promise<void> {
  if (leyendoEnvios) return leyendoEnvios
  leyendoEnvios = (async () => {
    try {
      if (process.env.CONTENT_OS_SMOKE || !(await hasVyroSession())) return
      const campañas = campaignsToSync(db)
      const leidos = await readVyroSubmissions(campañas.map((c) => c.vyroId))
      const diag: { vyroId: string; name: string; read: boolean; at: string | null; bodies: number; items: number; error: string | null }[] = []
      for (const c of campañas) {
        const r = leidos.get(c.vyroId)
        let items = 0
        let error: string | null = r ? null : 'no se llegó a leer (tope de tiempo)'
        for (const b of r?.bodies ?? []) {
          try {
            const p = parseSubmissions(b)
            items += p.items.length
            saveSubmissions(db, p.items)
          } catch (e) {
            error = (e as Error).message
          }
        }
        if (r && r.bodies.length && !error) markVyroCampaignRead(db, c.vyroId, r.at)
        else if (r && !r.bodies.length) error = 'Vyro no devolvió la lista de envíos de esta campaña'
        diag.push({ vyroId: c.vyroId, name: c.name, read: !!r && !error, at: r?.at ?? null, bodies: r?.bodies.length ?? 0, items, error })
      }
      escribirDiagnostico(diag)
      if (campañas.length && diag.every((d) => !d.read)) throw new Error('Vyro no devolvió ninguna lista de envíos. Si la sesión ha caducado, pulsa «Conectar Vyro» otra vez.')
      guardarAjuste('vyro_envios_leidos', new Date().toISOString())
      guardarAjuste('vyro_envios_error', null)
    } catch (e) {
      guardarAjuste('vyro_envios_error', e instanceof VyroNotLoggedIn ? e.message : `No se pudieron leer tus envíos de Vyro: ${(e as Error).message}`)
    } finally {
      leyendoEnvios = null
      // solo a la ventana de la aplicación (no a las de Vyro)
      ventanaPrincipal()?.webContents.send(CHANNELS.stateChanged, estado())
    }
  })()
  return leyendoEnvios
}

function sincronizarSola(): void {
  const win = ventanaPrincipal()
  if (!win || sincronizacion) return
  sincronizar()
    .then((r) => !win.isDestroyed() && win.webContents.send(CHANNELS.libraryChanged, r))
    .catch(() => undefined)
}

// ---- Vyro: se lee la lista pública de campañas (sin cuenta) al abrir y cada 30 minutos
const pedirTexto: TextFetch = (url, init) => net.fetch(url, { headers: init.headers })
let leyendoVyro: Promise<void> | null = null
function comprobarVyro(avisar: boolean): Promise<void> {
  if (leyendoVyro) return leyendoVyro
  leyendoVyro = (async () => {
    try {
      const r = syncVyro(db, await fetchVyroCampaigns(pedirTexto))
      if (avisar && r.fresh.length > 0 && Notification.isSupported()) {
        const n = new Notification({
          title: r.fresh.length === 1 ? 'Campaña nueva en Vyro' : `${r.fresh.length} campañas nuevas en Vyro`,
          body: r.fresh.slice(0, 3).map((c) => `${c.brand} · ${c.name}${c.payRate != null ? ` · ${c.payRate} $ por 1.000 visitas` : ''}`).join('\n')
        })
        n.on('click', () => {
          const w = ventanaPrincipal()
          if (w) {
            if (w.isMinimized()) w.restore()
            w.show()
            w.focus()
          }
        })
        n.show()
      }
    } catch (e) {
      recordVyroError(db, (e as Error).message)
    }
    const w = ventanaPrincipal()
    if (w && !w.isDestroyed()) w.webContents.send(CHANNELS.stateChanged, estado())
  })().finally(() => {
    leyendoVyro = null
  })
  return leyendoVyro
}

/**
 * Imagen de cada canal de YouTube seguido, guardada en el equipo para enseñarla sin cargar nada de internet desde la
 * interfaz. Solo se piden las que faltan o tienen más de una semana.
 */
async function actualizarAvatares(clave: string): Promise<number> {
  const SEMANA = 7 * 24 * 3600_000
  const faltan = listChannels(db).map((c) => c.channelId).filter(isChannelId).filter((id) => {
    const f = path.join(dirs.avatars, id)
    return !fs.existsSync(f) || Date.now() - fs.statSync(f).mtimeMs > SEMANA
  })
  if (faltan.length === 0) return 0
  let n = 0
  for (const [id, url] of await fetchChannelAvatars(faltan, clave, pedir)) {
    if (!isChannelId(id) || !isAvatarUrl(url)) continue
    try {
      const res = await net.fetch(url)
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) continue
      const datos = Buffer.from(await res.arrayBuffer())
      if (datos.length === 0 || datos.length > 2_000_000) continue
      fs.writeFileSync(path.join(dirs.avatars, id), datos)
      n++
    } catch {
      /* sin imagen: la interfaz enseña la inicial del canal */
    }
  }
  return n
}

const clipIdValido = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

/** Ruta del MP4 de un clip, solo si está en la base de datos y existe en disco. */
function rutaDeClip(clipId: unknown): string {
  if (!clipIdValido(clipId)) throw new Error('Clip no válido.')
  const ruta = clipPaths(db, clipId)?.video
  if (!ruta || !fs.existsSync(ruta)) throw new Error('No se encuentra el archivo de este clip.')
  return ruta
}

const accion = async (f: () => Promise<void> | void): Promise<ActionResult> => {
  try {
    await f()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function registrarIpc(): void {
  ipcMain.handle(CHANNELS.getState, () => estado())
  ipcMain.handle(CHANNELS.sync, () => sincronizar())
  ipcMain.handle(CHANNELS.addLibrary, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win!, { title: 'Elegir la carpeta de campañas', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const cfg = loadConfig(dirs.config, bibliotecasPorDefecto)
    if (cfg.error) throw new Error(cfg.error)
    saveConfig(dirs.config, { library_roots: [...cfg.config.library_roots, r.filePaths[0]] })
    vigilarBibliotecas()
    return estado()
  })
  ipcMain.handle(CHANNELS.listClips, (_e, campaignId: unknown) => {
    if (campaignId !== null && !clipIdValido(campaignId)) throw new Error('Campaña no válida.')
    return listClips(db, campaignId)
  })
  ipcMain.handle(CHANNELS.getClip, (_e, clipId: unknown) => {
    if (!clipIdValido(clipId)) throw new Error('Clip no válido.')
    return getClip(db, clipId)
  })
  ipcMain.handle(CHANNELS.listPublished, () => listPublished(db))
  ipcMain.handle(CHANNELS.savePublication, (_e, input: PublicationInput) => {
    savePublication(db, input)
    return getClip(db, input.clipId)
  })
  ipcMain.handle(CHANNELS.deletePublication, (_e, clipId: unknown, id: unknown) => {
    if (!clipIdValido(clipId) || typeof id !== 'number') throw new Error('Publicación no válida.')
    const pub = db.prepare('SELECT clip_id FROM publications WHERE id = ?').get(id) as { clip_id: string } | undefined
    if (!pub || pub.clip_id !== clipId) throw new Error('La publicación no existe.')
    deletePublication(db, id)
    return getClip(db, clipId)
  })
  // ---- archivos: solo abrir y mostrar. Nada de mover, renombrar, copiar ni borrar.
  ipcMain.handle(CHANNELS.openClipFile, (_e, clipId: unknown) =>
    accion(async () => {
      const error = await shell.openPath(rutaDeClip(clipId))
      if (error) throw new Error(error)
    })
  )
  ipcMain.handle(CHANNELS.showClipInFolder, (_e, clipId: unknown) => accion(() => shell.showItemInFolder(rutaDeClip(clipId))))
  ipcMain.handle(CHANNELS.copyText, (_e, text: unknown) =>
    accion(() => {
      if (typeof text !== 'string') throw new Error('Nada que copiar.')
      return clipboard.writeText(text)
    })
  )
  ipcMain.handle(CHANNELS.listSyncProblems, () => listSyncProblems(db))
  // ---- YouTube: solo lectura de cifras públicas con una clave de API
  ipcMain.handle(CHANNELS.youtubeConnect, async (_e, apiKey: unknown) => {
    const clave = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(clave)) throw new Error('Eso no parece una clave de API de Google.')
    // se comprueba con una petición real antes de guardarla (vídeo público cualquiera; cuesta 1 unidad)
    await fetchVideoStats(['jNQXAC9IVRw'], clave, pedir)
    setSecret(dirs.config, YOUTUBE_KEY, clave)
    return estado()
  })
  ipcMain.handle(CHANNELS.youtubeDisconnect, () => {
    deleteSecret(dirs.config, YOUTUBE_KEY)
    return estado()
  })
  const claveYouTube = (): string => {
    const clave = getSecret(dirs.config, YOUTUBE_KEY)
    if (!clave) throw new Error('YouTube no está conectado.')
    return clave
  }
  const texto = (v: unknown): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 300) throw new Error('Dato no válido.')
    return v
  }
  ipcMain.handle(CHANNELS.youtubeRefresh, async (_e, force: unknown) => {
    const clave = claveYouTube()
    // primero los canales (descubren y emparejan vídeos); después, las URL puestas a mano que queden
    const channels = await syncChannels(db, clave, pedir, { force: force === true })
    // suscriptores y visitas totales de cada canal: si falla, las cifras de los vídeos ya están guardadas
    await syncChannelStats(db, clave, pedir).catch(() => undefined)
    await actualizarAvatares(clave).catch(() => undefined)
    const byUrl = await refreshYouTubeStats(db, clave, pedir, { force: false })
    avisarVyro()
    return { channels, byUrl }
  })
  const tipoDeCanal = (v: unknown) => (v === 'personal' ? 'personal' : 'clips')
  ipcMain.handle(CHANNELS.youtubeAddChannel, async (_e, ref: unknown, kind: unknown) => {
    await addChannel(db, texto(ref), claveYouTube(), pedir, undefined, tipoDeCanal(kind))
    return estado()
  })
  ipcMain.handle(CHANNELS.youtubeMoveToClips, (_e, channelId: unknown) => {
    moveChannelToClips(db, texto(channelId))
    return estado()
  })
  ipcMain.handle(CHANNELS.youtubeRemoveChannel, (_e, channelId: unknown) => {
    removeChannel(db, texto(channelId))
    return estado()
  })
  ipcMain.handle(CHANNELS.youtubeLinkVideo, (_e, videoId: unknown, clipId: unknown) => {
    linkVideo(db, texto(videoId), texto(clipId))
    return getStats(db)
  })
  ipcMain.handle(CHANNELS.youtubeUnlinkVideo, (_e, videoId: unknown) => {
    unlinkVideo(db, texto(videoId))
    return getStats(db)
  })
  ipcMain.handle(CHANNELS.youtubeIgnoreVideo, (_e, videoId: unknown, ignored: unknown) => {
    ignoreVideo(db, texto(videoId), ignored === true)
    return getStats(db)
  })
  ipcMain.handle(CHANNELS.youtubeDashboard, (_e, kind: unknown) => getChannelDashboards(db, new Date(), tipoDeCanal(kind)))
  // ---- TikTok e Instagram: API oficiales, solo lectura (claves en .secretos)
  const plataformaSocial = (v: unknown) => {
    if (v !== 'tiktok' && v !== 'instagram') throw new Error('Plataforma no válida.')
    return v
  }
  ipcMain.handle(CHANNELS.socialRefresh, async (_e, force: unknown) => {
    const r = await refreshSocial(db, pedirSocial, { force: force === true })
    avisarVyro()
    return r
  })
  ipcMain.handle(CHANNELS.socialDashboard, () => getSocialDashboards(db))
  ipcMain.handle(CHANNELS.socialLinkVideo, (_e, platform: unknown, videoId: unknown, clipId: unknown) => {
    linkSocialVideo(db, plataformaSocial(platform), texto(videoId), texto(clipId))
    return getSocialDashboards(db)
  })
  ipcMain.handle(CHANNELS.socialUnlinkVideo, (_e, platform: unknown, videoId: unknown) => {
    unlinkSocialVideo(db, plataformaSocial(platform), texto(videoId))
    return getSocialDashboards(db)
  })
  ipcMain.handle(CHANNELS.getStats, () => getStats(db))
  ipcMain.handle(CHANNELS.getStatsSeries, () => getStatsSeries(db))
  ipcMain.handle(CHANNELS.setCampaignStatus, (_e, input: CampaignStatusInput) => {
    setCampaignStatus(db, input)
    return estado()
  })
  ipcMain.handle(CHANNELS.setCampaignTerms, (_e, input: CampaignTermsInput) => {
    setCampaignTerms(db, input)
    return estado()
  })
  // ---- plan de «Hoy» y canales
  ipcMain.handle(CHANNELS.getPlan, () => getPlan(db))
  ipcMain.handle(CHANNELS.saveAccount, (_e, input: AccountInput) => {
    saveAccount(db, input)
    return getPlan(db)
  })
  ipcMain.handle(CHANNELS.removeAccount, (_e, id: unknown) => {
    if (typeof id !== 'number') throw new Error('Canal no válido.')
    removeAccount(db, id)
    return getPlan(db)
  })
  ipcMain.handle(CHANNELS.setCampaignAccounts, (_e, campaignId: unknown, accountIds: unknown) => {
    if (!clipIdValido(campaignId)) throw new Error('Campaña no válida.')
    setCampaignAccounts(db, campaignId, accountIds as number[])
    return estado()
  })
  // ---- TikTok: cifras públicas leídas de la página de cada vídeo (sin cuenta)
  ipcMain.handle(CHANNELS.tiktokAdd, (_e, url: unknown) => addTikTokVideo(db, texto(url), pedirTexto))
  ipcMain.handle(CHANNELS.tiktokRefresh, (_e, force: unknown) => refreshTikTokStats(db, pedirTexto, { force: force === true }))
  // ---- Vyro
  ipcMain.handle(CHANNELS.getVyro, () => getVyro(db))
  ipcMain.handle(CHANNELS.getVideoControl, () => getVideoControl(db))
  ipcMain.handle(CHANNELS.setControlIgnored, (_e, key: unknown, ignored: unknown) => {
    setControlIgnored(db, key, ignored === true)
    return getVideoControl(db)
  })
  ipcMain.handle(CHANNELS.getAccountBook, () => {
    // <biblioteca>\..\PLAN\cuentas.json (en la prueba de humo no se usa)
    const raiz = loadConfig(dirs.config, bibliotecasPorDefecto).config.library_roots[0]
    return loadAccountBook(raiz && !process.env.CONTENT_OS_SMOKE ? path.join(path.dirname(path.resolve(raiz)), 'PLAN', 'cuentas.json') : null)
  })
  ipcMain.handle(CHANNELS.getVyroAccount, () => cuentaVyro())
  ipcMain.handle(CHANNELS.vyroConnect, async (e) => {
    await openVyroLogin(BrowserWindow.fromWebContents(e.sender))
    guardarAjuste('vyro_envios_error', null)
    await leerEnviosVyro()
    avisarVyro()
    return cuentaVyro()
  })
  ipcMain.handle(CHANNELS.vyroDisconnect, async () => {
    await clearVyroSession()
    guardarAjuste('vyro_envios_error', null)
    return cuentaVyro()
  })
  ipcMain.handle(CHANNELS.vyroSyncSubmissions, async () => {
    await leerEnviosVyro()
    avisarVyro()
    return cuentaVyro()
  })
  ipcMain.handle(CHANNELS.vyroCheck, async () => {
    await comprobarVyro(false)
    return getVyro(db)
  })
  ipcMain.handle(CHANNELS.vyroLink, (_e, vyroId: unknown, campaignId: unknown) => {
    if (campaignId !== null && !clipIdValido(campaignId)) throw new Error('Campaña no válida.')
    linkVyroCampaign(db, texto(vyroId), campaignId)
    return getVyro(db)
  })
  ipcMain.handle(CHANNELS.vyroAcknowledge, () => acknowledgeVyro(db))
  // ---- pedidos «hacer esta campaña»: una carpeta junto a la biblioteca (nunca dentro de CAMPAIGNS)
  const carpetaPedidos = (): string => {
    const raiz = loadConfig(dirs.config, bibliotecasPorDefecto).config.library_roots[0]
    // en la prueba de humo, dentro de sus datos temporales: nunca junto a la biblioteca real
    return raiz && !process.env.CONTENT_OS_SMOKE ? path.join(path.dirname(path.resolve(raiz)), 'PEDIDOS') : path.join(dirs.data, 'pedidos')
  }
  ipcMain.handle(CHANNELS.orderCreate, async (_e, vyroId: unknown, notes: unknown) => {
    const pedido = createOrder(db, { vyroId: texto(vyroId), notes: typeof notes === 'string' ? notes : null }, carpetaPedidos())
    // el material se descarga en el navegador del usuario; la aplicación solo apunta lo que llegue a Descargas
    const enlace = getVyro(db).campaigns.find((c) => c.vyroId === pedido.vyroId)?.materialLinks[0]
    if (enlace && /^https:\/\//i.test(enlace) && !process.env.CONTENT_OS_SMOKE) void shell.openExternal(enlace)
    return getVyro(db)
  })
  ipcMain.handle(CHANNELS.orderUpdate, (_e, vyroId: unknown, cambio: { notes?: string | null; status?: 'waiting' | 'ready'; removeFile?: string }) => {
    updateOrder(db, texto(vyroId), { notes: cambio?.notes, status: cambio?.status, removeFile: cambio?.removeFile })
    return getVyro(db)
  })
  ipcMain.handle(CHANNELS.orderCancel, (_e, vyroId: unknown) => {
    cancelOrder(db, texto(vyroId))
    return getVyro(db)
  })
  ipcMain.handle(CHANNELS.showInFolder, (_e, vyroId: unknown) =>
    accion(() => {
      const pedido = getOrder(db, texto(vyroId))
      if (!pedido || !fs.existsSync(pedido.file)) throw new Error('No se encuentra el pedido.')
      shell.showItemInFolder(pedido.file)
    })
  )
  // ---- «Fuera de campaña»: leer la carpeta, abrir y marcar como subido (los vídeos no se tocan)
  ipcMain.handle(CHANNELS.listExtras, () => listExtras(db, carpetaExtras()))
  ipcMain.handle(CHANNELS.setExtraUploaded, (_e, id: unknown, platform: unknown, uploaded: unknown) => {
    setExtraUploaded(db, carpetaExtras(), id, platform, uploaded === true)
    return listExtras(db, carpetaExtras())
  })
  const rutaExtra = (id: unknown): string => {
    const ruta = resolveExtra(carpetaExtras(), id)
    if (!ruta) throw new Error('No se encuentra el vídeo.')
    return ruta
  }
  ipcMain.handle(CHANNELS.openExtra, (_e, id: unknown) =>
    accion(async () => {
      const error = await shell.openPath(rutaExtra(id))
      if (error) throw new Error(error)
    })
  )
  // ---- «Vídeos largos» y «Vídeos de música»: leer la carpeta, abrir y marcar como subido (los vídeos no se tocan)
  ipcMain.handle(CHANNELS.listLongVideos, (_e, kind: unknown) => listLongVideos(db, carpetaDeTipo(kind), asLongKind(kind)))
  ipcMain.handle(CHANNELS.setLongUploaded, (_e, id: unknown, uploaded: unknown, kind: unknown) => {
    setLongUploaded(db, carpetaDeTipo(kind), id, uploaded === true, new Date(), asLongKind(kind))
    return listLongVideos(db, carpetaDeTipo(kind), asLongKind(kind))
  })
  ipcMain.handle(CHANNELS.openLongVideo, (_e, id: unknown, kind: unknown) =>
    accion(async () => {
      const ruta = resolveLongVideo(carpetaDeTipo(kind), id)
      if (!ruta) throw new Error('No se encuentra el vídeo.')
      const error = await shell.openPath(ruta)
      if (error) throw new Error(error)
    })
  )
  ipcMain.handle(CHANNELS.showLongInFolder, (_e, id: unknown, kind: unknown) =>
    accion(async () => {
      const dir = id === null ? carpetaDeTipo(kind) : resolveLongFolder(carpetaDeTipo(kind), id)
      if (!dir) throw new Error('No se encuentra la carpeta del vídeo.')
      fs.mkdirSync(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
    })
  )
  ipcMain.handle(CHANNELS.getWeekendPlan, () => planFinde(db))
  ipcMain.handle(CHANNELS.getVyroPending, () => listVyroPending(db))
  ipcMain.handle(CHANNELS.setVyroSent, (_e, id: unknown, sent: unknown) => {
    setVyroSent(db, id, sent === true)
    return listVyroPending(db)
  })
  ipcMain.handle(CHANNELS.getCalendar, (_e, from: unknown, to: unknown) => calendario(db, from, to))
  ipcMain.handle(CHANNELS.addCalendarTask, (_e, input: unknown) => addCalendarTask(db, input as never))
  ipcMain.handle(CHANNELS.setCalendarTaskDone, (_e, id: unknown, done: unknown) => setCalendarTaskDone(db, id, done === true))
  ipcMain.handle(CHANNELS.deleteCalendarTask, (_e, id: unknown) => deleteCalendarTask(db, id))
  ipcMain.handle(CHANNELS.trashExtras, async (_e, groupId: unknown) => {
    // en la prueba de humo los vídeos están en sus datos temporales: se borran ahí y no llenan la Papelera real
    const aPapelera = (dir: string) => (process.env.CONTENT_OS_SMOKE ? fs.promises.rm(dir, { recursive: true }) : shell.trashItem(dir))
    await trashExtras(db, carpetaExtras(), groupId === null ? null : (groupId as string), aPapelera)
    return listExtras(db, carpetaExtras())
  })
  ipcMain.handle(CHANNELS.trashCampaign, async (_e, campaignId: unknown) => {
    const cfg = loadConfig(dirs.config, bibliotecasPorDefecto)
    if (cfg.error) throw new Error(cfg.error)
    if (sincronizacion) await sincronizacion.catch(() => undefined)
    // la prueba de humo lee la biblioteca REAL: ahí nunca se manda nada a la Papelera
    const aPapelera = async (dir: string) => {
      if (process.env.CONTENT_OS_SMOKE) throw new Error('En la prueba de humo no se borra ninguna campaña.')
      await shell.trashItem(dir)
    }
    await trashCampaign(db, cfg.config.library_roots, campaignId, aPapelera, { linksDir: path.join(app.getPath('desktop'), 'Campañas clips') })
    await sincronizar().catch(() => undefined)
    return estado()
  })
  ipcMain.handle(CHANNELS.showExtraInFolder, (_e, id: unknown) =>
    accion(async () => {
      if (id === null) {
        const dir = carpetaExtras()
        fs.mkdirSync(dir, { recursive: true })
        const error = await shell.openPath(dir)
        if (error) throw new Error(error)
      } else shell.showItemInFolder(rutaExtra(id))
    })
  )
  // ---- material en bruto: la carpeta SOURCE de la campaña, sacada de la base (no de lo que diga la interfaz)
  const carpetaBruto = (campaignId: unknown): string => {
    if (!clipIdValido(campaignId)) throw new Error('Campaña no válida.')
    const fila = db.prepare('SELECT source_path FROM campaigns WHERE campaign_id = ?').get(campaignId) as { source_path: string } | undefined
    if (!fila) throw new Error('La campaña no existe.')
    return path.join(fila.source_path, 'SOURCE')
  }
  ipcMain.handle(CHANNELS.getRawFiles, (_e, campaignId: unknown) => listRawFiles(carpetaBruto(campaignId)))
  ipcMain.handle(CHANNELS.deleteRawFiles, async (_e, campaignId: unknown, mode: unknown) => {
    if (mode !== 'trash' && mode !== 'permanent') throw new Error('Modo no válido.')
    const dir = carpetaBruto(campaignId)
    const c = getCampaign(db, campaignId as string)
    if (!c || c.clips === 0 || c.clipsMissingFile === c.clips) throw new Error('Esta campaña todavía no tiene clips terminados: no se borra el bruto.')
    if (c.state === 'generating') throw new Error('La campaña se está generando ahora mismo.')
    return removeRawFiles(dir, (ruta) => (mode === 'trash' ? shell.trashItem(ruta) : fs.rmSync(ruta)))
  })
}

function crearVentana(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    title: 'CONTENT OS',
    backgroundColor: '#131316',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  win.once('ready-to-show', () => win.show())
  // la ventana no navega a ningún sitio ni abre otras; los enlaces externos van al navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = ventanaPrincipal()
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })
  app.whenReady().then(() => {
    app.setAppUserModelId('local.contentos.app') // para que Windows enseñe las notificaciones con el nombre de la aplicación
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
    db = openDatabase(dbPath, { backupDir: dirs.backups })
    handleMedia(() => db, dirs.avatars, carpetaExtras, path.join(dirs.data, 'ytthumbs'), carpetaLargos, carpetaMusica)
    registrarIpc()
    const win = crearVentana()
    principal = win
    // al cerrar la ventana de la app se cierran también las de Vyro (la de iniciar sesión y la invisible que lee envíos)
    win.on('closed', () => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy() })
    if (!process.env.CONTENT_OS_SMOKE) {
      setTimeout(() => void comprobarVyro(true), 15_000)
      // recordatorio de Vyro: lo programado que ya salió (cada 5 minutos)
      avisarVyro()
      setInterval(() => avisarVyro(), 5 * 60_000)
      // tus envíos en Vyro (si conectaste tu cuenta): al minuto de abrir y cada 30 minutos
      setTimeout(() => void leerEnviosVyro().then(() => avisarVyro()), 60_000)
      setInterval(() => void leerEnviosVyro().then(() => avisarVyro()), 30 * 60_000)
      // cifras de TikTok: al poco de abrir y cada 30 minutos
      const medirTikTok = () =>
        void refreshSocial(db, pedirSocial)
          .catch(() => undefined)
          .then(() => refreshTikTokStats(db, pedirTexto))
          .then((r) => r.measured > 0 && !win.isDestroyed() && win.webContents.send(CHANNELS.stateChanged, estado()))
          .catch(() => undefined)
      setTimeout(medirTikTok, 25_000)
      setInterval(medirTikTok, 30 * 60_000)
      // mientras haya un pedido esperando material, se mira Descargas cada 5 s (solo lectura)
      setInterval(() => {
        try {
          if (hasWaitingOrders(db) && attachMaterial(db, app.getPath('downloads')) && !win.isDestroyed()) win.webContents.send(CHANNELS.stateChanged, estado())
        } catch {
          /* se reintenta en la siguiente vuelta */
        }
      }, 5_000)
      setInterval(() => void comprobarVyro(true), 30 * 60_000)
      vigilarBibliotecas()
      // limpieza de campañas terminadas: al poco de abrir y cada hora
      setTimeout(() => void limpiarCampanas().catch(() => undefined), 90_000)
      setInterval(() => void limpiarCampanas().catch(() => undefined), 60 * 60_000)
      setInterval(() => {
        vigilarBibliotecas() // reengancha carpetas que no estaban disponibles
        sincronizarSola()
      }, 10 * 60_000)
    }
    if (process.env.CONTENT_OS_SMOKE) void runSmokeTest(win, db, process.env.CONTENT_OS_SMOKE, () => sincronizacion !== null)
  })
  app.on('window-all-closed', () => {
    vigilante.close()
    try {
      db?.close()
    } catch {
      /* ya cerrada */
    }
    app.quit()
  })
}
