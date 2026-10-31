import { CircleCheck, Clock, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { thumbUrl, type AppState, type CampaignView } from '../../core/api'
import { scoreLabel } from '../../core/format'
import { Empty } from '../components/Common'

const ESTADO: Record<string, [string, string]> = {
  ok: ['Correcta', 'muted'],
  generating: ['Generándose', 'warn'],
  empty: ['Sin clips', 'muted'],
  clips_empty: ['Sin vídeos', 'warn'],
  unreadable: ['No se puede leer', 'bad']
}

export function campaignState(c: CampaignView): [string, string] {
  // apuntada como enviada pero con la carpeta de vuelta en la biblioteca (restaurada): cuenta la carpeta
  if (c.purgedAt && !c.presentInSource) return ['En la Papelera', 'faint']
  if (!c.presentInSource) return ['Retirada de la biblioteca', 'warn']
  if (c.closed) return ['Cerrada', 'faint']
  return ESTADO[c.state] ?? [c.state, 'muted']
}

const dia = (d: string) => new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
const dinero = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Portada vertical de un clip; si no carga, un hueco oscuro (sin romper el mosaico). */
function Portada({ clipId, version }: { clipId: string; version: number | null }) {
  const [rota, setRota] = useState(false)
  return rota ? <span className="ccamp-hole" /> : <img src={thumbUrl(clipId, version)} alt="" loading="lazy" onError={() => setRota(true)} />
}

export function CampaignsView(props: { state: AppState; syncing: boolean; onOpen: (campaignId: string) => void; onSync: () => void; onAddLibrary: () => void }) {
  const { state } = props
  const sinBiblioteca = state.configuredRoots.length === 0
  const abiertas = state.campaigns.filter((c) => !c.closed)
  const cerradas = state.campaigns.filter((c) => c.closed)
  const tarjeta = (c: CampaignView) => {
    const [estado, clase] = campaignState(c)
    const problema = c.closed ? null : c.state !== 'ok' || !c.presentInSource ? estado : null
    const pct = c.clips ? Math.round((c.clipsPublished / c.clips) * 100) : 0
    const plazo = c.closed ? 'Terminada' : c.daysLeft == null ? 'Sin plazo' : c.daysLeft === 1 ? 'Último día' : `Quedan ${c.daysLeft} días`
    const tono = c.closed ? 'closed' : c.daysLeft == null ? '' : c.daysLeft <= 1 ? 'bad' : c.daysLeft <= 3 ? 'warn' : 'ok'
    return (
      <button key={c.campaignId} className={`ccamp ${c.closed ? 'closed' : ''}`} data-test="campaign-card" data-closed={c.closed ? '1' : '0'} data-campaign={c.campaignId}
        onClick={() => props.onOpen(c.campaignId)} title={c.displayName}>
        <div className={`ccamp-cover n${c.covers.length}`}>
          {c.covers.length ? c.covers.map((k) => <Portada key={k.clipId} clipId={k.clipId} version={k.thumbVersion} />) : <div className="ccamp-ph">{(c.displayName.trim()[0] ?? '?').toUpperCase()}</div>}
          {(c.closed || c.daysLeft != null) && (
            <span className={`ccamp-pill ${tono}`} {...(!c.closed && c.daysLeft != null ? { 'data-test': 'days-left' } : {})}>
            {c.closed ? <CircleCheck size={12} /> : <Clock size={12} />}{plazo}
          </span>
          )}
          {c.payRate != null && <span className="ccamp-pay" title="Pago por cada 1.000 visitas">{dinero(c.payRate)} / 1K</span>}
        </div>
        <div className="ccamp-body">
          <h3>{c.displayName}</h3>
          <div className="ccamp-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
          <div className="ccamp-row">
            <span><b>{c.clipsPublished}</b> de {c.clips} publicados</span>
            {c.bestScore != null && <span className="ccamp-score" title="Puntuación del mejor clip">★ {scoreLabel(c.bestScore)}</span>}
          </div>
          {problema && <div className={`ccamp-note ${clase}`}><TriangleAlert size={12} />{problema}</div>}
          {!c.closed && c.clipsMissingFile > 0 && <div className="ccamp-note bad"><TriangleAlert size={12} />{c.clipsMissingFile} sin archivo</div>}
          {c.closed && (
            <div className="ccamp-note faint" title="Una semana después de acabar, la carpeta de la campaña va a la Papelera de Windows. Sus cifras y publicaciones se quedan aquí.">
              <Trash2 size={12} />
              <span data-test="purge-on">{c.purgedAt && !c.presentInSource ? `Enviada el ${dia(c.purgedAt)}` : c.purgeOn ? `El ${dia(c.purgeOn)}` : 'Sin fecha de fin: no se borra'}</span>
            </div>
          )}
        </div>
      </button>
    )
  }
  return (
    <>
      <div className="head">
        <h1>Campañas</h1>
        <span className="muted">{state.campaigns.length}</span>
      </div>
      {state.configError && <p className="bad" style={{ marginBottom: 12 }}>{state.configError}</p>}
      {state.campaigns.length === 0 && sinBiblioteca && (
        <Empty title="Todavía no hay ninguna biblioteca" test="empty-no-library">
          <p>Elige la carpeta donde el generador guarda las campañas (la carpeta CAMPAIGNS).</p>
          <button className="btn primary" onClick={props.onAddLibrary}>Elegir carpeta…</button>
          <p className="faint mono" style={{ marginTop: 14 }}>{state.configPath}</p>
        </Empty>
      )}
      {state.campaigns.length === 0 && !sinBiblioteca && (
        <Empty title={props.syncing ? 'Leyendo la biblioteca…' : 'Sin campañas'} test="empty-no-campaigns">
          {!props.syncing && (
            <>
              <p>No se ha encontrado ninguna campaña importable en la biblioteca.</p>
              <button className="btn" onClick={props.onSync}>Sincronizar</button>
            </>
          )}
        </Empty>
      )}
      {abiertas.length > 0 && (
        <>
          {cerradas.length > 0 && <h2 className="ccamp-sec">Activas <span>{abiertas.length}</span></h2>}
          <div className="ccamp-grid">{abiertas.map((c) => tarjeta(c))}</div>
        </>
      )}
      {cerradas.length > 0 && (
        <>
          <h2 className="ccamp-sec">Terminadas <span>{cerradas.length}</span></h2>
          <div className="ccamp-grid small">{cerradas.map((c) => tarjeta(c))}</div>
        </>
      )}
    </>
  )
}
