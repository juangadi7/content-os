/**
 * Recomendaciones para el plan de «Hoy». Son archivos de texto que mantiene quien prepara las campañas
 * (el operador) y que CONTENT OS solo LEE:
 *
 *   - en cada campaign.json, la clave "plan": dónde NO conviene subir esa campaña o algunos de sus clips;
 *   - en <biblioteca>\..\PLAN\canales.json: cada cuánto y a qué horas conviene subir en cada canal, y notas.
 *
 * Nada de esto es obligatorio: sin archivos, el plan funciona como siempre. No se guarda en la base de datos.
 */
import type { DB } from './db'
import { readJson } from './files'
import { isPlatform, PLATFORMS, type Platform } from './format'

export interface CampaignAdvice {
  /** Plataformas donde no conviene subir NINGÚN clip de la campaña. */
  avoidPlatforms: { platform: Platform; reason: string }[]
  /** Clips concretos (por su número, el del nombre del archivo) que no conviene subir a una plataforma. */
  avoidClips: { platform: Platform; clips: number[]; reason: string }[]
  /** «solo_canales»: la campaña va SOLO a estos canales (y a ninguna otra plataforma). Vacío = sin restricción. */
  onlyChannels?: { platform: Platform; name: string }[]
}

export interface ChannelAdvice {
  /** Horas mínimas entre dos subidas al mismo canal. null = sin límite. */
  minHours: number | null
  /** Franja recomendada [desde, hasta) en horas locales, p. ej. [12, 15]. null = cualquiera. */
  window: [number, number] | null
  note: string | null
  /** true = canal en reposo: no se le propone nada. */
  hold: boolean
  /** «dedicado»: el canal solo recibe las campañas que lo nombran en «solo_canales» (canales de Roblox). */
  dedicated?: boolean
  /** Máximo de vídeos al día que propone el plan, aunque el canal tenga puesto más («maximo_al_dia»). */
  maxPerDay?: number | null
}

export interface Advice {
  campaigns: Map<string, CampaignAdvice>
  channels: Map<string, ChannelAdvice>
  defaults: ChannelAdvice
  /** Máximo al día por plataforma («por_plataforma»: { "youtube": { "maximo_al_dia": 1 } }). */
  platforms?: Map<Platform, number>
  /** Fecha que declara canales.json ("actualizado"), para enseñar de cuándo son las notas. */
  updatedAt: string | null
  /** Archivos que no se pudieron leer: se avisa, no se ignora en silencio. */
  errors: string[]
}

const SIN_CONSEJO: ChannelAdvice = { minHours: null, window: null, note: null, hold: false }
export const NO_ADVICE: Advice = { campaigns: new Map(), channels: new Map(), defaults: SIN_CONSEJO, updatedAt: null, errors: [] }

export const channelKey = (platform: string, name: string) => `${platform}:${name.trim().toLowerCase()}`

/** Número de un clip según su archivo: "028_titulo.mp4" -> 28. null si el nombre no empieza por número. */
export function clipNumber(filename: string | null | undefined): number | null {
  const m = /^(\d{1,4})[_\-. ]/.exec(filename ?? '')
  return m ? Number(m[1]) : null
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Lee la clave "plan" de un campaign.json. Lo que no entiende lo ignora. */
export function parseCampaignAdvice(plan: unknown): CampaignAdvice {
  const p = (plan && typeof plan === 'object' ? plan : {}) as Record<string, unknown>
  const lista = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])
  const solo = lista(p.solo_canales).filter((x) => isPlatform(x.plataforma) && texto(x.cuenta))
    .map((x) => ({ platform: x.plataforma as Platform, name: texto(x.cuenta) }))
  // plataformas sin ningún canal en «solo_canales»: esa campaña no va ahí
  const sinCanal = solo.length ? PLATFORMS.filter((pf) => !solo.some((c) => c.platform === pf))
    .map((pf) => ({ platform: pf, reason: 'Esta campaña va solo a ' + solo.map((c) => c.name).join(' y ') })) : []
  return {
    ...(solo.length ? { onlyChannels: solo } : {}),
    avoidPlatforms: [...sinCanal, ...lista(p.no_subir_a).filter((x) => isPlatform(x.plataforma)).map((x) => ({ platform: x.plataforma as Platform, reason: texto(x.motivo) }))],
    avoidClips: lista(p.clips_no_subir).filter((x) => isPlatform(x.plataforma) && Array.isArray(x.clips))
      .map((x) => ({ platform: x.plataforma as Platform, clips: (x.clips as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0), reason: texto(x.motivo) }))
      .filter((x) => x.clips.length > 0)
  }
}

function canal(v: unknown, base: ChannelAdvice): ChannelAdvice {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const h = c.horas_minimas
  const f = c.franja
  const tope = Number.isInteger(c.maximo_al_dia) && (c.maximo_al_dia as number) >= 0 && (c.maximo_al_dia as number) <= 20 ? (c.maximo_al_dia as number) : base.maxPerDay ?? null
  const franja = Array.isArray(f) && f.length === 2 && f.every((n) => Number.isInteger(n) && n >= 0 && n <= 24) && f[0] < f[1] ? ([f[0], f[1]] as [number, number]) : undefined
  return {
    minHours: typeof h === 'number' && h >= 0 && h <= 24 * 14 ? h : h === null ? null : base.minHours,
    window: franja ?? (f === null ? null : base.window),
    note: texto(c.nota) || null,
    hold: c.en_reposo === true,
    ...(c.dedicado === true ? { dedicated: true } : {}),
    ...(tope != null ? { maxPerDay: tope } : {})
  }
}

/** Lee el contenido de PLAN\canales.json. */
export function parseChannelsAdvice(json: unknown): Pick<Advice, 'channels' | 'defaults' | 'updatedAt' | 'platforms'> {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const defaults = canal(j.por_defecto, SIN_CONSEJO)
  const channels = new Map<string, ChannelAdvice>()
  const cs = (j.canales && typeof j.canales === 'object' ? j.canales : {}) as Record<string, unknown>
  for (const [clave, v] of Object.entries(cs)) {
    const i = clave.indexOf(':')
    if (i > 0 && isPlatform(clave.slice(0, i))) channels.set(channelKey(clave.slice(0, i), clave.slice(i + 1)), canal(v, defaults))
  }
  const platforms = new Map<Platform, number>()
  const pp = (j.por_plataforma && typeof j.por_plataforma === 'object' ? j.por_plataforma : {}) as Record<string, unknown>
  for (const [p, v] of Object.entries(pp)) {
    const m = (v as Record<string, unknown> | null)?.maximo_al_dia
    if (isPlatform(p) && Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 20) platforms.set(p, m as number)
  }
  return { channels, defaults: { ...defaults, note: null, hold: false }, updatedAt: texto(j.actualizado) || null, platforms }
}

/** Tope de vídeos al día para un canal según el archivo de canales (el del canal, si no el de su plataforma). null = sin tope. */
export function dailyCap(advice: Advice, platform: Platform, name: string): number | null {
  const propio = advice.channels.get(channelKey(platform, name))?.maxPerDay
  if (propio != null) return propio
  return advice.platforms?.get(platform) ?? advice.defaults.maxPerDay ?? null
}

/** Aplica ese tope a los canales del plan (no cambia lo que el usuario puso en «Canales…»). */
export function capAccounts<T extends { platform: Platform; name: string; dailyLimit: number; limitSetByUser?: boolean }>(accounts: T[], advice: Advice): T[] {
  return accounts.map((a) => {
    // el tope que el usuario cambió a mano en la app manda: canales.json solo pone el de los demás
    if (a.limitSetByUser) return a
    const tope = dailyCap(advice, a.platform, a.name)
    return tope != null && tope < a.dailyLimit ? { ...a, dailyLimit: tope } : a
  })
}

/** Reúne las recomendaciones de todas las campañas y del archivo de canales. Solo lee. */
export function loadAdvice(db: DB, channelsFile: string | null): Advice {
  const out: Advice = { campaigns: new Map(), channels: new Map(), defaults: SIN_CONSEJO, updatedAt: null, errors: [] }
  const filas = db.prepare('SELECT campaign_id, campaign_json_path FROM campaigns WHERE present_in_source = 1').all() as { campaign_id: string; campaign_json_path: string }[]
  for (const f of filas) {
    const r = readJson(f.campaign_json_path)
    if (!r.ok) continue // sin campaign.json legible no hay consejo; la sincronización ya avisa de eso
    const plan = (r.value as Record<string, unknown> | null)?.plan
    if (plan == null) continue
    const a = parseCampaignAdvice(plan)
    if (a.avoidPlatforms.length || a.avoidClips.length || a.onlyChannels?.length) out.campaigns.set(f.campaign_id, a)
  }
  if (channelsFile) {
    const r = readJson(channelsFile)
    if (r.ok) Object.assign(out, parseChannelsAdvice(r.value))
    else if (!r.missing) out.errors.push(`No se pudo leer ${channelsFile}: ${r.error}`)
  }
  return out
}

/**
 * Cuándo conviene la siguiente subida a un canal. null = ya, ahora mismo.
 * Tiene en cuenta el cupo de hoy, las horas mínimas desde la última subida y la franja recomendada.
 */
export function nextUploadAt(now: Date, opts: { quotaDone: boolean; lastUploadAt: string | null; advice: ChannelAdvice }): Date | null {
  let t = new Date(now)
  if (opts.quotaDone) {
    t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0)
  }
  if (opts.lastUploadAt && opts.advice.minHours) {
    const libre = new Date(new Date(opts.lastUploadAt).getTime() + opts.advice.minHours * 3600_000)
    if (libre > t) t = libre
  }
  if (opts.advice.window && t > now) {
    const [desde, hasta] = opts.advice.window
    const h = t.getHours() + t.getMinutes() / 60
    if (h >= hasta) t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, desde, 0, 0)
    else if (h < desde) t = new Date(t.getFullYear(), t.getMonth(), t.getDate(), desde, 0, 0)
  }
  return t > now ? t : null
}
