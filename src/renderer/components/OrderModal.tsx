import { useState } from 'react'
import type { VyroCampaignView, VyroView } from '../../core/api'
import { formatBytes } from '../../core/format'
import { useCopy } from './Common'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * «Hacer esta campaña»: reúne en un pedido las reglas de Vyro, tus notas y el material que descargues,
 * y deja listo el encargo para Claude. La aplicación no se une a la campaña ni genera clips.
 */
export function OrderModal(props: { campaign: VyroCampaignView; onData: (v: VyroView) => void; onClose: () => void }) {
  const c = props.campaign
  const pedido = c.order
  const [notas, setNotas] = useState(pedido?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [anular, setAnular] = useState(false)
  const [copiado, copiar] = useCopy()

  const hacer = async (f: () => Promise<VyroView>, cerrar = false) => {
    setBusy(true)
    setError(null)
    try {
      props.onData(await f())
      if (cerrar) props.onClose()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const material = c.materialLinks[0]
  const presentes = pedido?.files.filter((f) => f.exists) ?? []

  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && !busy && props.onClose()}>
      <div className="modal" data-test="order-modal" style={{ width: 780 }}>
        <h2>{pedido ? 'Pedido' : 'Hacer esta campaña'} · {c.name}</h2>

        {!pedido ? (
          <>
            <ol className="list-plain muted" style={{ marginBottom: 12 }}>
              <li><strong>Únete a la campaña en Vyro</strong> (solo tú puedes aceptar sus condiciones). <a className="ext" href={c.url} target="_blank" rel="noreferrer">Abrir en Vyro</a></li>
              <li>Al crear el pedido {material ? <>se abre <strong>el material</strong> en tu navegador: pulsa «Descargar» allí.</> : <>descarga el material desde Vyro (esta campaña no publica el enlace).</>} La aplicación apunta sola los vídeos que lleguen a Descargas.</li>
              <li>Cuando esté todo, copia el encargo y pégaselo a Claude: preparará los clips y la campaña aparecerá aquí sola.</li>
            </ol>
            <div className="field">
              <label>Reglas que no son públicas (pega aquí el texto de Vyro: descripción obligatoria, tope por vídeo, prohibiciones…)</label>
              <textarea data-test="order-notes" rows={6} value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Opcional, pero evita que Claude tenga que preguntártelo." />
            </div>
          </>
        ) : (
          <>
            <p className={pedido.status === 'ready' ? 'ok' : 'warn'} data-test="order-status" style={{ marginBottom: 10 }}>
              {pedido.status === 'ready' ? 'Material completo. Copia el encargo y pégaselo a Claude.' : presentes.length ? 'Recibiendo material. Cuando esté todo, pulsa «Material completo».' : 'Esperando material: pulsa «Descargar» en la página que se abrió.'}
              {material && <> <a className="ext" href={material} target="_blank" rel="noreferrer">Abrir material</a></>}
            </p>
            {pedido.files.length > 0 && (
              <div className="rows" style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 12 }}>
                {pedido.files.map((f) => (
                  <div className="row static" key={f.path} data-test="order-file" style={{ gridTemplateColumns: 'minmax(0, 1fr) 80px auto', padding: '6px 12px' }}>
                    <span className="ell2">
                      <span className="ell">{f.name}</span>
                      {!f.exists && <span className="bad small">Ya no está en Descargas</span>}
                      {f.kind === 'zip' && f.exists && <span className="faint small">Comprimido: Claude lo descomprimirá</span>}
                    </span>
                    <span className="num muted">{f.exists ? formatBytes(f.size) : '—'}</span>
                    <button className="btn small ghost" disabled={busy} title="No es de esta campaña (el archivo no se borra)" onClick={() => void hacer(() => window.contentOS.orderUpdate(c.vyroId, { removeFile: f.path }))}>Quitar</button>
                  </div>
                ))}
              </div>
            )}
            <div className="field">
              <label>Reglas que no son públicas</label>
              <textarea data-test="order-notes" rows={4} value={notas} onChange={(e) => setNotas(e.target.value)}
                onBlur={() => notas.trim() !== (pedido.notes ?? '') && void hacer(() => window.contentOS.orderUpdate(c.vyroId, { notes: notas }))} />
            </div>
            <div className="box mono" data-test="order-prompt" style={{ marginBottom: 6 }}>{pedido.prompt}</div>
            <p className="faint small">Pega esa frase en tu conversación con Claude. El pedido lleva las reglas leídas de Vyro, tus notas y la lista de vídeos.</p>
          </>
        )}

        {error && <p className="bad" data-test="order-error" style={{ marginTop: 8 }}>{error}</p>}
        <div className="foot">
          {pedido && !anular && <button className="btn ghost danger" disabled={busy} onClick={() => setAnular(true)}>Anular pedido</button>}
          {pedido && anular && (
            <>
              <span className="muted">Los vídeos descargados no se borran.</span>
              <button className="btn danger" data-test="order-cancel" disabled={busy} onClick={() => void hacer(() => window.contentOS.orderCancel(c.vyroId), true)}>Sí, anular</button>
            </>
          )}
          <span className="sp" />
          {copiado === 'encargo' && <span className="copied" data-test="order-copied">Copiado</span>}
          <button className="btn ghost" data-test="order-close" disabled={busy} onClick={props.onClose}>Cerrar</button>
          {!pedido && (
            <button className="btn primary" data-test="order-create" disabled={busy} onClick={() => void hacer(() => window.contentOS.orderCreate(c.vyroId, notas))}>
              {material ? 'Crear pedido y abrir material' : 'Crear pedido'}
            </button>
          )}
          {pedido && !anular && (
            <>
              <button className="btn" disabled={busy} onClick={() => void window.contentOS.showOrderFolder(c.vyroId)}>Abrir carpeta</button>
              {pedido.status === 'waiting'
                ? <button className="btn" data-test="order-ready" disabled={busy || presentes.length === 0} onClick={() => void hacer(() => window.contentOS.orderUpdate(c.vyroId, { status: 'ready', notes: notas }))}>Material completo</button>
                : <button className="btn" disabled={busy} onClick={() => void hacer(() => window.contentOS.orderUpdate(c.vyroId, { status: 'waiting' }))}>Falta material</button>}
              <button className="btn primary" data-test="order-copy" disabled={busy} onClick={() => void copiar('encargo', pedido.prompt)}>Copiar encargo</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
