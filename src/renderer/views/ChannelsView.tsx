import { ArrowDown, ArrowUp, Check, CircleAlert, Copy, ExternalLink, Info, Lightbulb, Microscope, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppState, ChannelDashboard, ChannelVideo, StudyFinding } from '../../core/api'
import { formatCount, formatDuration, relativeTime } from '../../core/format'
import { compact, diaCorto, niceMax, Sparkline, StripChart } from '../components/charts'
import { Empty, Thumb, useCopy } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const subido = (iso: string | null) => (iso ? `${new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} · ${new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : '—')
const pct = (likes: number | null, views: number | null) => (likes == null || !views ? '—' : ((likes / views) * 100).toFixed(1).replace('.', ',') + ' %')
const nombre = (c: ChannelDashboard) => c.handle ?? c.title ?? c.channelId
const RECIENTE_MS = 48 * 3600_000

type Clave = 'date' | 'views' | 'gain' | 'likes'
type Orden = { clave: Clave; asc: boolean }

const ICONO: Record<StudyFinding['tone'], ReactNode> = { good: <Check size={15} />, bad: <TriangleAlert size={15} />, info: <Info size={15} /> }

/** Panel de cada canal de YouTube: cifras públicas, vídeos en orden de subida y el estudio del canal. */
export function ChannelsView(props: { state: AppState; refresh: number; onOpen: (clipId: string) => void; onYouTube: () => void; onChanged: () => void }) {
  const [canales, setCanales] = useState<ChannelDashboard[] | null>(null)
  const [elegido, setElegido] = useState<string | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'study' | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [estudiado, setEstudiado] = useState<Record<string, string>>({})
  const [orden, setOrden] = useState<Orden>({ clave: 'date', asc: false })
  const [copiado, copiar] = useCopy()

  useEffect(() => {
    let vivo = true
    void window.contentOS.youtubeDashboard().then((c) => vivo && setCanales(c)).catch((e) => vivo && setAviso(mensaje(e)))
    return () => {
      vivo = false
    }
  }, [props.refresh])

  const canal = useMemo(() => canales?.find((c) => c.channelId === elegido) ?? canales?.[0] ?? null, [canales, elegido])
  const videos = useMemo(() => {
    if (!canal) return []
    const valor = (v: ChannelVideo): number | null =>
      orden.clave === 'date' ? (v.publishedAt ? new Date(v.publishedAt).getTime() : null) : orden.clave === 'views' ? v.views : orden.clave === 'gain' ? v.gain?.views ?? null : v.likes
    // lo que no se puede ordenar (sin dato) va siempre al final
    return [...canal.videos].sort((a, b) => {
      const x = valor(a)
      const y = valor(b)
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
      return orden.asc ? x - y : y - x
    })
  }, [canal, orden])

  /** Pide las cifras a YouTube (si se puede) y vuelve a leer el panel. */
  const actualizar = async (modo: 'refresh' | 'study') => {
    setBusy(modo)
    setAviso(null)
    try {
      if (props.state.youtubeConnected) {
        try {
          await window.contentOS.youtubeRefresh(true)
        } catch (e) {
          setAviso(`No se han podido pedir cifras nuevas a YouTube (${mensaje(e)}). Se enseñan las últimas guardadas.`)
        }
      }
      const c = await window.contentOS.youtubeDashboard()
      setCanales(c)
      const actual = c.find((x) => x.channelId === elegido) ?? c[0]
      if (modo === 'study' && actual) setEstudiado((s) => ({ ...s, [actual.channelId]: new Date().toISOString() }))
      props.onChanged()
    } catch (e) {
      setAviso(mensaje(e))
    } finally {
      setBusy(null)
    }
  }

  if (!canales) return <PageHeader title="Canales" meta={aviso ?? 'Cargando…'} />
  if (!canal) {
    return (
      <>
        <PageHeader title="Canales" meta="Datos públicos de tus canales de YouTube" />
        <Empty title={props.state.youtubeConnected ? 'Todavía no sigues ningún canal' : 'YouTube no está conectado'} test="channels-empty">
          <p>{props.state.youtubeConnected ? 'Añade tu canal (@nombre) y aquí verás todos sus vídeos con sus cifras.' : 'Conecta YouTube con una clave de API y añade tu canal para ver aquí sus vídeos y sus cifras.'}</p>
          <button className="btn primary" onClick={props.onYouTube}>{props.state.youtubeConnected ? 'Añadir canal' : 'Conectar YouTube'}</button>
        </Empty>
      </>
    )
  }

  const t = canal.totals
  const ahora = Date.now()
  const reciente = (v: ChannelVideo) => v.publishedAt != null && ahora - new Date(v.publishedAt).getTime() < RECIENTE_MS
  const enSemana = canal.videos.filter((v) => v.publishedAt && ahora - new Date(v.publishedAt).getTime() < 7 * 24 * 3600_000).length
  const mejor = canal.videos.reduce<ChannelVideo | null>((m, v) => (v.views != null && (m == null || v.views > m.views!) ? v : m), null)
  const enOrden = [...canal.videos].filter((v) => v.publishedAt).reverse()
  const tope = Math.max(1, ...canal.videos.map((v) => v.views ?? 0))
  const estudio = estudiado[canal.channelId] ? canal.study : null
  const porId = new Map(canal.videos.map((v) => [v.videoId, v]))
  const marca = (v: ChannelVideo) => (estudio?.best.includes(v.videoId) ? 'best' : estudio?.worst.includes(v.videoId) ? 'worst' : null)
  const th = (clave: Clave, texto: string, num = true) => (
    <button className={`th ${num ? 'num' : ''} ${orden.clave === clave ? 'on' : ''}`} onClick={() => setOrden((o) => ({ clave, asc: o.clave === clave ? !o.asc : false }))}>
      {texto}{orden.clave === clave && (orden.asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  )
  const lista = (ids: string[]) => (
    <ul className="study-list">
      {ids.map((id) => {
        const v = porId.get(id)!
        return (
          <li key={id}>
            <b>{formatCount(v.views)}</b>
            <span>{v.clipId ? <button className="linklike" onClick={() => props.onOpen(v.clipId!)}>{v.title ?? 'Sin título'}</button> : v.title ?? 'Sin título'}
              <i>{[subido(v.publishedAt), v.durationSeconds != null ? formatDuration(v.durationSeconds) : null, v.campaignName].filter(Boolean).join(' · ')}</i></span>
          </li>
        )
      })}
    </ul>
  )

  return (
    <>
      <PageHeader title="Canales" titleTest="channels-title"
        meta={<><span>Datos públicos de YouTube</span><span className="sep">·</span><span>Actualizado {relativeTime(canal.lastScanAt)}</span></>}>
        <button className="btn" data-test="channels-refresh" disabled={busy !== null || !props.state.youtubeConnected} onClick={() => void actualizar('refresh')}>
          <RefreshCw size={14} className={busy === 'refresh' ? 'spin' : ''} />{busy === 'refresh' ? 'Actualizando…' : 'Actualizar cifras'}
        </button>
        <button className="btn primary" data-test="study-channel" disabled={busy !== null} onClick={() => void actualizar('study')}>
          <Microscope size={15} />{busy === 'study' ? 'Estudiando…' : 'Estudiar canal'}
        </button>
      </PageHeader>

      {canales.length > 1 && (
        <div className="chan-tabs" data-test="channel-tabs">
          {canales.map((c) => (
            <button key={c.channelId} className={`fchip ${c.channelId === canal.channelId ? 'on' : ''}`} data-test="channel-tab" onClick={() => setElegido(c.channelId)}>
              <span>{nombre(c)}</span><i>{c.videos.length}</i>
            </button>
          ))}
        </div>
      )}
      {aviso && <div className="banner bad"><CircleAlert size={15} /><span>{aviso}</span></div>}

      <div className="kpis" data-test="channel-kpis">
        <div className="tile">
          <div className="k"><i className="sw c-neutral" />Suscriptores</div>
          <div className="v">{canal.subscribers == null ? '—' : formatCount(canal.subscribers)}</div>
          <div className="s">
            {canal.subscribers == null ? 'Sin dato: el canal los oculta o aún no se han pedido.'
              : canal.subscribersChange ? <><b className={canal.subscribersChange.delta > 0 ? 'up' : ''}>{canal.subscribersChange.delta > 0 ? '+' : ''}{formatCount(canal.subscribersChange.delta)}</b> desde el {diaCorto(canal.subscribersChange.since.slice(0, 10))}</>
              : 'YouTube da esta cifra redondeada.'}
          </div>
        </div>
        <div className="tile" data-test="channel-views">
          <div className="k"><i className="sw c-views" />Visitas</div>
          <div className="v">{formatCount(t.views)}</div>
          <div className="s">
            {t.gain != null ? <><b className={t.gain > 0 ? 'up' : ''}>+{formatCount(t.gain)}</b> en el último día ({t.gainVideos} {t.gainVideos === 1 ? 'vídeo comparable' : 'vídeos comparables'})</> : 'Sin una medición de ayer con la que comparar.'}
            {canal.totalViews != null && canal.totalViews !== t.views && <><br />Canal entero, según YouTube: {formatCount(canal.totalViews)}</>}
          </div>
        </div>
        <div className="tile">
          <div className="k"><i className="sw c-goal" />Visitas por vídeo</div>
          <div className="v">{t.median == null ? '—' : formatCount(t.median)}</div>
          <div className="s">Mediana de {t.measured} {t.measured === 1 ? 'vídeo' : 'vídeos'}.{mejor && <> El mejor: <b>{formatCount(mejor.views)}</b></>}</div>
        </div>
        <div className="tile">
          <div className="k"><i className="sw c-neutral" />Vídeos públicos</div>
          <div className="v">{t.videos}</div>
          <div className="s">{enSemana} {enSemana === 1 ? 'subido' : 'subidos'} en los últimos 7 días.</div>
        </div>
      </div>

      <section className={`panel study ${estudio ? 'done' : ''}`} data-test="channel-study">
        <header className="panel-h">
          <div>
            <h2>Estudio del canal</h2>
            <p className="panel-hint">
              {estudio ? `Hecho ${relativeTime(estudiado[canal.channelId])} con las cifras de ${nombre(canal)}.` : 'Pulsa «Estudiar canal»: pide las cifras a YouTube y te dice cómo va, qué vídeos funcionan y cuáles no.'}
            </p>
          </div>
          {estudio && (
            <div className="panel-aside">
              <button className="btn small" data-test="study-copy" onClick={() => void copiar('estudio', estudio.text)}>
                {copiado === 'estudio' ? <><Check size={13} />Copiado</> : <><Copy size={13} />Copiar estudio</>}
              </button>
            </div>
          )}
        </header>
        {estudio && (
          <>
            <div className={`verdict ${estudio.level}`} data-test="study-verdict" data-level={estudio.level}>
              <h3>{estudio.headline}</h3>
              <p>{estudio.summary}</p>
            </div>
            <dl className="facts">
              {estudio.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
            </dl>
            {estudio.findings.length > 0 && (
              <ul className="findings" data-test="study-findings">
                {estudio.findings.map((f) => (
                  <li key={f.title} className={f.tone} data-test="study-finding">
                    {ICONO[f.tone]}
                    <div>
                      <b>{f.title}</b>{f.weak && <span className="est" title="Sale de menos de 5 vídeos por grupo">indicio</span>}
                      <p>{f.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {estudio.best.length > 0 && (
              <div className="study-cols">
                <div><h4>Los que mejor han funcionado</h4>{lista(estudio.best)}</div>
                <div><h4>Los que peor</h4>{lista(estudio.worst)}</div>
              </div>
            )}
            <div className="steps" data-test="study-steps">
              <h4><Lightbulb size={14} />Siguientes pasos</h4>
              <ol>{estudio.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            </div>
            <ul className="limits">{estudio.limits.map((l) => <li key={l}>{l}</li>)}</ul>
          </>
        )}
      </section>

      <section className="panel" data-test="channel-strip">
        <header className="panel-h">
          <div>
            <h2>Vídeo a vídeo, en orden de subida</h2>
            <p className="panel-hint">Cada barra es un vídeo, del más antiguo (izquierda) al más reciente. Así se ve de un vistazo si el canal deja de recibir visitas.</p>
          </div>
          <div className="panel-aside">
            <div className="legend compact"><span><i className="sw c-views" />Visitas</span><span><i className="sw c-zero" />0 visitas</span><span className="faint">escala: 0 – {compact(niceMax(tope))}</span></div>
          </div>
        </header>
        {enOrden.length === 0 ? <div className="nodata"><Info size={15} /><span>YouTube no devuelve ningún vídeo público de este canal.</span></div>
          : <StripChart items={enOrden.map((v) => ({ key: v.videoId, title: v.title ?? 'Sin título', views: v.views, date: v.publishedAt, onClick: v.clipId ? () => props.onOpen(v.clipId!) : undefined }))} max={tope} height={96} />}
      </section>

      <section className="panel" data-test="channel-videos">
        <header className="panel-h">
          <div>
            <h2>Vídeos</h2>
            <p className="panel-hint">Todos los vídeos públicos del canal. Pulsa una cabecera para cambiar el orden.</p>
          </div>
        </header>
        <div className="rows flat">
          <div className="row hdr cols-chan">
            <span />
            <span>Vídeo</span>
            {th('date', 'Subido', false)}
            <span className="num">Dur.</span>
            {th('views', 'Visitas')}
            {th('gain', 'Último día')}
            {th('likes', 'Likes')}
            <span className="num">% likes</span>
            <span className="num">Coment.</span>
            <span>Evolución</span>
            <span />
          </div>
          {videos.map((v) => {
            const m = marca(v)
            return (
              <div key={v.videoId} className={`row cols-chan ${v.clipId ? '' : 'static'}`} data-test="channel-row" data-video={v.videoId} onClick={() => v.clipId && props.onOpen(v.clipId)}>
                {v.clipId ? <Thumb clip={{ clipId: v.clipId, hasThumb: v.hasThumb, thumbVersion: v.thumbVersion }} /> : <div className="thumb ph" title="Sin emparejar con un clip">▶</div>}
                <div className="chan-t">
                  <span className="t1" title={v.title ?? ''}>{v.title ?? 'Sin título'}</span>
                  <span className="t2">
                    {v.campaignName ?? <span className="faint">Sin emparejar con un clip</span>}
                    {reciente(v) && <span className="chip-s" title="Aún está recibiendo su primer reparto">menos de 48 h</span>}
                    {m === 'best' && <span className="chip-s open">de los mejores</span>}
                    {m === 'worst' && <span className="chip-s warn">de los peores</span>}
                  </span>
                </div>
                <span className="tnum" data-test="channel-date">{subido(v.publishedAt)}</span>
                <span className="num tnum">{v.durationSeconds == null ? '—' : formatDuration(v.durationSeconds)}</span>
                <span className="num tnum strong" data-test="channel-row-views">{v.views == null ? <span className="faint">sin medir</span> : formatCount(v.views)}</span>
                <span className="num tnum" title={v.gain ? `Ganadas en las últimas ${v.gain.hours} h, entre dos mediciones reales` : 'Sin una medición de hace un día con la que comparar'}>
                  {v.gain ? <span className={v.gain.views > 0 ? 'ok' : 'faint'}>+{formatCount(v.gain.views)}</span> : <span className="faint">—</span>}
                </span>
                <span className="num tnum">{v.likes == null ? '—' : formatCount(v.likes)}</span>
                <span className="num tnum">{pct(v.likes, v.views)}</span>
                <span className="num tnum">{v.comments == null ? '—' : formatCount(v.comments)}</span>
                <Sparkline points={v.series.map((p) => ({ publicationId: 0, t: p.t, views: p.views }))} />
                <a className="ext icon" href={v.url} target="_blank" rel="noreferrer" title="Abrir en YouTube" onClick={(e) => e.stopPropagation()}><ExternalLink size={14} /></a>
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}
