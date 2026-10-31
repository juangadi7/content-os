/** Plazo de las campañas. Datos propios de CONTENT OS: el importador nunca los toca. */
import type { DB } from './db'

export interface CampaignStatusInput {
  campaignId: string
  /** true = darla por cerrada; false = reabrirla. Sin indicar, no cambia. */
  closed?: boolean
  /** Último día de plazo (AAAA-MM-DD); null para quitar la fecha. Sin indicar, no cambia. */
  endsAt?: string | null
}

export interface CampaignTermsInput {
  campaignId: string
  /** Dólares por 1.000 visitas; null para quitarlo. */
  payRate: number | null
  /** Visitas mínimas para que un vídeo cobre. */
  minViews: number | null
  /** Tope de dólares por vídeo. */
  maxPayout: number | null
}

/** Condiciones de pago de una campaña, puestas o corregidas a mano. */
export function setCampaignTerms(db: DB, input: CampaignTermsInput): void {
  if (!input || typeof input.campaignId !== 'string') throw new Error('Campaña no válida.')
  if (!db.prepare('SELECT 1 FROM campaigns WHERE campaign_id = ?').get(input.campaignId)) throw new Error('La campaña no existe.')
  const n = (v: unknown, max: number, entero = false): number | null => {
    if (v == null) return null
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max || (entero && !Number.isInteger(v))) throw new Error('Cantidad no válida.')
    return v
  }
  db.prepare('UPDATE campaigns SET pay_rate = ?, min_views = ?, max_payout = ? WHERE campaign_id = ?')
    .run(n(input.payRate, 1000), n(input.minViews, 1e9, true), n(input.maxPayout, 1e7), input.campaignId)
}

export function setCampaignStatus(db: DB, input: CampaignStatusInput, now: () => string = () => new Date().toISOString()): void {
  if (!input || typeof input.campaignId !== 'string') throw new Error('Campaña no válida.')
  const existe = db.prepare('SELECT 1 FROM campaigns WHERE campaign_id = ?').get(input.campaignId)
  if (!existe) throw new Error('La campaña no existe.')
  if (input.endsAt !== undefined) {
    if (input.endsAt !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(input.endsAt) || Number.isNaN(Date.parse(input.endsAt + 'T00:00:00Z')))) {
      throw new Error('Fecha no válida.')
    }
    db.prepare('UPDATE campaigns SET ends_at = ? WHERE campaign_id = ?').run(input.endsAt, input.campaignId)
  }
  if (input.closed !== undefined) {
    db.prepare('UPDATE campaigns SET closed = ?, closed_at = ? WHERE campaign_id = ?').run(input.closed ? 1 : 0, input.closed ? now() : null, input.campaignId)
    // reabierta (a mano o por Vyro): olvida que la cerró Vyro, para no reabrir luego un cierre hecho a mano
    if (!input.closed) db.prepare("DELETE FROM settings WHERE key = 'vyro_cerro:' || ?").run(input.campaignId)
  }
}
