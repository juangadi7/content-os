/**
 * Campañas de Vyro. Se lee la lista PÚBLICA (https://vyro.com/campaigns), sin cuenta ni contraseña,
 * para saber cuándo sale una campaña nueva, cuándo acaba y cuándo se bloquea.
 * Solo lectura: CONTENT OS nunca se une a campañas ni envía nada a Vyro.
 */
import { setCampaignStatus } from './campaigns'
import type { DB } from './db'
import { closeFulfilledOrders, getOrder, type OrderView } from './orders'
import { today } from './queries'
import { normalizeText } from './youtube-channels'

export const VYRO_URL = 'https://vyro.com/campaigns'
export const vyroCampaignUrl = (slug: string) => `${VYRO_URL}/${encodeURIComponent(slug)}`

export type TextFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export class VyroError extends Error {
  constructor(readonly code: 'network' | 'format', message: string) {
    super(message)
  }
}

/** Una campaña tal como la publica Vyro. */
export interface VyroCampaign {
  vyroId: string
  slug: string
  brand: string
  name: string
  /** Dólares por cada 1.000 visitas. */
  payRate: number | null
  budgetTotal: number | null
  budgetRemaining: number | null
  minViews: number | null
  minLength: number | null
  platforms: string[]
  languages: string[]
  hashtags: string[]
  /** Hashtags de aviso de publicidad (#ad…). */
  disclosure: string[]
  materialLinks: string[]
  status: string | null
  locked: boolean
  startsAt: string | null
  endsAt: string | null
  createdAt: string | null
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Extrae el objeto JSON que empieza en `desde` (una llave), respetando cadenas. null si no cierra. */
function objetoEn(s: string, desde: number): string | null {
  let nivel = 0
  let enCadena = false
  for (let i = desde; i < s.length && i < desde + 200_000; i++) {
    const c = s[i]
    if (enCadena) {
      if (c === '\\') i++
      else if (c === '"') enCadena = false
    } else if (c === '"') enCadena = true
    else if (c === '{') nivel++
    else if (c === '}' && --nivel === 0) return s.slice(desde, i + 1)
  }
  return null
}

function campaña(o: any): VyroCampaign | null {
  const vyroId = texto(o?.id)
  const slug = texto(o?.slug)
  const name = texto(o?.name)
  if (!vyroId || !slug || !name || typeof o.workspace !== 'object' || typeof o.payoutModel !== 'object') return null
  const req = o.requirements ?? {}
  return {
    vyroId, slug, name, brand: texto(o.workspace?.name) ?? '',
    payRate: numero(o.payoutModel?.payRate) ?? numero(o.headlineRate),
    budgetTotal: numero(o.budget?.value), budgetRemaining: numero(o.budget?.remaining),
    minViews: numero(req.minViewsPerClip), minLength: numero(req.video?.minLength),
    platforms: lista(o.targeting?.platforms), languages: lista(o.targeting?.languages),
    hashtags: lista(req.text?.hashtags), disclosure: lista(req.text?.ftcDisclosureHashtags),
    materialLinks: (Array.isArray(o.media?.links) ? o.media.links : []).map((l: any) => texto(l?.url)).filter((u: string | null): u is string => !!u && /^https:\/\//i.test(u)),
    status: texto(o.status?.id), locked: o.isLocked === true,
    startsAt: texto(o.startDate), endsAt: texto(o.endDate), createdAt: texto(o.createdAt)
  }
}

/**
 * Saca las campañas de la página pública. La página lleva sus datos incrustados en trozos
 * `self.__next_f.push([1,"…"])`; se juntan y se buscan los objetos con forma de campaña.
 * Si no se reconoce ninguna, es que Vyro cambió la página: error, nunca una lista vacía.
 */
export function parseVyroCampaigns(html: string): VyroCampaign[] {
  let datos = ''
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      datos += JSON.parse(m[1])
    } catch {
      /* trozo ilegible: se ignora */
    }
  }
  const vistas = new Map<string, VyroCampaign>()
  let hasta = 0
  for (const m of datos.matchAll(/\{"id":"/g)) {
    if (m.index! < hasta) continue // dentro de una campaña ya leída
    const crudo = objetoEn(datos, m.index!)
    if (!crudo || !crudo.includes('"slug"')) continue
    try {
      const c = campaña(JSON.parse(crudo))
      if (c) {
        vistas.set(c.vyroId, c)
        hasta = m.index! + crudo.length
      }
    } catch {
      /* no era JSON completo */
    }
  }
  if (vistas.size === 0) throw new VyroError('format', 'No reconozco la página de campañas de Vyro: puede que hayan cambiado su web.')
  return [...vistas.values()]
}

export async function fetchVyroCampaigns(pedir: TextFetch): Promise<VyroCampaign[]> {
  let r: Awaited<ReturnType<TextFetch>>
  try {
    r = await pedir(VYRO_URL, { headers: { 'User-Agent': 'ContentOS/0.1 (personal campaign list reader)', Accept: 'text/html' } })
  } catch (e) {
    throw new VyroError('network', `No se pudo conectar con Vyro (${(e as Error).message}).`)
  }
  if (!r.ok) throw new VyroError('network', `Vyro respondió con un error (${r.status}).`)
  return parseVyroCampaigns(await r.text())
}

// ---------------------------------------------------------------- base de datos

export interface VyroCampaignView extends VyroCampaign {
  url: string
  /** Sigue en la lista de Vyro. */
  present: boolean
  /** Aún no la has visto en la pantalla de Vyro. */
  isNew: boolean
  firstSeenAt: string
  /** Días que quedan contando hoy; null si no hay fecha o ya pasó. */
  daysLeft: number | null
  /** Abierta = en la lista, activa, sin bloquear y dentro de plazo. */
  open: boolean
  /** Tu campaña local enlazada, si la hay. */
  campaignId: string | null
  campaignName: string | null
  linkState: 'auto' | 'manual' | 'rejected' | 'none'
  /** Pedido «hacer esta campaña» en curso, si lo hay. */
  order: OrderView | null
}

export interface VyroView {
  campaigns: VyroCampaignView[]
  lastCheckAt: string | null
  lastError: string | null
  newCount: number
  /** Campañas locales, para enlazar a mano. */
  localOptions: { campaignId: string; name: string }[]
}

export interface VyroSyncResult {
  /** Campañas que no se habían visto nunca (vacío en la primera lectura: todo sería nuevo). */
  fresh: VyroCampaign[]
  /** Campañas locales cerradas porque Vyro las bloqueó o terminó. */
  closedLocal: string[]
  /** Campañas locales a las que se les puso la fecha de fin de Vyro. */
  datedLocal: string[]
  /** Campañas locales que la app cerró por Vyro y se reabren porque Vyro las ha vuelto a activar. */
  reopenedLocal?: string[]
}

type Row = Record<string, any>

const fichas = (t: string): Set<string> => new Set(normalizeText(t).split(' ').filter(Boolean))

/**
 * ¿A qué campaña local corresponde? Compara palabras de «marca + nombre» con el nombre local.
 * Solo si hay una candidata clara (≥ 80 % de las palabras de la más corta, y bien por delante de la segunda).
 */
export function matchLocalCampaign(v: Pick<VyroCampaign, 'brand' | 'name'>, locales: { campaignId: string; name: string }[]): string | null {
  const a = fichas(`${v.brand} ${v.name}`)
  const notas = locales.map((l) => {
    const b = fichas(l.name)
    const comunes = [...b].filter((p) => a.has(p)).length
    const menor = Math.min(a.size, b.size)
    return { id: l.campaignId, nota: menor && comunes >= 3 ? comunes / menor : 0, exacta: comunes === a.size && comunes === b.size }
  }).sort((x, y) => y.nota - x.nota)
  if (!notas.length || notas[0].nota < 0.8) return null
  if (notas[1] && notas[0].nota - notas[1].nota < 0.15) {
    // empate: solo se enlaza si una de las empatadas tiene exactamente las mismas palabras
    const exactas = notas.filter((n) => n.exacta && notas[0].nota - n.nota < 0.15)
    return exactas.length === 1 ? exactas[0].id : null
  }
  return notas[0].id
}

const ajuste = (db: DB, clave: string): string | null => (db.prepare('SELECT value FROM settings WHERE key = ?').get(clave) as Row | undefined)?.value ?? null
const ponerAjuste = (db: DB, clave: string, valor: string | null) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(clave, valor)

const terminada = (c: { locked: boolean; status: string | null }) => c.locked || (c.status != null && c.status !== 'active')

/** Aplica a la campaña local lo que dice Vyro: fecha de fin (si no tiene) y cierre (solo si `cerrar`). */
function aplicarALocal(db: DB, campaignId: string, c: VyroCampaign, cerrar: boolean, at: string, r: VyroSyncResult): void {
  const local = db.prepare('SELECT ends_at, closed, pay_rate, min_views FROM campaigns WHERE campaign_id = ?').get(campaignId) as Row | undefined
  if (!local) return
  // condiciones de pago: solo lo que falte (lo corregido a mano no se pisa)
  if (local.pay_rate == null && c.payRate != null) db.prepare('UPDATE campaigns SET pay_rate = ? WHERE campaign_id = ?').run(c.payRate, campaignId)
  if (local.min_views == null && c.minViews != null) db.prepare('UPDATE campaigns SET min_views = ? WHERE campaign_id = ?').run(c.minViews, campaignId)
  if (!local.ends_at && c.endsAt && !Number.isNaN(Date.parse(c.endsAt))) {
    setCampaignStatus(db, { campaignId, endsAt: today(new Date(c.endsAt)) })
    r.datedLocal.push(campaignId)
  }
  if (cerrar && terminada(c) && local.closed !== 1) {
    setCampaignStatus(db, { campaignId, closed: true }, () => at)
    ponerAjuste(db, CERRADA_POR_VYRO + campaignId, at)
    r.closedLocal.push(campaignId)
  }
}

/** Marca de las campañas que cerró la app porque Vyro las pausó o bloqueó (no las cerradas a mano). */
export const CERRADA_POR_VYRO = 'vyro_cerro:'

/**
 * Vyro vuelve a activar una campaña que tuvo pausada o bloqueada (p. ej. Kevin Langue, 19-oct: pausada un tiempo
 * y activa otra vez a las 08:44): si la cerró la app por eso, se reabre. Las cerradas a mano no se tocan.
 */
function reabrirSiVuelve(db: DB, campaignId: string, at: string, r: VyroSyncResult): void {
  const marca = ajuste(db, CERRADA_POR_VYRO + campaignId)
  const local = db.prepare('SELECT closed, ends_at FROM campaigns WHERE campaign_id = ?').get(campaignId) as Row | undefined
  if (!marca || !local) return
  db.prepare('DELETE FROM settings WHERE key = ?').run(CERRADA_POR_VYRO + campaignId)
  if (local.closed === 1 && !(local.ends_at && local.ends_at < at.slice(0, 10))) {
    setCampaignStatus(db, { campaignId, closed: false }, () => at)
    ;(r.reopenedLocal ??= []).push(campaignId)
  }
}

/** Guarda lo leído de Vyro, enlaza con las campañas locales y devuelve las novedades. */
export function syncVyro(db: DB, campañas: VyroCampaign[], now: () => string = () => new Date().toISOString()): VyroSyncResult {
  const at = now()
  const r: VyroSyncResult = { fresh: [], closedLocal: [], datedLocal: [] }
  db.transaction(() => {
    const primera = (db.prepare('SELECT COUNT(*) AS n FROM vyro_campaigns').get() as Row).n === 0
    const locales = (db.prepare('SELECT campaign_id, COALESCE(display_name, folder_name) AS name FROM campaigns').all() as Row[]).map((l) => ({ campaignId: l.campaign_id as string, name: l.name as string }))
    db.prepare('UPDATE vyro_campaigns SET present = 0').run()
    for (const c of campañas) {
      const antes = db.prepare('SELECT * FROM vyro_campaigns WHERE vyro_id = ?').get(c.vyroId) as Row | undefined
      const datos = {
        vyro_id: c.vyroId, slug: c.slug, brand: c.brand, name: c.name, pay_rate: c.payRate, budget_total: c.budgetTotal, budget_remaining: c.budgetRemaining,
        min_views: c.minViews, min_length: c.minLength, platforms: JSON.stringify(c.platforms), languages: JSON.stringify(c.languages),
        hashtags: JSON.stringify(c.hashtags), disclosure: JSON.stringify(c.disclosure), material_links: JSON.stringify(c.materialLinks),
        status: c.status, locked: c.locked ? 1 : 0, starts_at: c.startsAt, ends_at: c.endsAt, created_at_vyro: c.createdAt, at
      }
      if (antes) {
        db.prepare(
          `UPDATE vyro_campaigns SET slug = @slug, brand = @brand, name = @name, pay_rate = @pay_rate, budget_total = @budget_total, budget_remaining = @budget_remaining,
             min_views = @min_views, min_length = @min_length, platforms = @platforms, languages = @languages, hashtags = @hashtags, disclosure = @disclosure,
             material_links = @material_links, status = @status, locked = @locked, starts_at = @starts_at, ends_at = @ends_at, created_at_vyro = @created_at_vyro,
             last_seen_at = @at, present = 1 WHERE vyro_id = @vyro_id`
        ).run(datos)
      } else {
        // en la primera lectura todo sería «nuevo»: se dan por vistas y no se avisa
        db.prepare(
          `INSERT INTO vyro_campaigns (vyro_id, slug, brand, name, pay_rate, budget_total, budget_remaining, min_views, min_length, platforms, languages, hashtags,
             disclosure, material_links, status, locked, starts_at, ends_at, created_at_vyro, first_seen_at, last_seen_at, present, acknowledged_at)
           VALUES (@vyro_id, @slug, @brand, @name, @pay_rate, @budget_total, @budget_remaining, @min_views, @min_length, @platforms, @languages, @hashtags,
             @disclosure, @material_links, @status, @locked, @starts_at, @ends_at, @created_at_vyro, @at, @at, 1, @ack)`
        ).run({ ...datos, ack: primera ? at : null })
        if (!primera) r.fresh.push(c)
      }
      // enlace con la campaña local: el que ya hubiera, o uno automático si está claro y esa local sigue libre
      let campaignId: string | null = antes?.campaign_id ?? null
      let recienEnlazada = false
      if (!campaignId && (antes?.link_state ?? 'none') === 'none') {
        const libres = locales.filter((l) => !db.prepare('SELECT 1 FROM vyro_campaigns WHERE campaign_id = ?').get(l.campaignId))
        campaignId = matchLocalCampaign(c, libres)
        if (campaignId) {
          db.prepare("UPDATE vyro_campaigns SET campaign_id = ?, link_state = 'auto' WHERE vyro_id = ?").run(campaignId, c.vyroId)
          recienEnlazada = true
        }
      }
      // cerrar la local solo cuando Vyro ACABA de bloquearla (o al enlazarla ya bloqueada): si luego la reabres a mano, se respeta
      const antesTerminada = antes ? terminada({ locked: antes.locked === 1, status: antes.status }) : false
      if (campaignId) aplicarALocal(db, campaignId, c, recienEnlazada || !antesTerminada, at, r)
      if (campaignId && antesTerminada && !terminada(c)) reabrirSiVuelve(db, campaignId, at, r)
    }
    closeFulfilledOrders(db)
    ponerAjuste(db, 'vyro_last_check_at', at)
    ponerAjuste(db, 'vyro_last_error', null)
  })()
  return r
}

export function recordVyroError(db: DB, mensaje: string, now: () => string = () => new Date().toISOString()): void {
  ponerAjuste(db, 'vyro_last_check_at', now())
  ponerAjuste(db, 'vyro_last_error', mensaje)
}

/** Enlaza a mano una campaña de Vyro con una local (o con ninguna, con null). */
export function linkVyroCampaign(db: DB, vyroId: string, campaignId: string | null, now: () => string = () => new Date().toISOString()): void {
  const v = db.prepare('SELECT * FROM vyro_campaigns WHERE vyro_id = ?').get(vyroId) as Row | undefined
  if (!v) throw new Error('Esa campaña de Vyro no existe.')
  if (campaignId === null) {
    db.prepare("UPDATE vyro_campaigns SET campaign_id = NULL, link_state = 'rejected' WHERE vyro_id = ?").run(vyroId)
    return
  }
  if (!db.prepare('SELECT 1 FROM campaigns WHERE campaign_id = ?').get(campaignId)) throw new Error('La campaña no existe.')
  db.transaction(() => {
    db.prepare("UPDATE vyro_campaigns SET campaign_id = NULL, link_state = 'none' WHERE campaign_id = ? AND vyro_id <> ?").run(campaignId, vyroId)
    db.prepare("UPDATE vyro_campaigns SET campaign_id = ?, link_state = 'manual' WHERE vyro_id = ?").run(campaignId, vyroId)
    aplicarALocal(db, campaignId, vistaDe(v), true, now(), { fresh: [], closedLocal: [], datedLocal: [] })
    closeFulfilledOrders(db)
  })()
}

/** Da por vistas las campañas nuevas. */
export function acknowledgeVyro(db: DB, now: () => string = () => new Date().toISOString()): void {
  db.prepare('UPDATE vyro_campaigns SET acknowledged_at = ? WHERE acknowledged_at IS NULL').run(now())
}

const json = (t: string | null): string[] => {
  try {
    return lista(JSON.parse(t ?? '[]'))
  } catch {
    return []
  }
}

function vistaDe(v: Row): VyroCampaign {
  return {
    vyroId: v.vyro_id, slug: v.slug, brand: v.brand ?? '', name: v.name ?? '', payRate: v.pay_rate, budgetTotal: v.budget_total, budgetRemaining: v.budget_remaining,
    minViews: v.min_views, minLength: v.min_length, platforms: json(v.platforms), languages: json(v.languages), hashtags: json(v.hashtags),
    disclosure: json(v.disclosure), materialLinks: json(v.material_links), status: v.status, locked: v.locked === 1,
    startsAt: v.starts_at, endsAt: v.ends_at, createdAt: v.created_at_vyro
  }
}

export function vyroNewCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM vyro_campaigns WHERE acknowledged_at IS NULL AND present = 1').get() as Row).n
}

/** Lo que enseña la pantalla de Vyro: abiertas primero (las nuevas delante, luego la más reciente). */
export function getVyro(db: DB, now: Date = new Date()): VyroView {
  const hoy = today(now)
  const filas = db.prepare(
    `SELECT v.*, COALESCE(c.display_name, c.folder_name) AS campaign_name FROM vyro_campaigns v LEFT JOIN campaigns c ON c.campaign_id = v.campaign_id`
  ).all() as Row[]
  const campaigns = filas.map((v): VyroCampaignView => {
    const c = vistaDe(v)
    const fin = c.endsAt && !Number.isNaN(Date.parse(c.endsAt)) ? today(new Date(c.endsAt)) : null
    const dias = fin ? Math.round((Date.parse(fin + 'T00:00:00Z') - Date.parse(hoy + 'T00:00:00Z')) / 86_400_000) + 1 : null
    const present = v.present === 1
    return {
      ...c, url: vyroCampaignUrl(c.slug), present, isNew: v.acknowledged_at == null && present, firstSeenAt: v.first_seen_at,
      daysLeft: dias != null && dias >= 1 ? dias : null, open: present && !terminada(c) && (dias == null || dias >= 1),
      campaignId: v.campaign_id, campaignName: v.campaign_name ?? null, linkState: v.link_state,
      order: v.campaign_id ? null : getOrder(db, v.vyro_id)
    }
  }).sort((a, b) => Number(b.open) - Number(a.open) || Number(b.isNew) - Number(a.isNew) || String(b.startsAt ?? b.createdAt ?? '').localeCompare(String(a.startsAt ?? a.createdAt ?? '')))
  const localOptions = (db.prepare('SELECT campaign_id, COALESCE(display_name, folder_name) AS name FROM campaigns ORDER BY name').all() as Row[]).map((l) => ({ campaignId: l.campaign_id, name: l.name }))
  return { campaigns, lastCheckAt: ajuste(db, 'vyro_last_check_at'), lastError: ajuste(db, 'vyro_last_error'), newCount: campaigns.filter((c) => c.isNew).length, localOptions }
}
