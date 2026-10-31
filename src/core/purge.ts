/**
 * Limpieza de campañas terminadas: una semana después de acabar, su carpeta (clips, material en bruto,
 * informes) va a la Papelera de Windows. Lo que CONTENT OS sabe de ella (publicaciones, cifras, pagos)
 * se queda en la base de datos. Una campaña sin fecha de fin y sin cerrar no se toca nunca.
 *
 * Acaba el día siguiente a su último día de plazo, o el día en que la cerraste a mano (lo que llegue antes).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { today } from './queries'

export const PURGE_AFTER_DAYS = 7

const masDias = (dia: string, n: number) => {
  const d = new Date(dia + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** Día local (AAAA-MM-DD) de una fecha ISO. */
const diaLocal = (iso: string) => today(new Date(iso))

/** Día en que la campaña irá a la Papelera, o null si nunca (sin fecha de fin y sin cerrar). */
export function purgeOn(endsAt: string | null, closedAt: string | null): string | null {
  const fines = [endsAt ? masDias(endsAt, 1) : null, closedAt ? diaLocal(closedAt) : null].filter((d): d is string => !!d)
  if (!fines.length) return null
  return masDias(fines.sort()[0], PURGE_AFTER_DAYS)
}

const clave = (campaignId: string) => `purged:${campaignId}`
export function purgedAt(db: DB, campaignId: string): string | null {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(clave(campaignId)) as { value: string } | undefined)?.value ?? null
}

export interface PurgeCandidate {
  campaignId: string
  name: string
  folder: string
  purgeOn: string
}

/**
 * Campañas a las que ya les toca, con su carpeta comprobada: tiene que estar justo dentro de una de las
 * bibliotecas y llevar su campaign.json. Nunca una que se esté generando.
 */
export function purgeCandidates(db: DB, roots: string[], now = new Date()): PurgeCandidate[] {
  const hoy = today(now)
  const bibliotecas = roots.map((r) => path.resolve(r).toLowerCase())
  const filas = db.prepare(
    "SELECT campaign_id, COALESCE(display_name, folder_name) AS name, source_path, ends_at, closed_at, state FROM campaigns WHERE present_in_source = 1"
  ).all() as { campaign_id: string; name: string; source_path: string; ends_at: string | null; closed_at: string | null; state: string }[]
  const out: PurgeCandidate[] = []
  for (const c of filas) {
    const dia = purgeOn(c.ends_at, c.closed_at)
    if (!dia || dia > hoy || c.state === 'generating' || purgedAt(db, c.campaign_id)) continue
    const carpeta = path.resolve(c.source_path)
    if (!bibliotecas.includes(path.dirname(carpeta).toLowerCase())) continue
    if (!fs.existsSync(path.join(carpeta, 'campaign.json'))) continue
    out.push({ campaignId: c.campaign_id, name: c.name, folder: carpeta, purgeOn: dia })
  }
  return out
}

export interface PurgeResult {
  trashed: { campaignId: string; name: string }[]
  errors: { campaignId: string; name: string; error: string }[]
}

/**
 * Manda a la Papelera las campañas a las que les toca (con `trash`, que en la aplicación es la Papelera de
 * Windows) y quita los accesos directos que apuntaban a ellas (los enlaces, no lo que había dentro).
 */
export async function purgeEndedCampaigns(
  db: DB, roots: string[], trash: (folder: string) => Promise<void>, opts: { now?: Date; linksDir?: string | null } = {}
): Promise<PurgeResult> {
  const r: PurgeResult = { trashed: [], errors: [] }
  for (const c of purgeCandidates(db, roots, opts.now)) {
    try {
      quitarAccesos(opts.linksDir ?? null, c.folder)
      await trash(c.folder)
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(clave(c.campaignId), (opts.now ?? new Date()).toISOString())
      r.trashed.push({ campaignId: c.campaignId, name: c.name })
    } catch (e) {
      r.errors.push({ campaignId: c.campaignId, name: c.name, error: (e as Error).message })
    }
  }
  return r
}

/** Quita los enlaces (accesos del escritorio "Campañas clips\<campaña>") que apuntan dentro de la carpeta. */
function quitarAccesos(dir: string | null, carpeta: string): void {
  if (!dir || !fs.existsSync(dir)) return
  // se comparan rutas reales: así da igual cómo esté escrita la ruta del enlace (\\?\, nombres cortos…)
  const real = fs.realpathSync.native(carpeta).toLowerCase()
  for (const e of fs.readdirSync(dir)) {
    const enlace = path.join(dir, e)
    try {
      if (!fs.lstatSync(enlace).isSymbolicLink()) continue
      const destino = fs.realpathSync.native(enlace).toLowerCase()
      // unlink quita solo el enlace (en Electron, rmSync se niega con los enlaces a carpetas)
      if (destino === real || destino.startsWith(real + path.sep)) fs.unlinkSync(enlace)
    } catch {
      /* un enlace que no se puede leer se deja como está */
    }
  }
}

/** Se borró del todo (no está en la Papelera): lo dice la ficha de la campaña. */
const claveBorrada = (campaignId: string) => `purged_permanent:${campaignId}`
export function purgedPermanently(db: DB, campaignId: string): boolean {
  return !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(claveBorrada(campaignId))
}

/** Lo que ocupa una carpeta (sin seguir enlaces). */
export function folderBytes(dir: string): number {
  let n = 0
  let entradas: fs.Dirent[] = []
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entradas) {
    const ruta = path.join(dir, e.name)
    if (e.isDirectory()) n += folderBytes(ruta)
    else if (e.isFile()) {
      try {
        n += fs.statSync(ruta).size
      } catch {
        /* archivo que desaparece mientras se cuenta */
      }
    }
  }
  return n
}

/**
 * El usuario quita YA la carpeta de una campaña (clips, material en bruto, informes), sin esperar a la
 * semana: a la Papelera, o borrada del todo para liberar el espacio (`permanent`; `trash` hace el borrado).
 * Mismas comprobaciones que la limpieza automática. La campaña queda cerrada y sus publicaciones y cifras
 * se quedan en CONTENT OS. Vale aunque estuviera apuntada como enviada: manda la carpeta, si sigue ahí.
 */
export async function trashCampaign(
  db: DB, roots: string[], campaignId: unknown, trash: (folder: string) => Promise<void>, opts: { now?: Date; linksDir?: string | null; permanent?: boolean } = {}
): Promise<void> {
  if (typeof campaignId !== 'string') throw new Error('Campaña no válida.')
  const c = db.prepare('SELECT campaign_id, source_path, state, present_in_source FROM campaigns WHERE campaign_id = ?').get(campaignId) as
    { campaign_id: string; source_path: string; state: string; present_in_source: number } | undefined
  if (!c) throw new Error('La campaña no existe.')
  if (c.state === 'generating') throw new Error('La campaña se está generando: espera a que termine.')
  const carpeta = path.resolve(c.source_path)
  const bibliotecas = roots.map((r) => path.resolve(r).toLowerCase())
  if (!c.present_in_source || !bibliotecas.includes(path.dirname(carpeta).toLowerCase()) || !fs.existsSync(path.join(carpeta, 'campaign.json'))) {
    throw new Error('No encuentro la carpeta de esta campaña en la biblioteca.')
  }
  const t = (opts.now ?? new Date()).toISOString()
  quitarAccesos(opts.linksDir ?? null, carpeta)
  await trash(carpeta)
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(clave(campaignId), t)
  if (opts.permanent) db.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(claveBorrada(campaignId))
  else db.prepare('DELETE FROM settings WHERE key = ?').run(claveBorrada(campaignId))
  db.prepare('UPDATE campaigns SET closed = 1, closed_at = COALESCE(closed_at, ?) WHERE campaign_id = ?').run(t, campaignId)
}
