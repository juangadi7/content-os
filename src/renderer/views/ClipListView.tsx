import { Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AccountView, CampaignView, ClipView, RawInfo } from '../../core/api'
import { PLATFORM_LABEL } from '../../core/format'
import { filterClips, formatBytes, formatCount, type ClipFilter } from '../../core/format'
import { formatMoney } from '../../core/money'
import { RawModal } from '../components/RawModal'
import { TermsModal } from '../components/TermsModal'
import { ClipTable } from '../components/ClipTable'
import { Empty } from '../components/Common'
import { campaignState } from './CampaignsView'

const FILTROS: [ClipFilter, string][] = [
  ['all', 'Todos'],
  ['top5', 'Top 5'],
  ['published', 'Publicados'],
  ['pending', 'Pendientes']
]

/**
 * Lista de clips en orden de calidad. Sirve para una campaña (con filtros), para "Todos los
 * clips" y para "Pendientes" (filtro fijo).
 */
export function ClipListView(props: {
  campaign: CampaignView | null
  /** Sin campaña: 'all' o 'pending'. */
  scope: 'campaign' | 'all' | 'pending'
  filter: ClipFilter
  search: string
  refresh: number
  syncing: boolean
  onFilter: (f: ClipFilter, search: string) => void
  onOpen: (clipId: string) => void
  onBack?: () => void
  onSync: () => void
  onStatus?: (cambio: { closed?: boolean; endsAt?: string | null }) => void
  onTerms?: (t: { payRate: number | null; minViews: number | null; maxPayout: number | null }) => Promise<void>
  /** Canales de publicación y cómo asignarles esta campaña. */
  accounts?: AccountView[]
  onAccounts?: (accountIds: number[]) => void
  /** Manda la carpeta de la campaña a la Papelera (lo pide el usuario con su botón). */
  onTrash?: () => Promise<void>
}) {
  const { campaign, scope } = props
  const [clips, setClips] = useState<ClipView[] | null>(null)
  const [raw, setRaw] = useState<RawInfo | null>(null)
  const [rawOpen, setRawOpen] = useState(false)
  const [rawTick, setRawTick] = useState(0)
  const [terms, setTerms] = useState(false)
  const [papelera, setPapelera] = useState<'no' | 'confirmar' | 'enviando'>('no')
  const [errorPapelera, setErrorPapelera] = useState<string | null>(null)
  const campaignId = scope === 'campaign' ? campaign?.campaignId ?? null : null

  useEffect(() => {
    let vivo = true
    void window.contentOS.listClips(campaignId).then((l) => vivo && setClips(l))
    return () => {
      vivo = false
    }
  }, [campaignId, props.refresh])

  useEffect(() => {
    let vivo = true
    setRaw(null)
    if (campaignId) void window.contentOS.getRawFiles(campaignId).then((r) => vivo && setRaw(r)).catch(() => undefined)
    return () => {
      vivo = false
    }
  }, [campaignId, rawTick])

  const filtro: ClipFilter = scope === 'pending' ? 'pending' : props.filter
  const visibles = useMemo(() => (clips ? filterClips(clips, filtro, props.search) : []), [clips, filtro, props.search])
  const titulo = scope === 'campaign' ? campaign?.displayName ?? 'Campaña' : scope === 'pending' ? 'Pendientes' : 'Todos los clips'
  const total = clips?.filter((k) => k.presentInSource).length ?? 0

  return (
    <>
      {props.onBack && <button className="back" data-test="back" onClick={props.onBack}>← Campañas</button>}
      <div className="head">
        <h1 data-test="list-title">{titulo}</h1>
        <span className="muted" data-test="list-count">
          {scope === 'pending' ? `${visibles.length} sin publicar` : `${total} ${total === 1 ? 'clip' : 'clips'}`}
        </span>
        {campaign && scope === 'campaign' && campaignState(campaign)[1] !== 'muted' && <span className={campaignState(campaign)[1]}>{campaignState(campaign)[0]}</span>}
        <span className="sp" />
        {scope === 'campaign' && (
          <button className="btn" disabled={props.syncing} onClick={props.onSync}>{props.syncing ? 'Sincronizando…' : 'Sincronizar'}</button>
        )}
      </div>
      {scope === 'campaign' && campaign && props.onStatus && (
        <div className="plazo" data-test="campaign-status">
          {campaign.closed ? (
            <>
              <span className="faint">Campaña cerrada{campaign.endsAt ? ` · terminó el ${new Date(campaign.endsAt + 'T12:00:00').toLocaleDateString('es-ES')}` : ''}. Sus clips no cuentan como pendientes.</span>
              <button className="btn small" data-test="reopen-campaign" onClick={() => props.onStatus!({ closed: false, endsAt: null })}>Reabrir</button>
            </>
          ) : (
            <>
              <label className="muted" htmlFor="fin">Último día de plazo</label>
              <input id="fin" type="date" data-test="campaign-ends" value={campaign.endsAt ?? ''} onChange={(e) => props.onStatus!({ endsAt: e.target.value || null })} />
              {campaign.daysLeft != null && <span className={campaign.daysLeft <= 3 ? 'warn' : 'muted'}>{campaign.daysLeft === 1 ? 'último día' : `quedan ${campaign.daysLeft} días`}</span>}
              <span className="sp" />
              <button className="btn small" data-test="close-campaign" onClick={() => props.onStatus!({ closed: true })}>Marcar como cerrada</button>
            </>
          )}
        </div>
      )}
      {scope === 'campaign' && campaign && props.onTerms && (
        <div className="plazo" data-test="terms-bar">
          <span className="muted">
            {campaign.payRate == null
              ? 'Pago: sin datos (no se puede estimar lo ganado)'
              : `Pago: ${formatMoney(campaign.payRate)} por 1.000 visitas${campaign.minViews != null ? ` · mínimo ${formatCount(campaign.minViews)} visitas` : ''}${campaign.maxPayout != null ? ` · tope ${formatMoney(campaign.maxPayout)} por vídeo` : ''}`}
          </span>
          <span className="sp" />
          <button className="btn small" data-test="terms-open" onClick={() => setTerms(true)}>Condiciones…</button>
        </div>
      )}
      {scope === 'campaign' && campaign && props.onAccounts && (props.accounts?.length ?? 0) > 0 && (() => {
        const mios = props.accounts!.filter((a) => a.campaignIds.includes(campaign.campaignId)).map((a) => a.id)
        return (
          <div className="plazo" data-test="campaign-accounts" style={{ flexWrap: 'wrap' }}>
            <span className="muted">Canales:</span>
            {props.accounts!.map((a) => (
              <label key={a.id} className={`chip ${mios.includes(a.id) ? 'on' : ''}`} data-test="campaign-account" data-account={a.name}>
                <input type="checkbox" checked={mios.includes(a.id)}
                  onChange={(e) => props.onAccounts!(e.target.checked ? [...mios, a.id] : mios.filter((i) => i !== a.id))} />
                {PLATFORM_LABEL[a.platform]} · {a.name}
              </label>
            ))}
            <span className="faint small">{campaign.closed && mios.length ? 'Campaña cerrada: esta asignación ya no cuenta y esos canales vuelven a recibir las demás campañas.' : mios.length ? 'El plan de Hoy solo propone esta campaña a los canales marcados.' : 'Sin asignar: va a los canales que no tienen campañas propias.'}</span>
          </div>
        )
      })()}
      {scope === 'campaign' && campaign && campaign.checklist.length > 0 && (
        <details className="reglas" data-test="campaign-checklist" open>
          <summary>Al publicar · {campaign.checklist.length} reglas de la campaña</summary>
          <ul>{campaign.checklist.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
      )}
      {terms && campaign && props.onTerms && <TermsModal campaign={campaign} onSave={props.onTerms} onClose={() => setTerms(false)} />}
      {scope === 'campaign' && campaign && raw && raw.totalBytes > 0 && (
        <div className="plazo" data-test="raw-bar">
          <span className="muted">Material en bruto: {raw.files.length} {raw.files.length === 1 ? 'vídeo' : 'vídeos'} · {formatBytes(raw.totalBytes)}</span>
          <span className="sp" />
          <button className="btn small" data-test="raw-open" onClick={() => setRawOpen(true)}>Liberar espacio…</button>
        </div>
      )}
      {scope === 'campaign' && campaign && props.onTrash && campaign.presentInSource && (
        <div className={`plazo trashbar ${papelera !== 'no' ? 'on' : ''}`} data-test="trash-campaign-bar">
          <Trash2 size={15} className="faint" />
          {papelera === 'no' ? (
            <span className="muted">Borrar los clips de esta campaña: su carpeta entera (clips y material) va a la Papelera de Windows. Lo publicado y sus cifras se quedan aquí.</span>
          ) : (
            <span className={campaign.closed ? 'muted' : 'warn'}>
              {campaign.closed ? '' : `Ojo: la campaña sigue activa${campaign.daysLeft != null ? ` (${campaign.daysLeft === 1 ? 'último día' : `quedan ${campaign.daysLeft} días`})` : ''}. `}
              Se van {total} {total === 1 ? 'clip' : 'clips'} a la Papelera (se pueden recuperar desde ella). ¿Seguro?
            </span>
          )}
          <span className="sp" />
          {papelera === 'no' ? (
            <button className="btn small danger" data-test="trash-campaign" onClick={() => { setErrorPapelera(null); setPapelera('confirmar') }}>Enviar a la Papelera…</button>
          ) : (
            <>
              <button className="btn small" data-test="trash-campaign-cancel" disabled={papelera === 'enviando'} onClick={() => setPapelera('no')}>Cancelar</button>
              <button className="btn small danger" data-test="trash-campaign-confirm" disabled={papelera === 'enviando'} onClick={async () => {
                setPapelera('enviando')
                try {
                  await props.onTrash!()
                } catch (e) {
                  setErrorPapelera(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
                  setPapelera('no')
                }
              }}>{papelera === 'enviando' ? 'Enviando…' : 'Sí, a la Papelera'}</button>
            </>
          )}
        </div>
      )}
      {errorPapelera && <p className="bad" data-test="trash-campaign-error" style={{ margin: '-6px 0 14px' }}>{errorPapelera}</p>}
      {rawOpen && campaign && raw && (
        <RawModal campaign={campaign} info={raw} onDone={() => setRawTick((n) => n + 1)} onClose={() => { setRawOpen(false); setRawTick((n) => n + 1) }} />
      )}
      <div className="tools">
        {scope !== 'pending' && (
          <div className="seg">
            {FILTROS.map(([id, label]) => (
              <button key={id} className={props.filter === id ? 'on' : ''} data-test={`filter-${id}`} onClick={() => props.onFilter(id, props.search)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <input className="search" data-test="search" placeholder="Buscar por título" value={props.search} onChange={(e) => props.onFilter(props.filter, e.target.value)} />
      </div>

      {clips === null ? null : clips.length === 0 ? (
        <Empty title={scope === 'campaign' ? 'Esta campaña no tiene clips' : 'Todavía no hay clips'} test="empty-no-clips">
          <p>{campaign?.state === 'generating' ? 'El generador está trabajando en ella. Sincroniza cuando termine.' : 'Cuando el generador termine una campaña, sincroniza para verla aquí.'}</p>
        </Empty>
      ) : visibles.length === 0 ? (
        props.search.trim() ? (
          <Empty title="Ningún clip coincide con la búsqueda" test="empty-search">
            <button className="btn" onClick={() => props.onFilter(props.filter, '')}>Quitar búsqueda</button>
          </Empty>
        ) : filtro === 'published' ? (
          <Empty title="Aún no has publicado ningún clip de esta lista" test="empty-published"><p>Los que subes a YouTube con el título que te da la app se marcan solos al sincronizar, con su canal. Para TikTok o Instagram, abre el clip y pulsa «Marcar publicado».</p></Empty>
        ) : (
          <Empty title="No queda nada pendiente" test="empty-pending"><p>Todos los clips de esta lista están publicados.</p></Empty>
        )
      ) : (
        <ClipTable clips={visibles} onOpen={props.onOpen} showCampaign={scope !== 'campaign'} />
      )}
    </>
  )
}
