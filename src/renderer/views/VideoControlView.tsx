import { EyeOff, Check, CircleAlert, CircleCheck, Clock, Copy, ExternalLink, HelpCircle, Play, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { thumbUrl, ytThumbUrl, type ControlVideo, type VideoControl, type VyroState } from '../../core/api'
import { formatCount, PLATFORM_LABEL, relativeTime } from '../../core/format'
import { formatMoney } from '../../core/money'
import { useCopy } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const cuando = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const ESTADO: Record<VyroState, { label: string; tone: string; icon: typeof Check }> = {
  duplicate: { label: 'Duplicado en YouTube', tone: 'bad', icon: TriangleAlert },
  not_found: { label: 'No está en tu canal', tone: 'warn', icon: HelpCircle },
  missing: { label: 'Falta en Vyro', tone: 'bad', icon: CircleAlert },
  manual: { label: 'Marcado como enviado, pero Vyro no lo tiene', tone: 'warn', icon: TriangleAlert },
  unchecked: { label: 'Sin comprobar en Vyro', tone: 'warn', icon: HelpCircle },
  scheduled: { label: 'Programado', tone: 'info', icon: Clock },
  in_vyro: { label: 'En Vyro', tone: 'ok', icon: CircleCheck },
  no_campaign: { label: 'Sin campaña de Vyro', tone: 'muted', icon: HelpCircle },
  ignored: { label: 'Ignorado', tone: 'muted', icon: EyeOff },
  expired: { label: 'No se envió · campaña cerrada', tone: 'muted', icon: Clock },
}
const FILTROS: [string, (v: ControlVideo) => boolean][] = [
  ['Atención', (v) => v.vyro.state === 'duplicate' || v.vyro.state === 'missing' || v.vyro.state === 'manual' || v.vyro.state === 'not_found' || v.vyro.state === 'unchecked'],
  ['Programados', (v) => v.vyro.state === 'scheduled'],
  ['En Vyro', (v) => v.vyro.state === 'in_vyro'],
  ['Sin campaña', (v) => v.vyro.state === 'no_campaign'],
  ['Cerradas', (v) => v.vyro.state === 'expired'],
  ['Ignorados', (v) => v.vyro.state === 'ignored'],
  ['Todos', () => true],
]
const VYRO_TXT: Record<string, string> = { pending: 'en revisión', active: 'aprobado', approved: 'aprobado', rejected: 'rechazado' }

/**
 * Cada vídeo que tienes subido o programado, con su estado en Vyro comparado con tus envíos reales.
 * Lo que falta en Vyro va arriba; si ya tiene visitas, avisa de que se están perdiendo.
 */
export function VideoControlView(props: { refresh: number; onOpenClip: (clipId: string) => void; onChanged: () => void; onCheckNow: () => Promise<void>; onVyro: () => void }) {
  const [data, setData] = useState<VideoControl | null>(null)
  const [filtro, setFiltro] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiado, copiar] = useCopy()
  const [vyroConectado, setVyroConectado] = useState(true)
  const [leyendo, setLeyendo] = useState(false)

  useEffect(() => {
    let vivo = true
    void window.contentOS.getVideoControl().then((d) => vivo && setData(d)).catch((e) => vivo && setError(mensaje(e)))
    void window.contentOS.getVyroAccount().then(async (c) => {
      if (!vivo) return
      setVyroConectado(c.connected)
      // si la última lectura de Vyro tiene más de 5 minutos, se vuelve a leer al entrar (para no dar avisos viejos)
      const vieja = !c.lastSyncAt || Date.now() - Date.parse(c.lastSyncAt) > 5 * 60_000
      if (c.connected && !c.syncing && vieja) {
        setLeyendo(true)
        try {
          await window.contentOS.vyroSyncSubmissions()
          if (vivo) setData(await window.contentOS.getVideoControl())
        } finally {
          if (vivo) setLeyendo(false)
        }
      }
    }).catch(() => undefined)
    return () => {
      vivo = false
    }
  }, [props.refresh])

  const visibles = useMemo(() => (data ? data.videos.filter(FILTROS[filtro][1]) : []), [data, filtro])
  if (!data) return null
  const atencion = data.counts.missing + data.counts.manual + data.counts.unchecked

  const hacer = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await f()
      setData(await window.contentOS.getVideoControl())
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Control de vídeos" titleTest="control-title"
        meta={<span data-test="control-summary">
          {leyendo && <span className="muted">Leyendo tus envíos de Vyro… · </span>}
          {atencion ? <strong className="bad">{atencion} {atencion === 1 ? 'necesita' : 'necesitan'} atención</strong> : <span className="ok">Todo lo publicado está en Vyro</span>}
          {` · ${data.counts.scheduled} programados · ${data.counts.in_vyro} en Vyro`}
        </span>}>
        <button className="btn" data-test="control-check" disabled={busy} title="Vuelve a mirar YouTube y tus envíos de Vyro" onClick={() => void hacer(props.onCheckNow)}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} />{busy ? 'Comprobando…' : 'Comprobar ahora'}
        </button>
      </PageHeader>
      {!vyroConectado && (
        <div className="banner warn" data-test="control-vyro-off"><TriangleAlert size={15} />
          <span>Tu cuenta de Vyro no está conectada: la app no puede confirmar qué está enviado. <button className="linklike" onClick={props.onVyro}>Conectar Vyro</button></span>
        </div>
      )}
      {error && <div className="banner bad"><span>{error}</span></div>}
      <div className="vc-filters">
        {FILTROS.map(([nombre, f], i) => {
          const n = data.videos.filter(f).length
          return <button key={nombre} className={`fchip ${filtro === i ? 'on' : ''}`} data-test="control-filter" onClick={() => setFiltro(i)}><span>{nombre}</span><i>{n}</i></button>
        })}
      </div>
      {visibles.length === 0 ? (
        <p className="muted vc-empty">{filtro === 0 ? 'Nada pendiente: todo lo publicado de campañas está en Vyro.' : 'No hay vídeos aquí.'}</p>
      ) : (
        <div className="vc-grid">
          {visibles.map((v) => {
            const E = ESTADO[v.vyro.state]
            const img = v.thumb ? (v.thumb.kind === 'clip' ? thumbUrl(v.thumb.clipId, v.thumb.version) : ytThumbUrl(v.thumb.videoId)) : null
            return (
              <article key={v.key} className={`vc-card t-${E.tone} ${v.urgent ? 'urgent' : ''}`} data-test="control-video" data-state={v.vyro.state}>
                <div className="vc-thumb">{img ? <img src={img} alt="" loading="lazy" /> : <Play size={22} />}</div>
                <div className="vc-body">
                  <div className="vc-top">
                    <span className={`vsend-pf ${v.platform}`}>{PLATFORM_LABEL[v.platform]}{v.account ? ` · ${v.account}` : ''}</span>
                    <span className="faint small">{v.scheduled ? 'Sale ' : 'Publicado '}{cuando(v.publishedAt)}</span>
                  </div>
                  <h3 title={v.title}>{v.clipId ? <button className="linklike" onClick={() => props.onOpenClip(v.clipId!)}>{v.title}</button> : v.title}</h3>
                  {v.description && <p className="vc-desc" title={v.description}>{v.description}</p>}
                  <div className="vc-meta">
                    {v.campaignName && <span>{v.campaignName}{v.campaignEnded ? ' · terminada' : ''}</span>}
                    {v.views != null && <span><b>{formatCount(v.views)}</b> visitas</span>}
                    {v.url && <a href={v.url} target="_blank" rel="noreferrer" className="vsend-url">{v.url.replace(/^https?:\/\/(www\.)?/, '')}</a>}
                  </div>
                  <div className="vc-status" data-test="control-status">
                    <E.icon size={16} />
                    <div className="vc-status-t">
                      <strong>{E.label}{v.vyro.state === 'in_vyro' && v.vyro.status ? ` · ${VYRO_TXT[v.vyro.status] ?? v.vyro.status}` : ''}</strong>
                      <span>
                        {v.vyro.state === 'missing' && (v.campaignEnded ? 'La campaña ya terminó: Vyro ya no lo acepta.' : v.urgent ? `¡Ya lleva ${formatCount(v.views)} visitas! Las de antes de enviarlo no se pagan: envíalo ya.` : 'Envíalo a Vyro («Add posts») cuanto antes.')}
                        {v.vyro.state === 'manual' && 'Lo marcaste como enviado, pero no aparece entre tus envíos de Vyro. Compruébalo en Vyro y vuelve a enviarlo si falta.'}
                        {v.vyro.state === 'unchecked' && (v.vyro.reason ?? 'Aún no se ha podido comprobar. Pulsa «Comprobar ahora».')}
                        {v.vyro.state === 'scheduled' && 'Cuando salga, envíalo a Vyro enseguida (la app te avisará).'}
                        {v.vyro.state === 'in_vyro' && <>{v.vyro.views != null && `${formatCount(v.vyro.views)} visitas que cuenta Vyro`}{v.vyro.earned ? ` · ${formatMoney(v.vyro.earned)}` : ''}{v.vyro.error ? ` · ${v.vyro.error}` : ''}</>}
                        {v.vyro.state === 'no_campaign' && (v.clipId ? 'Su campaña no es de Vyro.' : v.vyro.reason)}
                        {v.vyro.state === 'ignored' && 'No sale en «Atención». Si empieza a coger visitas, volverá a avisarte.'}
                        {v.vyro.state === 'expired' && v.vyro.reason}
                        {(v.vyro.state === 'duplicate' || v.vyro.state === 'not_found') && v.vyro.reason}
                        {v.vyro.checkedAt && v.vyro.state !== 'no_campaign' && v.vyro.state !== 'ignored' && v.vyro.state !== 'scheduled' && <em className="vc-checked"> · comprobado en Vyro {relativeTime(v.vyro.checkedAt)}</em>}
                      </span>
                    </div>
                    <span className="sp" />
                    {v.url && (v.vyro.state === 'missing' || v.vyro.state === 'manual' || v.vyro.state === 'unchecked' || v.vyro.state === 'no_campaign') && (
                      <button className="btn small" data-test="control-copy" onClick={() => void copiar(v.key, v.url!)}>
                        {copiado === v.key ? <Check size={13} /> : <Copy size={13} />}{copiado === v.key ? 'Copiado' : 'Copiar enlace'}
                      </button>
                    )}
                    {(v.vyro.state === 'missing' || v.vyro.state === 'manual' || v.vyro.state === 'unchecked' || v.vyro.state === 'no_campaign') && (
                      <button className="btn small ghost" data-test="control-ignore" disabled={busy} title="No lo vas a enviar a Vyro (p. ej. se quedó a cero): fuera de «Atención»"
                        onClick={() => void hacer(() => window.contentOS.setControlIgnored(v.key, true))}><EyeOff size={13} />Ignorar</button>
                    )}
                    {v.vyro.state === 'ignored' && (
                      <button className="btn small ghost" data-test="control-unignore" disabled={busy} onClick={() => void hacer(() => window.contentOS.setControlIgnored(v.key, false))}>Dejar de ignorar</button>
                    )}
                    {v.vyro.state === 'not_found' && v.clipId && v.publicationId != null && (
                      <button className="btn small primary" data-test="control-unmark" disabled={busy} title="Quita la publicación de YouTube de este clip (no borra nada en YouTube)"
                        onClick={() => void hacer(() => window.contentOS.deletePublication(v.clipId!, v.publicationId!))}>Quitar marca</button>
                    )}
                    {(v.vyro.state === 'missing' || v.vyro.state === 'manual') && <a className="btn small" href="https://app.vyro.com/campaigns/add-clips" target="_blank" rel="noreferrer"><ExternalLink size={13} />Vyro</a>}
                    {v.publicationId != null && (v.vyro.state === 'missing' || v.vyro.state === 'unchecked') && !vyroConectado && (
                      <button className="btn small primary" data-test="control-mark" disabled={busy} onClick={() => void hacer(() => window.contentOS.setVyroSent(v.publicationId!, true))}>Ya lo envié</button>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </>
  )
}
