/**
 * Plan de «Hoy»: qué clips subir y en qué canal. Datos propios de CONTENT OS.
 *
 * Reglas:
 *  - Cada canal tiene un tope de subidas al día. Lo publicado hoy ocupa sus primeros huecos.
 *  - Un clip va a UN solo canal por plataforma. Regla de Vyro: el mismo vídeo puede ir a plataformas distintas,
 *    pero nunca dos veces en la misma, tampoco desde cuentas distintas (se arriesga la aprobación de la campaña).
 *  - Primero las campañas que acaban en 3 días o menos; después las que mejor pagan; a igual pago, las que acaban
 *    antes. Dentro de cada campaña, el orden de calidad.
 *  - Los clips se reparten por rondas entre los canales (el mejor al primero, el siguiente al segundo…),
 *    de modo que marcar uno como subido no cambia lo que se propuso a los demás.
 */
import { channelKey, clipNumber, nextUploadAt, NO_ADVICE, type Advice, capAccounts } from './advice'
import type { DB } from './db'
import { withChannelVideos } from './youtube-channels'
import { isPlatform, PLATFORMS, type Platform } from './format'
import { listCampaigns, listClips, today, type ClipView } from './queries'

export const DEFAULT_DAILY_LIMIT = 3
export const MAX_DAILY_LIMIT = 20

export interface AccountView {
  id: number
  platform: Platform
  name: string
  dailyLimit: number
  active: boolean
  /** Publicaciones hechas en este canal desde siempre. */
  published: number
  /** Campañas asignadas a este canal. Vacío = recibe las campañas que no tienen canal asignado. */
  campaignIds: string[]
  /** El tope diario se cambió a mano en la app: manda sobre el de PLAN\canales.json. */
  limitSetByUser?: boolean
  /** Campañas que nombran este canal en «solo_canales» del campaign.json. No lo vuelven exclusivo. */
  adviceCampaignIds?: string[]
  /** Canal exclusivo por canales.json («dedicado»): solo recibe sus campañas. */
  dedicated?: boolean
}

export interface AccountInput {
  /** Con id se cambia el tope o si está activo; sin id se crea (plataforma y nombre obligatorios). */
  id?: number
  platform?: Platform
  name?: string
  dailyLimit?: number
  active?: boolean
}

export interface PlanClip {
  clip: ClipView
  /** Días que le quedan a su campaña (contando hoy); null si no tiene plazo. */
  daysLeft: number | null
}

export interface PlanDone {
  publicationId: number
  clipId: string
  title: string
  publishedAt: string
  /** Con métricas guardadas ya no se puede deshacer desde aquí. */
  locked: boolean
}

export interface PlanAccount {
  account: AccountView
  /** Canal de YouTube seguido que corresponde a este canal del plan (mismo @nombre), para enseñar su imagen. */
  channelId: string | null
  doneToday: PlanDone[]
  suggestions: PlanClip[]
  /** Nota del operador sobre este canal (PLAN\\canales.json), si la hay. */
  note: string | null
  /** Franja recomendada para subir, en horas locales. */
  window: [number, number] | null
  /** Canal en reposo: no se le propone nada. */
  hold: boolean
  /** true si hay cupo pero aún no han pasado las horas mínimas desde la última subida. */
  waiting: boolean
  /** Cuándo conviene la siguiente subida (ISO). null = ahora. */
  nextAt: string | null
  /** El clip que tocará cuando se pueda volver a subir (cuando hoy no se propone ninguno). */
  upNext: PlanClip | null
  /**
   * Clips pendientes en esta plataforma que este canal no recibe porque su campaña está asignada a otros canales
   * (o porque este canal solo recibe sus campañas asignadas). Sirve para explicar un «no hay nada» que no lo es.
   */
  elsewhere: { campaignId: string; campaignName: string; clips: number; owners: string[] }[]
}

/** Clips que el plan deja fuera de una plataforma por recomendación, con su motivo. */
export interface PlanSkipped {
  platform: Platform
  campaignId: string
  campaignName: string
  clips: number
  /** true = toda la campaña; false = solo algunos clips. */
  whole: boolean
  reason: string
}

export interface PlanPlatform {
  platform: Platform
  /** Clips de campañas abiertas que aún no están en esta plataforma. */
  pending: number
  /** Subidas al día sumando los canales activos. */
  capacity: number
  /** Días que dura lo pendiente a ese ritmo; null sin canales. */
  daysOfContent: number | null
}

export interface PlanWarning {
  campaignId: string
  campaignName: string
  platform: Platform
  pending: number
  daysLeft: number
  /** Clips que no da tiempo a subir antes de que cierre, al ritmo actual. */
  wontFit: number
}

export interface PlanView {
  date: string
  accounts: PlanAccount[]
  /** Todos los canales, también los pausados. */
  allAccounts: AccountView[]
  platforms: PlanPlatform[]
  warnings: PlanWarning[]
  /** Subidas propuestas que quedan por hacer hoy. */
  left: number
  /** Lo que no se propone por recomendación del operador, y por qué. */
  skipped: PlanSkipped[]
  /** De cuándo son las notas de los canales, si el archivo lo dice. */
  adviceUpdatedAt: string | null
  adviceErrors: string[]
}

type Row = Record<string, any>

export function listAccounts(db: DB): AccountView[] {
  const filas = db.prepare(
    `SELECT a.*, (SELECT COUNT(*) FROM publications p WHERE p.platform = a.platform AND p.account = a.name COLLATE NOCASE AND p.status = 'published') AS n
     FROM accounts a ORDER BY a.id`
  ).all() as Row[]
  const asignadas = new Map<number, string[]>()
  for (const r of db.prepare('SELECT account_id, campaign_id FROM campaign_accounts ORDER BY campaign_id').all() as Row[]) {
    asignadas.set(r.account_id, [...(asignadas.get(r.account_id) ?? []), r.campaign_id])
  }
  const aMano = new Set((db.prepare("SELECT key FROM settings WHERE key LIKE 'limite_a_mano:%'").all() as Row[]).map((r) => Number(String(r.key).slice(14))))
  const vistas = filas.map((a) => ({ id: a.id, platform: a.platform as Platform, name: a.name, dailyLimit: a.daily_limit, active: a.active === 1, published: a.n, campaignIds: asignadas.get(a.id) ?? [], limitSetByUser: aMano.has(a.id) }))
  return PLATFORMS.flatMap((pf) => vistas.filter((a) => a.platform === pf))
}

function tope(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_DAILY_LIMIT) throw new Error(`Las subidas al día deben estar entre 1 y ${MAX_DAILY_LIMIT}.`)
  return v
}

/** Crea un canal o cambia su tope diario / si está activo. Devuelve su id. */
export function saveAccount(db: DB, input: AccountInput, now: () => string = () => new Date().toISOString()): number {
  if (!input || typeof input !== 'object') throw new Error('Canal no válido.')
  if (input.id != null) {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.id) as Row | undefined
    if (!a) throw new Error('El canal no existe.')
    const limite = input.dailyLimit === undefined ? a.daily_limit : tope(input.dailyLimit)
    const activo = input.active === undefined ? a.active : input.active ? 1 : 0
    db.prepare('UPDATE accounts SET daily_limit = ?, active = ? WHERE id = ?').run(limite, activo, input.id)
    // cambiado a mano en la app: manda sobre el tope de PLANcanales.json (19-oct: Juan cambia sus topes y quiere verlo al momento)
    if (input.dailyLimit !== undefined) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run('limite_a_mano:' + input.id, now())
    }
    return input.id
  }
  if (!isPlatform(input.platform)) throw new Error('Plataforma no válida.')
  const nombre = typeof input.name === 'string' ? input.name.trim() : ''
  if (!nombre) throw new Error('Escribe el nombre del canal.')
  if (nombre.length > 120) throw new Error('Nombre demasiado largo.')
  const limite = input.dailyLimit === undefined ? DEFAULT_DAILY_LIMIT : tope(input.dailyLimit)
  if (db.prepare('SELECT 1 FROM accounts WHERE platform = ? AND name = ?').get(input.platform, nombre)) throw new Error('Ese canal ya está en la lista.')
  return Number(db.prepare('INSERT INTO accounts (platform, name, daily_limit, active, created_at) VALUES (?, ?, ?, 1, ?)').run(input.platform, nombre, limite, now()).lastInsertRowid)
}

/** Quita el canal del plan. Sus publicaciones y estadísticas se conservan. */
export function removeAccount(db: DB, id: number): void {
  if (!Number.isInteger(id)) throw new Error('Canal no válido.')
  db.transaction(() => {
    db.prepare('DELETE FROM campaign_accounts WHERE account_id = ?').run(id)
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  })()
}

/** Fija qué canales publican una campaña (lista vacía = sin asignar: va a los canales libres). */
export function setCampaignAccounts(db: DB, campaignId: string, accountIds: number[]): void {
  if (typeof campaignId !== 'string' || !db.prepare('SELECT 1 FROM campaigns WHERE campaign_id = ?').get(campaignId)) throw new Error('La campaña no existe.')
  if (!Array.isArray(accountIds) || accountIds.some((i) => !Number.isInteger(i))) throw new Error('Canales no válidos.')
  const ids = [...new Set(accountIds)]
  for (const id of ids) if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw new Error('El canal no existe.')
  db.transaction(() => {
    db.prepare('DELETE FROM campaign_accounts WHERE campaign_id = ?').run(campaignId)
    for (const id of ids) db.prepare('INSERT INTO campaign_accounts (campaign_id, account_id) VALUES (?, ?)').run(campaignId, id)
  })()
}

/**
 * ¿Puede este canal publicar clips de esta campaña?
 *  - si la campaña tiene canales asignados en esa plataforma: solo esos;
 *  - si no tiene ninguno: los canales que no tienen campañas asignadas (los «dedicados» no reciben nada más).
 */
export function accountTakesCampaign(account: AccountView, campaignId: string, todos: AccountView[]): boolean {
  const suyas = (a: AccountView) => [...a.campaignIds, ...(a.adviceCampaignIds ?? [])]
  if (suyas(account).includes(campaignId)) return true
  const asignadaEnPlataforma = todos.some((a) => a.platform === account.platform && suyas(a).includes(campaignId))
  // exclusivo: asignado en la app o «dedicado» en canales.json. «solo_canales» por sí solo no lo vuelve exclusivo
  return !asignadaEnPlataforma && account.campaignIds.length === 0 && !account.dedicated
}

/**
 * Las asignaciones que cuentan son solo las de campañas abiertas y presentes: un canal asignado a una campaña que
 * ya terminó vuelve a recibir las campañas sin asignar (si no, se quedaría sin nada que subir para siempre).
 */
export function withLiveAssignments(accounts: AccountView[], campaigns: Map<string, { closed: boolean; presentInSource: boolean }>): AccountView[] {
  const viva = (id: string) => { const c = campaigns.get(id); return !!c && !c.closed && c.presentInSource }
  return accounts.map((a) => ({ ...a, campaignIds: a.campaignIds.filter(viva), ...(a.adviceCampaignIds ? { adviceCampaignIds: a.adviceCampaignIds.filter(viva) } : {}) }))
}

const sinArroba = (n: string) => n.trim().toLowerCase().replace(/^@/, '')

/**
 * «solo_canales» del campaign.json cuenta como asignación: el canal nombrado recibe la campaña y, como en las
 * asignaciones hechas en la app, los demás canales de esa plataforma ya no (Total Drama Roblox → @Shortsdemo).
 */
export function withAdviceAssignments(accounts: AccountView[], advice: Advice): AccountView[] {
  return accounts.map((a) => {
    const extra = [...advice.campaigns].filter(([, c]) => c.onlyChannels?.some((x) => x.platform === a.platform && sinArroba(x.name) === sinArroba(a.name)))
      .map(([id]) => id).filter((id) => !a.campaignIds.includes(id))
    const consejo = advice.channels.get(channelKey(a.platform, a.name)) ?? advice.channels.get(channelKey(a.platform, '@' + sinArroba(a.name)))
      ?? advice.channels.get(channelKey(a.platform, sinArroba(a.name)))
    return extra.length || consejo?.dedicated ? { ...a, adviceCampaignIds: extra, dedicated: !!consejo?.dedicated } : a
  })
}

/** Apunta un canal la primera vez que se usa al marcar una publicación. */
export function rememberAccount(db: DB, platform: Platform, name: string, at: string): void {
  if (name) db.prepare('INSERT OR IGNORE INTO accounts (platform, name, created_at) VALUES (?, ?, ?)').run(platform, name, at)
}

/** Una campaña es urgente cuando le quedan estos días o menos: entonces pasa delante aunque pague menos. */
export const URGENTE_DIAS = 3

/**
 * Orden de los clips por su campaña: primero lo urgente (lo que acaba antes delante); después lo que mejor paga;
 * a igual pago, lo que acaba antes. Antes solo se miraba el plazo y una campaña que acababa un día más tarde
 * (Kevin Langue, 2 $/1.000, el 30-oct) no salía nunca detrás de las del 29-oct (1,05 $/1.000).
 */
export function compareCampaignPriority(
  a: { daysLeft: number | null; payRate: number | null } | undefined,
  b: { daysLeft: number | null; payRate: number | null } | undefined
): number {
  const clave = (c: typeof a): [number, number, number] => {
    const d = c?.daysLeft ?? Infinity
    return d <= URGENTE_DIAS ? [0, d, 0] : [1, -(c?.payRate ?? 0), d]
  }
  const x = clave(a)
  const y = clave(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/**
 * Campaña del último vídeo publicado en cada canal (clave channelKey). Sirve para alternar campañas:
 * varios clips seguidos de la misma campaña en un canal parecen contenido en serie («granja» para YouTube).
 */
export function lastCampaignByChannel(db: DB, now: Date): Map<string, string> {
  const out = new Map<string, string>()
  const filas = db.prepare(
    `SELECT p.platform, p.account, k.campaign_id FROM publications p JOIN clips k ON k.clip_id = p.clip_id
     WHERE p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at <= ? AND p.account IS NOT NULL
     ORDER BY p.published_at, p.id`
  ).all(now.toISOString()) as Row[]
  for (const r of filas) out.set(channelKey(r.platform, r.account), r.campaign_id)
  return out
}

/**
 * El primero de la lista que NO sea de la campaña anterior; si todos lo son, el primero.
 * Si el primero es de una campaña urgente (le quedan URGENTE_DIAS o menos), va él: ahí no se alterna.
 */
export function pickAlternating<T extends { campaignId: string }>(candidatos: T[], anterior: string | null | undefined, urgente?: (k: T) => boolean): T | undefined {
  if (candidatos[0] && urgente?.(candidatos[0])) return candidatos[0]
  return candidatos.find((k) => k.campaignId !== anterior) ?? candidatos[0]
}

export function getPlan(db: DB, now: Date = new Date(), advice: Advice = NO_ADVICE): PlanView {
  const hoy = today(now)
  const allAccounts = listAccounts(db)
  const campañas = new Map(listCampaigns(db, now).map((c) => [c.campaignId, c]))
  // para repartir, solo cuentan las asignaciones a campañas que siguen abiertas
  // el tope diario de PLAN\canales.json manda sobre el que tenga puesto el canal
  const vigentes = capAccounts(withLiveAssignments(withAdviceAssignments(allAccounts, advice), campañas), advice)
  const activas = vigentes.filter((a) => a.active)
  const dias = (k: ClipView) => campañas.get(k.campaignId)?.daysLeft ?? null

  // clips que se pueden subir: urgentes, luego mejor pagadas, luego plazo (compareCampaignPriority) y dentro el orden de calidad
  // regla nº1: lo que ya está en cualquiera de tus canales de YouTube (aunque no esté emparejado) no se vuelve a proponer
  const subibles = withChannelVideos(db, listClips(db, null, now))
    .filter((k) => k.presentInSource && !k.campaignClosed && k.fileState !== 'missing' && campañas.get(k.campaignId)?.state !== 'generating')
    .map((k, i) => ({ k, i }))
    .sort((a, b) => compareCampaignPriority(campañas.get(a.k.campaignId), campañas.get(b.k.campaignId)) || a.i - b.i)
    .map((x) => x.k)

  // lo publicado hoy (día local) en cada canal
  const desde = new Date(now.getTime() - 48 * 3600_000).toISOString()
  const recientes = (db.prepare(
    `SELECT p.id, p.clip_id, p.platform, p.account, p.published_at, COALESCE(k.title, k.filename, k.clip_id) AS title,
       (SELECT COUNT(*) FROM analytics_snapshots s WHERE s.publication_id = p.id) AS medidas
     FROM publications p JOIN clips k ON k.clip_id = p.clip_id
     WHERE p.status = 'published' AND p.published_at >= ? ORDER BY p.published_at, p.id`
  ).all(desde) as Row[]).filter((p) => today(new Date(p.published_at)) === hoy)

  // campaña del último vídeo de cada canal, para no proponer dos seguidos de la misma
  const anteriores = lastCampaignByChannel(db, now)
  const urgente = (k: ClipView) => (dias(k) ?? Infinity) <= URGENTE_DIAS

  // última subida de cada canal (cualquier día), para respetar las horas mínimas entre subidas
  const ultimas = new Map<string, string>()
  for (const r of db.prepare("SELECT platform, account, MAX(published_at) AS t FROM publications WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= ? GROUP BY platform, LOWER(account)").all(now.toISOString()) as Row[]) {
    ultimas.set(channelKey(r.platform, r.account), r.t)
  }

  // canales de YouTube seguidos, por nombre comparable: «@Democlips», «democlips» y «Democlips» son el mismo
  const comparable = (t: string | null | undefined) => (t ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '')
  const seguidos = new Map<string, string>()
  for (const c of db.prepare("SELECT channel_id, handle, title FROM youtube_channels WHERE kind = 'clips' ORDER BY added_at DESC").all() as Row[]) {
    for (const n of [c.title, c.handle]) if (comparable(n)) seguidos.set(comparable(n), c.channel_id)
  }
  const accounts: PlanAccount[] = []
  const platforms: PlanPlatform[] = []
  const warnings: PlanWarning[] = []
  const skipped: PlanSkipped[] = []
  for (const pf of PLATFORMS) {
    const canales = activas.filter((a) => a.platform === pf).map((account): PlanAccount => {
      const consejo = advice.channels.get(channelKey(pf, account.name)) ?? advice.defaults
      const doneToday = recientes.filter((p) => p.platform === pf && String(p.account).toLowerCase() === account.name.toLowerCase())
        .map((p): PlanDone => ({ publicationId: p.id, clipId: p.clip_id, title: p.title, publishedAt: p.published_at, locked: p.medidas > 0 }))
      const ultima = ultimas.get(channelKey(pf, account.name)) ?? null
      const waiting = !!ultima && !!consejo.minHours && now.getTime() - new Date(ultima).getTime() < consejo.minHours * 3600_000
      const siguiente = consejo.hold ? null : nextUploadAt(now, { quotaDone: doneToday.length >= account.dailyLimit, lastUploadAt: ultima, advice: consejo })
      return { account, channelId: pf === 'youtube' ? seguidos.get(comparable(account.name)) ?? null : null, doneToday, suggestions: [], note: consejo.note, window: consejo.window, hold: consejo.hold, waiting, nextAt: siguiente ? siguiente.toISOString() : null, upNext: null, elsewhere: [] }
    })
    // recomendaciones del operador: campañas o clips que no conviene subir a esta plataforma
    const fuera = new Map<string, PlanSkipped>()
    const pool = subibles.filter((k) => {
      if (k.published.includes(pf)) return false
      const a = advice.campaigns.get(k.campaignId)
      const toda = a?.avoidPlatforms.find((x) => x.platform === pf)
      const n = clipNumber(k.filename)
      const este = toda ? null : a?.avoidClips.find((x) => x.platform === pf && n != null && x.clips.includes(n))
      const motivo = toda ?? este
      if (!motivo) return true
      const clave = k.campaignId + '|' + motivo.reason
      const s = fuera.get(clave) ?? { platform: pf, campaignId: k.campaignId, campaignName: k.campaignName, clips: 0, whole: !!toda, reason: motivo.reason }
      s.clips++
      fuera.set(clave, s)
      return false
    })
    if (canales.length) skipped.push(...fuera.values())
    const capacity = canales.reduce((s, c) => s + c.account.dailyLimit, 0)
    platforms.push({ platform: pf, pending: pool.length, capacity, daysOfContent: capacity ? Math.ceil(pool.length / capacity) : null })
    if (!canales.length) continue

    // huecos libres de hoy, por rondas: 1.º de cada canal, 2.º de cada canal…
    const huecos: PlanAccount[] = []
    const rondas = Math.max(...canales.map((c) => c.account.dailyLimit))
    for (let r = 0; r < rondas; r++) for (const c of canales) if (!c.hold && !c.waiting && r < c.account.dailyLimit && r >= c.doneToday.length) huecos.push(c)
    // cada hueco se lleva el mejor clip que aún no tiene dueño y que ese canal puede publicar, sin repetir
    // la campaña del vídeo anterior de ese canal si hay otra disponible (alternar campañas)
    const dados = new Set<string>()
    for (const c of huecos) {
      const clave = channelKey(pf, c.account.name)
      const k = pickAlternating(pool.filter((x) => !dados.has(x.clipId) && accountTakesCampaign(c.account, x.campaignId, vigentes)), anteriores.get(clave), urgente)
      if (!k) continue
      dados.add(k.clipId)
      anteriores.set(clave, k.campaignId)
      c.suggestions.push({ clip: k, daysLeft: dias(k) })
    }
    // a los canales que hoy no reciben propuesta se les enseña cuál será el siguiente clip
    for (const c of canales) {
      if (c.hold || c.suggestions.length > 0) continue
      const k = pickAlternating(pool.filter((x) => !dados.has(x.clipId) && accountTakesCampaign(c.account, x.campaignId, vigentes)), anteriores.get(channelKey(pf, c.account.name)), urgente)
      if (!k) continue
      dados.add(k.clipId)
      c.upNext = { clip: k, daysLeft: dias(k) }
    }
    // lo que queda en la plataforma pero va a otros canales por las asignaciones de campañas
    for (const c of canales) {
      const porCampaña = new Map<string, { campaignId: string; campaignName: string; clips: number; owners: string[] }>()
      for (const k of pool) {
        if (accountTakesCampaign(c.account, k.campaignId, vigentes)) continue
        const e = porCampaña.get(k.campaignId) ?? {
          campaignId: k.campaignId, campaignName: k.campaignName, clips: 0,
          owners: canales.filter((o) => o !== c && accountTakesCampaign(o.account, k.campaignId, vigentes)).map((o) => o.account.name),
        }
        e.clips++
        porCampaña.set(k.campaignId, e)
      }
      c.elsewhere = [...porCampaña.values()]
    }
    accounts.push(...canales)

    // ¿da tiempo? campañas con plazo, la que acaba antes primero, contra los huecos que quedan hasta su último día
    const conPlazo = new Map<string, number>()
    for (const k of pool) if (dias(k) != null) conPlazo.set(k.campaignId, (conPlazo.get(k.campaignId) ?? 0) + 1)
    let acumulado = 0
    for (const [campaignId, pending] of [...conPlazo].sort((a, b) => campañas.get(a[0])!.daysLeft! - campañas.get(b[0])!.daysLeft!)) {
      const c = campañas.get(campaignId)!
      // con canales asignados, la campaña solo cuenta con los suyos
      const suyos = canales.filter((x) => accountTakesCampaign(x.account, campaignId, vigentes))
      if (suyos.length < canales.length) {
        const cap = suyos.reduce((s, x) => s + x.account.dailyLimit, 0)
        const libres = huecos.filter((h) => suyos.includes(h)).length + (c.daysLeft! - 1) * cap
        if (pending > libres) warnings.push({ campaignId, campaignName: c.displayName, platform: pf, pending, daysLeft: c.daysLeft!, wontFit: pending - libres })
        continue
      }
      acumulado += pending
      const disponibles = huecos.length + (c.daysLeft! - 1) * capacity
      if (acumulado > disponibles) warnings.push({ campaignId, campaignName: c.displayName, platform: pf, pending, daysLeft: c.daysLeft!, wontFit: Math.min(pending, acumulado - disponibles) })
    }
  }
  return { date: hoy, accounts, allAccounts, platforms, warnings, left: accounts.reduce((s, a) => s + a.suggestions.length, 0), skipped, adviceUpdatedAt: advice.updatedAt, adviceErrors: advice.errors }
}
