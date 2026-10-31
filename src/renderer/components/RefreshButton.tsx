import { RefreshCw } from 'lucide-react'
import { useState } from 'react'

/** «Actualizar»: vuelve a mirar YouTube (lo que ya has subido) y recalcula lo que toca. */
export function RefreshButton(props: { onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <button className="btn" data-test="refresh-plan" disabled={busy} title="Vuelve a mirar lo que ya has subido y recalcula lo que toca"
      onClick={async () => {
        setBusy(true)
        try {
          await props.onRefresh()
        } finally {
          setBusy(false)
        }
      }}>
      <RefreshCw size={14} className={busy ? 'spin' : ''} />{busy ? 'Actualizando…' : 'Actualizar'}
    </button>
  )
}
