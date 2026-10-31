import { useState } from 'react'
import type { CampaignView, RawInfo, RawRemoval } from '../../core/api'
import { formatBytes } from '../../core/format'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Borrar los vídeos originales de una campaña. Siempre a petición y con confirmación del usuario. */
export function RawModal(props: { campaign: CampaignView; info: RawInfo; onDone: () => void; onClose: () => void }) {
  const { campaign, info } = props
  const [busy, setBusy] = useState(false)
  const [definitivo, setDefinitivo] = useState(false)
  const [resultado, setResultado] = useState<RawRemoval | null>(null)
  const [modo, setModo] = useState<'trash' | 'permanent'>('trash')
  const [error, setError] = useState<string | null>(null)
  const sinClips = campaign.clips === 0 || campaign.clipsMissingFile === campaign.clips
  const otros = info.files.flatMap((f) => f.otherNames)
  const conOtros = info.files.filter((f) => f.otherNames.length > 0).length

  const borrar = async (m: 'trash' | 'permanent') => {
    setBusy(true)
    setError(null)
    setModo(m)
    try {
      setResultado(await window.contentOS.deleteRawFiles(campaign.campaignId, m))
      props.onDone()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && !busy && props.onClose()}>
      <div className="modal" data-test="raw-modal" style={{ width: 600 }}>
        <h2>Material en bruto · {campaign.displayName}</h2>
        {resultado ? (
          <>
            <p className={resultado.failed.length ? 'warn' : 'ok'} data-test="raw-result">
              {resultado.removed.length} {resultado.removed.length === 1 ? 'archivo' : 'archivos'} {modo === 'trash' ? 'enviados a la Papelera' : 'borrados'} · {formatBytes(resultado.freedBytes)}
              {modo === 'trash' ? ' que se liberarán cuando vacíes la Papelera' : ' liberados'}.
            </p>
            {resultado.failed.map((f) => (
              <p className="bad small" key={f.path}>No se pudo quitar {f.path}: {f.error}</p>
            ))}
            {modo === 'trash' && resultado.failed.length > 0 && (
              <p className="muted small" style={{ marginTop: 8 }}>Si Windows dice que el archivo es demasiado grande para la Papelera, usa «Borrar definitivamente».</p>
            )}
          </>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 10 }}>
              Son los vídeos originales de los que salieron los clips. Los clips terminados, sus fichas, publicaciones y estadísticas <strong>no se tocan</strong>.
            </p>
            <div className="rows" style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 12 }}>
              {info.files.map((f) => (
                <div className="row static" key={f.path} style={{ gridTemplateColumns: 'minmax(0, 1fr) 80px', padding: '6px 12px' }}>
                  <span className="ell2">
                    <span className="ell">{f.name}</span>
                    {f.otherNames.map((o) => <span className="faint small ell" key={o}>también en {o}</span>)}
                  </span>
                  <span className="num muted">{formatBytes(f.size)}</span>
                </div>
              ))}
            </div>
            <ul className="list-plain muted" style={{ marginBottom: 12 }}>
              <li>Sin el bruto no se podrá <strong>regenerar</strong> la campaña ni recuperar clips rechazados, salvo descargándolo otra vez.</li>
              {otros.length > 0 && (
                <li>
                  {conOtros === 1 ? 'Un vídeo está' : `${conOtros} vídeos están`} también en otra carpeta con otro nombre (es el mismo archivo, no una copia).
                  Para liberar el espacio se quitan <strong>todos sus nombres</strong>, incluidos los de Descargas.
                </li>
              )}
              {!campaign.closed && <li className="warn">Esta campaña sigue abierta. Lo prudente es esperar a que termine.</li>}
              {sinClips && <li className="bad">Esta campaña todavía no tiene clips terminados: no se puede borrar el bruto.</li>}
            </ul>
            {error && <p className="bad" style={{ marginBottom: 8 }}>{error}</p>}
          </>
        )}
        <div className="foot">
          {!resultado && !sinClips && !definitivo && (
            <button className="btn ghost danger" data-test="raw-permanent" disabled={busy} onClick={() => setDefinitivo(true)}>Borrar definitivamente…</button>
          )}
          {!resultado && definitivo && (
            <>
              <span className="bad">No se puede deshacer.</span>
              <button className="btn danger" data-test="raw-permanent-confirm" disabled={busy} onClick={() => borrar('permanent')}>
                {busy ? 'Borrando…' : `Sí, borrar ${formatBytes(info.totalBytes)}`}
              </button>
            </>
          )}
          <span className="sp" />
          <button className="btn ghost" data-test="raw-close" disabled={busy} onClick={props.onClose}>{resultado ? 'Cerrar' : 'Cancelar'}</button>
          {!resultado && !sinClips && !definitivo && (
            <button className="btn primary" data-test="raw-trash" disabled={busy} onClick={() => borrar('trash')}>
              {busy ? 'Enviando…' : `Enviar a la Papelera (${formatBytes(info.totalBytes)})`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
