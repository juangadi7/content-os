/**
 * Claves de TikTok e Instagram y sincronización de esas cuentas.
 *
 * Las claves están en C:\Users\<usuario>\.secretos (las mismas que usan los programas de mundial-clipper):
 *   instagram.json → {"token": "EAA…"}
 *   tiktok.json    → {"client_key", "client_secret", "cuentas": {alias: {access_token, refresh_token, caduca, open_id}}}
 * La interfaz nunca recibe una clave. El token de TikTok se renueva solo cuando caduca y se guarda en el mismo archivo.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DB } from '../core/db'
import {
  fetchInstagramAccount, fetchTikTokAccount, markSocialError, noteSocialFollowers, saveSocialAccount,
  SocialError, type SocialFetch, type SocialPlatform, type SocialRefreshResult
} from '../core/social'

export const SECRETOS_DIR = path.join(os.homedir(), '.secretos')

type Cuenta = { access_token: string; refresh_token: string; caduca: number; open_id?: string }
type TikTokSecretos = { client_key: string; client_secret: string; cuentas: Record<string, Cuenta> }

function leerJson(nombre: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(SECRETOS_DIR, nombre), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function tokenInstagram(): string | null {
  try {
    return /EAA[A-Za-z0-9]+/.exec(fs.readFileSync(path.join(SECRETOS_DIR, 'instagram.json'), 'utf8'))?.[0] ?? null
  } catch {
    return null
  }
}

function secretosTikTok(): TikTokSecretos | null {
  const d = leerJson('tiktok.json')
  if (!d?.client_key || !d?.client_secret) return null
  return { ...d, client_key: String(d.client_key).trim(), client_secret: String(d.client_secret).trim(), cuentas: d.cuentas ?? {} }
}

/** Token válido de una cuenta de TikTok; si caducó, lo renueva y guarda el archivo (escritura atómica). */
async function tokenTikTok(alias: string, f: SocialFetch): Promise<string> {
  const s = secretosTikTok()
  const c = s?.cuentas[alias]
  if (!s || !c) throw new SocialError(`La cuenta ${alias} no está autorizada.`)
  if (Date.now() / 1000 < c.caduca) return c.access_token
  const r = await f('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: s.client_key, client_secret: s.client_secret, grant_type: 'refresh_token', refresh_token: c.refresh_token }).toString()
  })
  const d = await r.json().catch(() => null)
  if (!d?.access_token) throw new SocialError(`TikTok no renovó el acceso de ${alias}: ${d?.error_description || d?.error || r.status}. Vuelve a autorizar la cuenta.`)
  // se relee el archivo justo antes de escribir para no pisar otra cuenta renovada a la vez
  const actual = leerJson('tiktok.json') ?? s
  actual.cuentas = { ...(actual.cuentas ?? {}), [alias]: { access_token: d.access_token, refresh_token: d.refresh_token ?? c.refresh_token, caduca: Date.now() / 1000 + Number(d.expires_in ?? 86400) - 300, open_id: d.open_id ?? c.open_id ?? '' } }
  const ruta = path.join(SECRETOS_DIR, 'tiktok.json')
  fs.writeFileSync(ruta + '.tmp', JSON.stringify(actual, null, 1), 'utf8')
  fs.renameSync(ruta + '.tmp', ruta)
  return d.access_token
}

/** Qué cuentas se pueden leer ahora mismo (sin enseñar ninguna clave). */
export function socialConnections(): { platform: SocialPlatform; account: string }[] {
  const out: { platform: SocialPlatform; account: string }[] = []
  for (const alias of Object.keys(secretosTikTok()?.cuentas ?? {})) out.push({ platform: 'tiktok', account: '@' + alias.replace(/^@/, '') })
  if (tokenInstagram()) out.push({ platform: 'instagram', account: 'Instagram' })
  return out
}

let enCurso: Promise<SocialRefreshResult> | null = null

/** Lee todas las cuentas conectadas y lo guarda. Una cuenta que falle no para a las demás. */
export function refreshSocial(db: DB, f: SocialFetch, opts: { force?: boolean } = {}): Promise<SocialRefreshResult> {
  enCurso ??= (async () => {
    const res: SocialRefreshResult = { accounts: [] }
    const tareas: { platform: SocialPlatform; account: string; leer: () => Promise<Awaited<ReturnType<typeof fetchTikTokAccount>>> }[] = []
    for (const alias of Object.keys(secretosTikTok()?.cuentas ?? {})) {
      tareas.push({ platform: 'tiktok', account: alias, leer: async () => fetchTikTokAccount(alias, await tokenTikTok(alias, f), f) })
    }
    const ig = tokenInstagram()
    if (ig) tareas.push({ platform: 'instagram', account: 'Instagram', leer: () => fetchInstagramAccount(ig, f) })
    for (const t of tareas) {
      try {
        const data = await t.leer()
        const summary = saveSocialAccount(db, data, { force: opts.force })
        noteSocialFollowers(db, data)
        // un fallo anterior de Instagram sin nombre de cuenta deja de tener sentido
        if (t.platform === 'instagram') db.prepare("DELETE FROM social_accounts WHERE platform = 'instagram' AND account = '@Instagram'").run()
        res.accounts.push({ platform: t.platform, account: data.account, ok: true, summary })
      } catch (e) {
        const msg = e instanceof SocialError ? e.message : `No se pudo conectar (${(e as Error).message}).`
        // si la cuenta ya existe con su @nombre, el error se le apunta a ella
        const nombre = t.platform === 'tiktok' ? t.account : ((db.prepare("SELECT account FROM social_accounts WHERE platform = 'instagram' LIMIT 1").get() as { account?: string } | undefined)?.account ?? 'Instagram')
        markSocialError(db, t.platform, nombre, msg)
        res.accounts.push({ platform: t.platform, account: nombre, ok: false, error: msg })
      }
    }
    return res
  })().finally(() => {
    enCurso = null
  })
  return enCurso
}
