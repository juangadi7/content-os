/**
 * Ganancia ESTIMADA de un vídeo según las condiciones de su campaña. Es una cuenta orientativa:
 * lo que paga de verdad lo decide Vyro (vídeo enviado y aprobado, visitas que él cuente, presupuesto).
 */
export interface PayTerms {
  /** Dólares por 1.000 visitas. */
  payRate: number | null
  /** Visitas mínimas para que el vídeo cobre. */
  minViews: number | null
  /** Tope de dólares por vídeo. */
  maxPayout: number | null
}

export type EarningState = 'no_terms' | 'unmeasured' | 'below_min' | 'earning' | 'capped'

export interface Earning {
  /** Dólares estimados; null si no se puede calcular. */
  amount: number | null
  state: EarningState
  /** Visitas que faltan para llegar al mínimo (solo en below_min). */
  missingViews: number | null
}

export function estimateEarning(views: number | null | undefined, t: PayTerms): Earning {
  if (t.payRate == null) return { amount: null, state: 'no_terms', missingViews: null }
  if (views == null) return { amount: null, state: 'unmeasured', missingViews: null }
  if (t.minViews != null && views < t.minViews) return { amount: 0, state: 'below_min', missingViews: t.minViews - views }
  const bruto = Math.round((views / 1000) * t.payRate * 100) / 100
  if (t.maxPayout != null && bruto >= t.maxPayout) return { amount: t.maxPayout, state: 'capped', missingViews: null }
  return { amount: bruto, state: 'earning', missingViews: null }
}

/** 12.5 -> "12,50 $" */
export function formatMoney(n: number | null | undefined): string {
  if (n == null) return '—'
  const [e, d] = (Math.round(n * 100) / 100).toFixed(2).split('.')
  return `${e.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d} $`
}
