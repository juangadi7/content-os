/**
 * Lo que falta enviar a Vyro («Add posts»): cada publicación de una campaña ya pública (su hora ya pasó) que
 * todavía no está marcada como enviada. Un vídeo programado entra solo en la lista cuando llega su hora; uno de
 * YouTube, en cuanto la sincronización lo encuentra publicado. Pasado el último día de la campaña ya no se pide.
 */
import type { DB } from './db'
import { today } from './queries'

type Row = Record<string, any>

export interface VyroPending {
  publicationId: number
  clipId: string
  title: string
  platform: string
  account: string
  url: string | null
  publishedAt: string
  campaignId: string
  campaignName: string
  /** Último día para enviarlo (el de la campaña), si se sabe. */
  endsAt: string | null
  /** Comprobado con tus envíos de Vyro: seguro que no está allí (si no, es que aún no se ha marcado como enviado). */
  verified: boolean
}

/** La campaña tiene sus envíos de Vyro leídos (ajuste «vyro_leida:<id de Vyro>», lo escribe la lectura de envíos). */
const LEIDA = "EXISTS (SELECT 1 FROM vyro_campaigns v JOIN settings st ON st.key = 'vyro_leida:' || v.vyro_id WHERE v.campaign_id = c.campaign_id)"

/** Apunta que los envíos de esa campaña de Vyro se han leído (así se sabe que lo que no aparece, falta de verdad). */
export function markVyroCampaignRead(db: DB, vyroId: string, now: Date | string = new Date()): void {
  const at = typeof now === 'string' ? now : now.toISOString()
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`vyro_leida:${vyroId}`, at)
}

export function listVyroPending(db: DB, now: Date = new Date()): VyroPending[] {
  const filas = db.prepare(
    `SELECT p.id, p.clip_id, p.platform, p.account, p.url, p.published_at, COALESCE(k.title, k.filename, k.clip_id) AS title, ${LEIDA} AS verified,
       c.campaign_id, COALESCE(c.display_name, c.folder_name) AS campaign_name, c.ends_at
     FROM publications p JOIN clips k ON k.clip_id = p.clip_id JOIN campaigns c ON c.campaign_id = k.campaign_id
     WHERE p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at <= @ahora
       AND NOT EXISTS (SELECT 1 FROM vyro_submissions s WHERE s.publication_id = p.id)
       -- sin marcar como enviada; o dada por enviada al instalar el recordatorio (vyro_sent_at = published_at) pero
       -- que, leídos tus envíos de esa campaña en Vyro, no aparece allí. Lo marcado a mano se respeta.
       AND (p.vyro_sent_at IS NULL OR (p.url IS NOT NULL AND p.vyro_sent_manual = 0 AND ${LEIDA}))
       AND (c.ends_at IS NULL OR c.ends_at >= @hoy)
       -- campaña cerrada a mano o bloqueada/terminada en Vyro: ya no se puede enviar
       AND c.closed = 0
       AND NOT EXISTS (SELECT 1 FROM vyro_campaigns v WHERE v.campaign_id = c.campaign_id AND (v.locked = 1 OR (v.status IS NOT NULL AND v.status <> 'active')))
       -- ignorado por el usuario (la misma marca que en «Control de vídeos»)
       AND NOT EXISTS (SELECT 1 FROM settings st WHERE st.key = 'control_ignorado:p' || p.id)
       AND (c.platform IS NULL OR lower(c.platform) = 'vyro')
     ORDER BY p.published_at, p.id`
  ).all({ ahora: now.toISOString(), hoy: today(now) }) as Row[]
  return filas.map((r) => ({
    publicationId: r.id, clipId: r.clip_id, title: r.title, platform: r.platform, account: String(r.account ?? '').replace(/ · .*$/, ''),
    url: r.url ?? null, publishedAt: r.published_at, campaignId: r.campaign_id, campaignName: r.campaign_name, endsAt: r.ends_at ?? null,
    verified: r.verified === 1 && !!r.url,
  }))
}

/** Marca una publicación como enviada a Vyro (o lo deshace). */
export function setVyroSent(db: DB, publicationId: unknown, sent: boolean, now: Date = new Date()): void {
  if (typeof publicationId !== 'number' || !Number.isInteger(publicationId)) throw new Error('Publicación no válida.')
  const r = db.prepare('UPDATE publications SET vyro_sent_at = ?, vyro_sent_manual = ? WHERE id = ?').run(sent ? now.toISOString() : null, sent ? 1 : 0, publicationId)
  if (r.changes === 0) throw new Error('Esa publicación no existe.')
}
