import { useState } from 'react'
import type { AppState, YouTubeRefreshResult } from '../../core/api'
import { relativeTime } from '../../core/format'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function refreshText(r: YouTubeRefreshResult): string {
  const medidos = r.channels.measured + r.byUrl.measured
  const partes = [`${medidos} ${medidos === 1 ? 'vídeo medido' : 'vídeos medidos'}`]
  if (r.channels.linkedNow) partes.push(`${r.channels.linkedNow} ${r.channels.linkedNow === 1 ? 'emparejado nuevo' : 'emparejados nuevos'}`)
  if (r.channels.unmatched) partes.push(`${r.channels.unmatched} sin emparejar`)
  if (r.byUrl.notFound) partes.push(`${r.byUrl.notFound} que YouTube no encuentra`)
  return partes.join(' · ')
}

/** Conectar YouTube (clave de API), decir cuáles son tus canales y pedir las cifras a mano. */
export function YouTubeModal(props: { state: AppState; onState: (s: AppState) => void; onRefreshed: () => void; onClose: () => void }) {
  const [clave, setClave] = useState('')
  const [canal, setCanal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const conectado = props.state.youtubeConnected
  const canales = props.state.youtubeChannels

  const hacer = async (f: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await f()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const actualizar = async () => {
    setInfo(refreshText(await window.contentOS.youtubeRefresh(true)))
    props.onRefreshed()
  }
  const conectar = () =>
    hacer(async () => {
      props.onState(await window.contentOS.youtubeConnect(clave))
      setClave('')
      setInfo('Clave comprobada y guardada.')
    })
  const añadirCanal = () =>
    hacer(async () => {
      props.onState(await window.contentOS.youtubeAddChannel(canal))
      setCanal('')
      await actualizar()
    })
  const quitarCanal = (id: string) => hacer(async () => props.onState(await window.contentOS.youtubeRemoveChannel(id)))
  const desconectar = () => hacer(async () => props.onState(await window.contentOS.youtubeDisconnect()))

  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" data-test="youtube-modal">
        <h2>YouTube</h2>
        {conectado ? (
          <>
            <p className="ok dot" data-test="youtube-connected">Conectado</p>

            <div className="block" style={{ marginTop: 16 }}>
              <div className="lbl"><span>Tus canales</span></div>
              <p className="muted" style={{ marginBottom: 8 }}>
                CONTENT OS mira los vídeos de estos canales, reconoce cuál corresponde a cada clip y lee sus cifras. No hace falta pegar la URL de cada vídeo.
              </p>
              {canales.map((c) => (
                <div className="pub" key={c.channelId} data-test="youtube-channel" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto', padding: '8px 0' }}>
                  <div className="ell">
                    <strong>{c.title ?? c.handle}</strong> <span className="muted">{c.handle}</span>
                    <div className="muted">{c.videos} vídeos · {c.linked} emparejados · revisado {relativeTime(c.lastScanAt)}</div>
                  </div>
                  <button className="btn small ghost danger" disabled={busy} onClick={() => quitarCanal(c.channelId)}>Quitar</button>
                </div>
              ))}
              <div className="two" style={{ gridTemplateColumns: '1fr auto', marginTop: 8 }}>
                <input className="search" style={{ width: '100%', margin: 0 }} data-test="youtube-channel-input" value={canal} onChange={(e) => setCanal(e.target.value)}
                  placeholder="@tucanal  o  https://www.youtube.com/@tucanal" spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && canal.trim() && añadirCanal()} />
                <button className="btn" data-test="youtube-channel-add" disabled={busy || canal.trim() === ''} onClick={añadirCanal}>Añadir canal</button>
              </div>
            </div>

            <button className="btn primary" data-test="youtube-refresh" disabled={busy} onClick={() => hacer(actualizar)}>
              {busy ? 'Pidiendo cifras…' : 'Actualizar cifras ahora'}
            </button>
            <p className="faint" style={{ marginTop: 8 }}>Con la app abierta se actualizan solas cada 15 minutos.</p>
          </>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 10 }}>
              Hace falta una clave de API de Google (gratuita). Solo sirve para leer cifras públicas: no da acceso a tu canal ni permite publicar.
            </p>
            <ol className="list-plain muted" style={{ marginBottom: 14 }}>
              <li>Entra en <a className="ext" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">console.cloud.google.com</a> y crea un proyecto.</li>
              <li>En «API y servicios → Biblioteca», activa <strong>YouTube Data API v3</strong>.</li>
              <li>En «API y servicios → Credenciales», pulsa «Crear credenciales → Clave de API».</li>
              <li>Recomendado: en la clave, restringe las API a «YouTube Data API v3».</li>
              <li>Pega la clave aquí.</li>
            </ol>
            <div className="field">
              <label>Clave de API</label>
              <input data-test="youtube-key" type="password" value={clave} onChange={(e) => setClave(e.target.value)} placeholder="AIza…" autoFocus spellCheck={false} />
            </div>
            <p className="faint">Se comprueba con YouTube y se guarda cifrada en este equipo. No se vuelve a mostrar.</p>
          </>
        )}
        {error && <p className="bad" data-test="youtube-error" style={{ marginTop: 10 }}>{error}</p>}
        {info && <p className="ok" data-test="youtube-info" style={{ marginTop: 10 }}>{info}</p>}
        <div className="foot">
          {conectado && <button className="btn ghost danger" disabled={busy} onClick={desconectar}>Desconectar</button>}
          <span className="sp" />
          <button className="btn ghost" data-test="youtube-close" onClick={props.onClose}>Cerrar</button>
          {!conectado && <button className="btn primary" data-test="youtube-save" disabled={busy || clave.trim() === ''} onClick={conectar}>{busy ? 'Comprobando…' : 'Conectar'}</button>}
        </div>
      </div>
    </div>
  )
}
