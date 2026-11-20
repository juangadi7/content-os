import { useState } from 'react'
import type { OwnChannel, OwnChannelStats, OwnPlatform } from '../../core/api'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const RED_NOMBRE: Record<OwnPlatform, string> = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' }

/** Ventana para apuntar a mano las cifras de un vídeo en una red (lo que la API no da: retención, compartidos…). */
export function OwnStatsForm(props: {
  channel: OwnChannel
  video: string
  title: string
  platform?: OwnPlatform
  onDone: (s: OwnChannelStats) => void
  onClose: () => void
}) {
  const [red, setRed] = useState<OwnPlatform>(props.platform ?? 'tiktok')
  const [campos, setCampos] = useState({ url: '', views: '', likes: '', comments: '', shares: '', retention: '', viewedPct: '', avgViewS: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const campo = (k: keyof typeof campos, etiqueta: string, ayuda?: string) => (
    <label className="field">
      <span>{etiqueta}</span>
      <input value={campos[k]} inputMode={k === 'url' ? 'url' : 'decimal'} placeholder={ayuda} data-test={`ownstats-${k}`}
        onChange={(e) => { setCampos({ ...campos, [k]: e.target.value }); setError(null) }} />
    </label>
  )
  const guardar = async () => {
    setBusy(true)
    try {
      props.onDone(await window.contentOS.addOwnStats({ channel: props.channel, video: props.video, platform: red, ...campos }))
      props.onClose()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal glass ownform" data-test="ownstats-modal">
        <h2>Apuntar cifras</h2>
        <p className="muted small">{props.title}</p>
        <div className="seg redes">
          {(['tiktok', 'youtube', 'instagram'] as OwnPlatform[]).map((p) => (
            <button key={p} className={red === p ? 'on' : ''} onClick={() => setRed(p)}>{RED_NOMBRE[p]}</button>
          ))}
        </div>
        <p className="faint small">Cópialas de {red === 'tiktok' ? 'TikTok Studio' : red === 'youtube' ? 'YouTube Studio' : 'las estadísticas del reel'}. Deja en blanco lo que no sepas: no cuenta como cero.</p>
        <div className="fgrid">
          {campo('views', 'Visitas', '12.400')}
          {campo('likes', 'Likes', '830')}
          {campo('comments', 'Comentarios', '41')}
          {campo('shares', 'Compartidos', '95')}
          {campo('retention', 'Retención media (%)', '72')}
          {red === 'youtube' && campo('viewedPct', 'Vieron vs. deslizaron (%)', '82')}
          {red === 'youtube' && campo('avgViewS', 'Duración media vista (s)', '0:23')}
        </div>
        {campo('url', red === 'youtube' ? 'Enlace del Short (para que la fábrica lo reconozca)' : 'Enlace del vídeo (opcional)', 'https://…')}
        {red === 'youtube' && props.channel === 'curio' && <p className="faint small">Se guarda también para la fábrica de Curiosidades (fabrica/datos/youtube_manual.json). Si el Short aún no está emparejado con YouTube, pega su enlace.</p>}
        {error && <p className="bad small" data-test="ownstats-error">{error}</p>}
        <div className="foot">
          <span className="sp" />
          <button className="btn ghost" onClick={props.onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy} data-test="ownstats-save" onClick={() => void guardar()}>Guardar</button>
        </div>
      </div>
    </div>
  )
}
