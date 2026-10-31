/**
 * Pedidos «hacer esta campaña»: el usuario los crea desde la pantalla de Vyro.
 * Un pedido es una carpeta (fuera de CAMPAIGNS) con un pedido.json que reúne todo lo que hace falta
 * para preparar la campaña: reglas leídas de Vyro, notas del usuario y dónde está el material descargado.
 * CONTENT OS no descarga ni genera nada: apunta lo que el usuario descarga y deja el encargo listo.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'

export const ORDER_FILE = 'pedido.json'
const EXTENSIONES: Record<string, 'video' | 'zip'> = { '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video', '.m4v': 'video', '.zip': 'zip' }

export interface OrderFile {
  path: string
  name: string
  size: number
  kind: 'video' | 'zip'
  /** false si el archivo ya no está donde se apuntó. */
  exists: boolean
}

export interface OrderView {
  vyroId: string
  createdAt: string
  folder: string
  /** Ruta del pedido.json. */
  file: string
  notes: string | null
  /** waiting = esperando material; ready = material completo. */
  status: 'waiting' | 'ready'
  files: OrderFile[]
  totalBytes: number
  /** Frase lista para pegar en Claude. */
  prompt: string
}

type Row = Record<string, any>

const rutas = (json: string | null): string[] => {
  try {
    const v = JSON.parse(json ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function archivo(ruta: string): OrderFile {
  const kind = EXTENSIONES[path.extname(ruta).toLowerCase()] ?? 'video'
  try {
    const st = fs.statSync(ruta)
    return { path: ruta, name: path.basename(ruta), size: st.size, kind, exists: st.isFile() }
  } catch {
    return { path: ruta, name: path.basename(ruta), size: 0, kind, exists: false }
  }
}

function vista(o: Row): OrderView {
  const files = rutas(o.files).map(archivo)
  const file = path.join(o.folder, ORDER_FILE)
  return {
    vyroId: o.vyro_id, createdAt: o.created_at, folder: o.folder, file, notes: o.notes, status: o.status === 'ready' ? 'ready' : 'waiting', files,
    totalBytes: files.reduce((s, f) => s + f.size, 0), prompt: `Haz la campaña del pedido "${file}"`
  }
}

export function getOrder(db: DB, vyroId: string): OrderView | null {
  const o = db.prepare('SELECT * FROM vyro_orders WHERE vyro_id = ?').get(vyroId) as Row | undefined
  return o ? vista(o) : null
}

export function listOrders(db: DB): OrderView[] {
  return (db.prepare('SELECT * FROM vyro_orders ORDER BY created_at').all() as Row[]).map(vista)
}

const lista = (json: string | null): string[] => rutas(json)

/** Escribe (de forma atómica) el pedido.json con lo que se sabe ahora mismo. */
function escribir(db: DB, vyroId: string): void {
  const o = db.prepare('SELECT * FROM vyro_orders WHERE vyro_id = ?').get(vyroId) as Row | undefined
  const v = db.prepare('SELECT * FROM vyro_campaigns WHERE vyro_id = ?').get(vyroId) as Row | undefined
  if (!o || !v) return
  const pedido = vista(o)
  const contenido = {
    pedido_version: 1,
    creado: o.created_at,
    estado: pedido.status === 'ready' ? 'material_completo' : 'esperando_material',
    para_claude: 'Prepara esta campaña con mundial-clipper siguiendo CLAUDE.md (sección «Pedidos de CONTENT OS»). Las reglas de Vyro mandan; lo que no esté aquí, pregúntalo.',
    vyro: {
      url: `https://vyro.com/campaigns/${v.slug}`, id: v.vyro_id, slug: v.slug, marca: v.brand, nombre: v.name,
      pago_por_1000_visitas_usd: v.pay_rate, presupuesto_libre_usd: v.budget_remaining, empieza: v.starts_at, termina: v.ends_at,
      visitas_minimas_por_clip: v.min_views, duracion_minima_s: v.min_length, plataformas: lista(v.platforms), idiomas: lista(v.languages),
      hashtags_obligatorios: lista(v.hashtags), hashtags_publicidad: lista(v.disclosure), material_enlaces: lista(v.material_links),
      leido_de_vyro: v.last_seen_at
    },
    reglas_extra_del_usuario: o.notes ?? '',
    material: pedido.files.filter((f) => f.exists).map((f) => ({ ruta: f.path, bytes: f.size, tipo: f.kind }))
  }
  fs.mkdirSync(o.folder, { recursive: true })
  const tmp = path.join(o.folder, ORDER_FILE + '.tmp')
  fs.writeFileSync(tmp, JSON.stringify(contenido, null, 2))
  fs.renameSync(tmp, path.join(o.folder, ORDER_FILE))
}

const notas = (v: unknown): string | null => {
  if (v == null) return null
  if (typeof v !== 'string') throw new Error('Texto no válido.')
  if (v.length > 20000) throw new Error('Texto demasiado largo.')
  return v.trim() || null
}

/** Crea el pedido de una campaña de Vyro en `<ordersRoot>\<slug>\pedido.json`. */
export function createOrder(db: DB, input: { vyroId: string; notes?: string | null }, ordersRoot: string, now: () => string = () => new Date().toISOString()): OrderView {
  const v = db.prepare('SELECT * FROM vyro_campaigns WHERE vyro_id = ?').get(input?.vyroId) as Row | undefined
  if (!v) throw new Error('Esa campaña de Vyro no existe.')
  if (v.campaign_id) throw new Error('Esa campaña ya la tienes hecha.')
  if (db.prepare('SELECT 1 FROM vyro_orders WHERE vyro_id = ?').get(v.vyro_id)) throw new Error('Ya hay un pedido para esa campaña.')
  const carpeta = String(v.slug).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || v.vyro_id
  db.prepare("INSERT INTO vyro_orders (vyro_id, created_at, folder, notes, status, files) VALUES (?, ?, ?, ?, 'waiting', '[]')")
    .run(v.vyro_id, now(), path.join(ordersRoot, carpeta), notas(input.notes))
  escribir(db, v.vyro_id)
  return getOrder(db, v.vyro_id)!
}

/** Cambia notas o estado, o quita un archivo de la lista (el archivo en sí no se toca). */
export function updateOrder(db: DB, vyroId: string, cambio: { notes?: string | null; status?: 'waiting' | 'ready'; removeFile?: string }): OrderView {
  const o = db.prepare('SELECT * FROM vyro_orders WHERE vyro_id = ?').get(vyroId) as Row | undefined
  if (!o) throw new Error('El pedido no existe.')
  if (cambio.notes !== undefined) db.prepare('UPDATE vyro_orders SET notes = ? WHERE vyro_id = ?').run(notas(cambio.notes), vyroId)
  if (cambio.status !== undefined) {
    if (cambio.status !== 'waiting' && cambio.status !== 'ready') throw new Error('Estado no válido.')
    db.prepare('UPDATE vyro_orders SET status = ? WHERE vyro_id = ?').run(cambio.status, vyroId)
  }
  if (cambio.removeFile !== undefined) {
    const quedan = rutas(o.files).filter((r) => r !== cambio.removeFile)
    // se recuerda como descartado para no volver a apuntarlo solo
    const descartados = [...new Set([...rutas(o.ignored ?? '[]'), cambio.removeFile])]
    db.prepare('UPDATE vyro_orders SET files = ?, ignored = ? WHERE vyro_id = ?').run(JSON.stringify(quedan), JSON.stringify(descartados), vyroId)
  }
  escribir(db, vyroId)
  return getOrder(db, vyroId)!
}

/** Anula el pedido: borra su pedido.json (lo único que CONTENT OS creó). El material descargado no se toca. */
export function cancelOrder(db: DB, vyroId: string): void {
  const o = db.prepare('SELECT * FROM vyro_orders WHERE vyro_id = ?').get(vyroId) as Row | undefined
  if (!o) return
  db.prepare('DELETE FROM vyro_orders WHERE vyro_id = ?').run(vyroId)
  fs.rmSync(path.join(o.folder, ORDER_FILE), { force: true })
  try {
    fs.rmdirSync(o.folder) // solo si quedó vacía
  } catch {
    /* tiene algo más dentro: se deja */
  }
}

/**
 * Mira la carpeta de descargas y apunta en el pedido que está esperando material los vídeos (o .zip)
 * terminados de descargar desde que se creó. Con varios pedidos esperando, van al más reciente.
 * Solo lee la carpeta. Devuelve true si apuntó algo.
 */
export function attachMaterial(db: DB, downloadsDir: string): boolean {
  const esperando = db.prepare("SELECT * FROM vyro_orders WHERE status = 'waiting' ORDER BY created_at DESC").all() as Row[]
  if (!esperando.length) return false
  const pedido = esperando[0]
  const desde = Date.parse(pedido.created_at)
  const yaApuntados = new Set((db.prepare('SELECT files, ignored FROM vyro_orders').all() as Row[]).flatMap((o) => [...rutas(o.files), ...rutas(o.ignored ?? '[]')]).map((r) => r.toLowerCase()))
  let nombres: string[] = []
  try {
    nombres = fs.readdirSync(downloadsDir)
  } catch {
    return false
  }
  const nuevos: string[] = []
  for (const n of nombres.sort()) {
    if (!EXTENSIONES[path.extname(n).toLowerCase()]) continue // .crdownload, .part… = descarga a medias
    const ruta = path.join(downloadsDir, n)
    if (yaApuntados.has(ruta.toLowerCase())) continue
    try {
      const st = fs.statSync(ruta)
      // el navegador puede poner como fecha de modificación la del servidor: vale la de creación (cuando empezó la descarga)
      if (st.isFile() && st.size > 0 && Math.max(st.birthtimeMs, st.mtimeMs) >= desde) nuevos.push(ruta)
    } catch {
      /* desapareció entre medias */
    }
  }
  if (!nuevos.length) return false
  db.prepare('UPDATE vyro_orders SET files = ? WHERE vyro_id = ?').run(JSON.stringify([...rutas(pedido.files), ...nuevos]), pedido.vyro_id)
  escribir(db, pedido.vyro_id)
  return true
}

/** Los pedidos cuya campaña ya existe en local se dan por cumplidos y se retiran (su pedido.json se conserva). */
export function closeFulfilledOrders(db: DB): number {
  return db.prepare('DELETE FROM vyro_orders WHERE vyro_id IN (SELECT vyro_id FROM vyro_campaigns WHERE campaign_id IS NOT NULL)').run().changes
}

export function hasWaitingOrders(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM vyro_orders WHERE status = 'waiting' LIMIT 1").get()
}
