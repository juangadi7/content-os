import { useState } from 'react'
import type { CampaignView } from '../../core/api'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const aTexto = (n: number | null) => (n == null ? '' : String(n).replace('.', ','))
/** "" -> null; "1,5" -> 1.5; lo demás -> NaN */
const aNumero = (t: string): number | null => (t.trim() === '' ? null : Number(t.trim().replace(/\./g, '').replace(',', '.')))

/** Condiciones de pago de la campaña: con ellas se estima lo ganado. */
export function TermsModal(props: { campaign: CampaignView; onSave: (t: { payRate: number | null; minViews: number | null; maxPayout: number | null }) => Promise<void>; onClose: () => void }) {
  const c = props.campaign
  const [pago, setPago] = useState(aTexto(c.payRate))
  const [minimo, setMinimo] = useState(aTexto(c.minViews))
  const [tope, setTope] = useState(aTexto(c.maxPayout))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const guardar = async () => {
    const t = { payRate: aNumero(pago), minViews: aNumero(minimo), maxPayout: aNumero(tope) }
    if (Object.values(t).some((v) => v != null && (!Number.isFinite(v) || v < 0))) return setError('Escribe solo números (por ejemplo 1,5).')
    setBusy(true)
    try {
      await props.onSave(t)
      props.onClose()
    } catch (e) {
      setError(mensaje(e))
      setBusy(false)
    }
  }

  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" data-test="terms-modal" style={{ width: 460 }}>
        <h2>Condiciones de pago · {c.displayName}</h2>
        <div className="field">
          <label>Pago por cada 1.000 visitas (dólares)</label>
          <input data-test="t-rate" value={pago} onChange={(e) => setPago(e.target.value)} placeholder="1,5" autoFocus />
        </div>
        <div className="two">
          <div className="field">
            <label>Mínimo de visitas para cobrar</label>
            <input data-test="t-min" value={minimo} onChange={(e) => setMinimo(e.target.value)} placeholder="5000" />
          </div>
          <div className="field">
            <label>Tope por vídeo (dólares)</label>
            <input data-test="t-max" value={tope} onChange={(e) => setTope(e.target.value)} placeholder="1000" />
          </div>
        </div>
        <p className="faint small">El pago y el mínimo se rellenan solos desde Vyro si la campaña está enlazada. El tope por vídeo no es público: cópialo de las reglas de Vyro. Deja en blanco lo que no sepas.</p>
        {error && <p className="bad" style={{ marginTop: 8 }}>{error}</p>}
        <div className="foot">
          <span className="sp" />
          <button className="btn ghost" disabled={busy} onClick={props.onClose}>Cancelar</button>
          <button className="btn primary" data-test="t-save" disabled={busy} onClick={guardar}>Guardar</button>
        </div>
      </div>
    </div>
  )
}
