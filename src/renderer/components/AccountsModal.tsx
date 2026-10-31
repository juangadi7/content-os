import { useState } from 'react'
import type { AccountInput, AccountView, PlanView } from '../../core/api'
import { PLATFORM_LABEL, PLATFORMS, type Platform } from '../../core/format'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Canales en los que se publica y cuántos clips al día admite cada uno. */
export function AccountsModal(props: { accounts: AccountView[]; onPlan: (p: PlanView) => void; onClose: () => void }) {
  const [platform, setPlatform] = useState<Platform>('youtube')
  const [name, setName] = useState('')
  const [limit, setLimit] = useState(3)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const hacer = async (f: () => Promise<PlanView>, despues?: () => void) => {
    setBusy(true)
    setError(null)
    try {
      props.onPlan(await f())
      despues?.()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const guardar = (input: AccountInput) => hacer(() => window.contentOS.saveAccount(input))

  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" data-test="accounts-modal" style={{ width: 640 }}>
        <h2>Canales</h2>
        {props.accounts.length === 0 ? (
          <p className="muted" style={{ marginBottom: 12 }}>Todavía no hay ninguno.</p>
        ) : (
          <div className="rows" style={{ marginBottom: 14 }}>
            <div className="row hdr cols-acc"><span>Plataforma</span><span>Canal</span><span>Subidas al día</span><span>En el plan</span><span /></div>
            {props.accounts.map((a) => (
              <div className="row static cols-acc" key={a.id} data-test="account-row">
                <span>{PLATFORM_LABEL[a.platform]}</span>
                <span className="ell2">
                  <span className="ell">{a.name}</span>
                  <span className="faint small">{a.published} {a.published === 1 ? 'publicación' : 'publicaciones'}</span>
                </span>
                <span>
                  <input className="lim" type="number" min={1} max={20} value={a.dailyLimit} disabled={busy}
                    onChange={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 1 && v <= 20) void guardar({ id: a.id, dailyLimit: v }) }} />
                </span>
                <label className="muted">
                  <input type="checkbox" checked={a.active} disabled={busy} onChange={(e) => void guardar({ id: a.id, active: e.target.checked })} /> {a.active ? 'sí' : 'en pausa'}
                </label>
                <button className="btn small ghost danger" disabled={busy} onClick={() => void hacer(() => window.contentOS.removeAccount(a.id))}>Quitar</button>
              </div>
            ))}
          </div>
        )}

        <div className="lbl faint small" style={{ textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Añadir canal</div>
        <div style={{ display: 'grid', gridTemplateColumns: '130px minmax(0, 1fr) 110px auto', gap: 10, alignItems: 'end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Plataforma</label>
            <select data-test="acc-platform" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Nombre del canal</label>
            <input data-test="acc-name" value={name} placeholder="@canal" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Subidas al día</label>
            <input data-test="acc-limit" type="number" min={1} max={20} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
          </div>
          <button className="btn primary" data-test="acc-add" disabled={busy || !name.trim()} onClick={() => void hacer(() => window.contentOS.saveAccount({ platform, name, dailyLimit: limit }), () => setName(''))}>Añadir</button>
        </div>
        {error && <p className="bad" data-test="acc-error" style={{ marginTop: 10 }}>{error}</p>}
        <p className="faint small" style={{ marginTop: 12 }}>
          Quitar un canal solo lo saca del plan: sus publicaciones y estadísticas se conservan. Usa el mismo nombre que pones al marcar un clip como publicado.
        </p>
        <div className="foot">
          <span className="sp" />
          <button className="btn" data-test="acc-close" onClick={props.onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  )
}
