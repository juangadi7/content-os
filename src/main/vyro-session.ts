/**
 * Sesión de Vyro del usuario, para leer sus envíos («My submissions»).
 *
 * - Conectar: una ventana con la web de Vyro donde el usuario inicia sesión él mismo. La aplicación nunca ve ni
 *   guarda la contraseña: la sesión se queda en su propio espacio de navegador (partición persist:vyro), como en Chrome.
 * - Leer: una ventana invisible abre la página de envíos de cada campaña y la aplicación lee las respuestas que la
 *   propia web de Vyro recibe (solo las de la lista de envíos). No se manejan tokens ni se envía nada a Vyro.
 * - Desconectar: borra ese espacio de navegador.
 */
import { BrowserWindow, session } from 'electron'

export const VYRO_PARTITION = 'persist:vyro'
const APP = 'https://app.vyro.com'
const LISTA = /^https:\/\/api\.vyro\.com\/clips\/me(\?|$)/

export class VyroNotLoggedIn extends Error {
  constructor() {
    super('La sesión de Vyro no está iniciada o ha caducado. Pulsa «Conectar Vyro».')
  }
}

const enLogin = (url: string) => /\/(oauth|login|sign-?in|auth)\b/i.test(new URL(url).pathname)

/** Abre la web de Vyro para que el usuario inicie sesión. Se resuelve al cerrar la ventana. */
export function openVyroLogin(parent: BrowserWindow | null): Promise<void> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1100, height: 820, parent: parent ?? undefined, title: 'Conectar Vyro — inicia sesión y cierra la ventana',
      autoHideMenuBar: true,
      webPreferences: { partition: VYRO_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    // los enlaces que abran ventanas nuevas (p. ej. «Continuar con Google») se quedan en esta misma sesión
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: VYRO_PARTITION, sandbox: true } } }))
    win.on('closed', () => resolve())
    void win.loadURL(APP + '/')
  })
}

/** Borra la sesión de Vyro guardada en la aplicación. */
export async function clearVyroSession(): Promise<void> {
  await session.fromPartition(VYRO_PARTITION).clearStorageData()
}

/** ¿Hay sesión guardada? (cookies de Vyro en la partición). No comprueba si ha caducado. */
export async function hasVyroSession(): Promise<boolean> {
  const cookies = await session.fromPartition(VYRO_PARTITION).cookies.get({ domain: 'vyro.com' })
  return cookies.length > 0
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Nada de lo que hace la ventana invisible puede quedarse esperando para siempre. */
const TOPE_TOTAL_MS = 6 * 60_000
function conLimite<T>(p: Promise<T>, ms: number, que: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Vyro no respondió a tiempo (${que}).`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/**
 * Lee los envíos de cada campaña de Vyro (ids de Vyro). Devuelve, por campaña, los cuerpos JSON de la lista de
 * envíos tal como los recibió la web. Lanza VyroNotLoggedIn si Vyro pide iniciar sesión.
 */
export interface VyroCampaignRead {
  bodies: string[]
  /** Cuándo se abrió la página de envíos de esa campaña (lo que se vio es de ese momento). */
  at: string
}

export async function readVyroSubmissions(campaignIds: string[], opts: { timeoutMs?: number } = {}): Promise<Map<string, VyroCampaignRead>> {
  const out = new Map<string, VyroCampaignRead>()
  if (!campaignIds.length) return out
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { partition: VYRO_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  const wc = win.webContents
  const cuerpos: { url: string; body: string }[] = []
  const pendientes = new Map<string, string>()
  try {
    wc.debugger.attach('1.3')
    wc.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.responseReceived' && LISTA.test(params.response?.url ?? '')) pendientes.set(params.requestId, params.response.url)
      if (method === 'Network.loadingFinished' && pendientes.has(params.requestId)) {
        const url = pendientes.get(params.requestId)!
        pendientes.delete(params.requestId)
        void wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
          .then((r: { body: string; base64Encoded: boolean }) => cuerpos.push({ url, body: r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body }))
          .catch(() => undefined)
      }
    })
    // con la ventana aún sin página, Network.enable no responde nunca: primero una página en blanco
    await win.loadURL('about:blank')
    await conLimite(wc.debugger.sendCommand('Network.enable'), 10_000, 'Network.enable')
    const limite = opts.timeoutMs ?? 25_000
    const inicio = Date.now()
    for (const id of campaignIds) {
      const antes = cuerpos.length
      // si se pasa del tope, se devuelve lo leído hasta aquí (lo demás, en la próxima lectura)
      if (Date.now() - inicio > TOPE_TOTAL_MS) break
      const at = new Date().toISOString()
      await conLimite(win.loadURL(`${APP}/campaigns/add-clips?my-submissions=${encodeURIComponent(id)}`), 30_000, 'cargar la página').catch(() => undefined)
      const t0 = Date.now()
      const deEsta = () => cuerpos.slice(antes).filter((c) => decodeURIComponent(c.url).includes(id))
      while (Date.now() - t0 < limite) {
        if (enLogin(wc.getURL())) throw new VyroNotLoggedIn()
        if (deEsta().length) break
        await esperar(400)
      }
      // más de una página de envíos: la lista carga más al bajar
      for (let i = 0; i < 10; i++) {
        const ultima = deEsta().at(-1)
        let siguiente = false
        try {
          siguiente = ultima ? JSON.parse(ultima.body)?.meta?.page?.next != null : false
        } catch {
          siguiente = false
        }
        if (!siguiente) break
        const n = deEsta().length
        await conLimite(wc.executeJavaScript(`document.querySelectorAll('*').forEach((e) => { if (e.scrollHeight > e.clientHeight + 10) e.scrollTop = e.scrollHeight }); window.scrollTo(0, document.body.scrollHeight)`), 5000, 'bajar').catch(() => undefined)
        const t1 = Date.now()
        while (deEsta().length === n && Date.now() - t1 < 8000) await esperar(400)
        if (deEsta().length === n) break
      }
      out.set(id, { bodies: deEsta().map((c) => c.body), at })
    }
    return out
  } finally {
    try {
      wc.debugger.detach()
    } catch {
      /* ya estaba suelto */
    }
    win.destroy()
  }
}
