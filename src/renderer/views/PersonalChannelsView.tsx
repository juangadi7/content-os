import { CircleAlert, ExternalLink, Info, Plus, RefreshCw, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AppState, ChannelDashboard, ChannelDay, ChannelVideo } from '../../core/api'
import { formatCount, formatDuration, relativeTime } from '../../core/format'
import { compact, niceMax, Sparkline, Tip, useTip } from '../components/charts'
import { Empty } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const nombre = (c: ChannelDashboard) => c.handle ?? c.title ?? c.channelId
const subido = (iso: string | null) => (iso ? `${new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} · ${new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : '—')
const pct = (likes: number | null, views: number | null) => (likes == null || !views ? '—' : ((likes / views) * 100).toFixed(1).replace('.', ',') + ' %')
const diaLargo = (day: string) => new Date(day + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
const diaCorto = (day: string) => new Date(day + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
const conSigno = (n: number) => (n > 0 ? '+' : '') + formatCount(n)

/** Visitas ganadas cada día medido. Un día sin diferencia calculable (el primero) se dibuja hueco, no como cero. */
function DayBars({ days }: { days: ChannelDay[] }) {
  const [tip, mostrar, ocultar] = useTip()
  const alto = 132
  const base = alto - 22
  // con pocos días las barras van anchas y separadas, para que las fechas de debajo no se pisen
  const bw = days.length > 40 ? 10 : days.length > 20 ? 16 : days.length > 10 ? 26 : 40
  const gap = days.length > 40 ? 3 : days.length > 10 ? 6 : 26
  const ancho = Math.max(240, days.length * (bw + gap) + 8)
  const tope = niceMax(Math.max(1, ...days.map((d) => d.viewsGain ?? 0)))
  const paso = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(ancho / 70))))
  return (
    <div className="strip daybars" data-test="personal-daybars">
      <svg width={ancho} height={alto} role="img" aria-label={`Visitas ganadas por día en ${days.length} días medidos`}>
        <line x1="0" x2={ancho} y1={base} y2={base} className="axis" />
        {days.map((d, i) => {
          const x0 = 4 + i * (bw + gap)
          const g = d.viewsGain
          const h = g == null ? 14 : g <= 0 ? 3 : Math.max(4, (g / tope) * (base - 8))
          return (
            <g key={d.day}>
              <rect x={x0} y={base - h} width={bw} height={h} rx="2" className={g == null ? 'bar unmeasured' : g <= 0 ? 'bar zero' : 'bar'}
                onMouseMove={(e) => mostrar(e, (
                  <>
                    <div className="tip-t">{diaLargo(d.day)}</div>
                    <div>{g == null ? 'Primer día medido: aún no hay con qué comparar' : `${conSigno(g)} visitas`}</div>
                    {d.daysSincePrevious != null && d.daysSincePrevious > 1 && <div className="tip-s">Suma {d.daysSincePrevious} días: los anteriores no se midieron</div>}
                    <div className="tip-s">Total del canal: {formatCount(d.totalViews)}</div>
                  </>
                ))}
                onMouseLeave={ocultar} />
              {(i % paso === 0 || i === days.length - 1) && <text x={x0 + bw / 2} y={alto - 6} textAnchor="middle" className="tick">{diaCorto(d.day)}</text>}
            </g>
          )
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}

/**
 * Canales del usuario que no tienen que ver con los clips: solo sus cifras públicas, día a día.
 * No entran en el plan de «Hoy», en las estadísticas de campañas ni se emparejan con clips.
 */
export function PersonalChannelsView(props: { state: AppState; refresh: number; onState: (s: AppState) => void; onYouTube: () => void; onChanged: () => void }) {
  const [canales, setCanales] = useState<ChannelDashboard[] | null>(null)
  const [elegido, setElegido] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [nuevo, setNuevo] = useState('')
  const [quitando, setQuitando] = useState(false)
  const [pasando, setPasando] = useState(false)

  const cargar = async () => setCanales(await window.contentOS.youtubeDashboard('personal'))
  useEffect(() => {
    let vivo = true
    void window.contentOS.youtubeDashboard('personal').then((c) => vivo && setCanales(c)).catch((e) => vivo && setAviso(mensaje(e)))
    return () => {
      vivo = false
    }
  }, [props.refresh])

  const canal = useMemo(() => canales?.find((c) => c.channelId === elegido) ?? canales?.[0] ?? null, [canales, elegido])
  const conectado = props.state.youtubeConnected

  const hacer = async (f: () => Promise<void>) => {
    setBusy(true)
    setAviso(null)
    try {
      await f()
    } catch (e) {
      setAviso(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const actualizar = () => hacer(async () => {
    await window.contentOS.youtubeRefresh(true)
    await cargar()
    props.onChanged()
  })
  const añadir = () => hacer(async () => {
    props.onState(await window.contentOS.youtubeAddChannel(nuevo.trim(), 'personal'))
    setNuevo('')
    // primera lectura: sus vídeos y sus cifras de hoy
    await window.contentOS.youtubeRefresh(true).catch(() => undefined)
    const c = await window.contentOS.youtubeDashboard('personal')
    setCanales(c)
    setElegido(c[c.length - 1]?.channelId ?? null)
    props.onChanged()
  })
  const pasar = (id: string) => hacer(async () => {
    props.onState(await window.contentOS.youtubeMoveToClips(id))
    setPasando(false)
    setElegido(null)
    // empareja ya sus vídeos con los clips
    await window.contentOS.youtubeRefresh(true).catch(() => undefined)
    await cargar()
    props.onChanged()
  })
  const quitar = (id: string) => hacer(async () => {
    props.onState(await window.contentOS.youtubeRemoveChannel(id))
    setQuitando(false)
    setElegido(null)
    await cargar()
  })

  const alta = (
    <form className="personal-add" onSubmit={(e) => { e.preventDefault(); if (nuevo.trim()) void añadir() }}>
      <input className="search" data-test="personal-input" placeholder="@nombre o enlace del canal" value={nuevo} disabled={busy || !conectado} onChange={(e) => setNuevo(e.target.value)} />
      <button className="btn" data-test="personal-add" type="submit" disabled={busy || !conectado || !nuevo.trim()}><Plus size={14} />Añadir canal</button>
    </form>
  )
  const cabecera = (extra?: React.ReactNode) => (
    <PageHeader title="Canales personales" titleTest="personal-title"
      meta={<><span className="chip-s personal"><UserRound size={11} />Aparte de los clips</span>{canal && <><span className="sep">·</span><span>Actualizado {relativeTime(canal.lastScanAt)}</span></>}</>}>
      {extra}
    </PageHeader>
  )

  if (!canales) return cabecera()
  if (!canal) {
    return (
      <>
        {cabecera()}
        {aviso && <div className="banner bad"><CircleAlert size={15} /><span data-test="personal-error">{aviso}</span></div>}
        <Empty title="Aquí van tus canales de siempre" test="personal-empty">
          <p>Añade un canal tuyo que no tenga que ver con los clips y verás sus visitas día a día, sus suscriptores y sus vídeos. No se mezcla con las campañas ni con el plan de «Hoy».</p>
          {conectado ? <div className="personal-add-wrap">{alta}</div> : <button className="btn primary" onClick={props.onYouTube}>Conectar YouTube</button>}
        </Empty>
      </>
    )
  }

  const ultimoDia = canal.daily[canal.daily.length - 1]
  const conGanancia = canal.daily.filter((d) => d.viewsGain != null)
  const videos = canal.videos
  return (
    <>
      {cabecera(
        <>
          {alta}
          <button className="btn primary" data-test="personal-refresh" disabled={busy || !conectado} onClick={() => void actualizar()}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} />{busy ? 'Actualizando…' : 'Actualizar'}
          </button>
        </>
      )}

      <div className="chan-tabs" data-test="personal-tabs">
        {canales.map((c) => (
          <button key={c.channelId} className={`fchip ${c.channelId === canal.channelId ? 'on' : ''}`} data-test="personal-tab" onClick={() => { setElegido(c.channelId); setQuitando(false); setPasando(false) }}>
            <span>{nombre(c)}</span><i>{c.videos.length}</i>
          </button>
        ))}
        <span className="sp" />
        {pasando
          ? <><span className="muted">Sus vídeos se emparejarán con los clips de campaña; sus cifras se conservan.</span><button className="btn small primary" data-test="personal-move-confirm" disabled={busy} onClick={() => void pasar(canal.channelId)}>Pasar {nombre(canal)}</button><button className="btn small ghost" onClick={() => setPasando(false)}>Cancelar</button></>
          : !quitando && <button className="btn small ghost" data-test="personal-move" title="Para subir ahí clips de campaña: la app reconoce cada vídeo y lo cuenta" onClick={() => setPasando(true)}>Pasar a Canales (clips)</button>}
        {pasando ? null : quitando
          ? <><span className="muted">Se borran sus cifras guardadas.</span><button className="btn small danger" data-test="personal-remove-confirm" disabled={busy} onClick={() => void quitar(canal.channelId)}>Quitar {nombre(canal)}</button><button className="btn small ghost" onClick={() => setQuitando(false)}>Cancelar</button></>
          : <button className="btn small ghost" data-test="personal-remove" onClick={() => setQuitando(true)}>Quitar canal</button>}
      </div>
      {aviso && <div className="banner bad"><CircleAlert size={15} /><span data-test="personal-error">{aviso}</span></div>}

      <div className="kpis" data-test="personal-kpis">
        <div className="tile">
          <div className="k"><i className="sw c-personal" />Visitas del canal</div>
          <div className="v" data-test="personal-total">{canal.totalViews == null ? '—' : formatCount(canal.totalViews)}</div>
          <div className="s">{ultimoDia?.viewsGain != null
            ? <><b className={ultimoDia.viewsGain > 0 ? 'up' : ''}>{conSigno(ultimoDia.viewsGain)}</b> {ultimoDia.daysSincePrevious === 1 ? `el ${diaCorto(ultimoDia.day)}` : `en ${ultimoDia.daysSincePrevious} días`}</>
            : 'Total según YouTube.'}</div>
        </div>
        <div className="tile">
          <div className="k"><i className="sw c-neutral" />Suscriptores</div>
          <div className="v">{canal.subscribers == null ? '—' : formatCount(canal.subscribers)}</div>
          <div className="s">{canal.subscribers == null ? 'El canal los oculta o aún no se han pedido.'
            : canal.subscribersChange ? <><b className={canal.subscribersChange.delta > 0 ? 'up' : ''}>{conSigno(canal.subscribersChange.delta)}</b> desde el {diaCorto(canal.subscribersChange.since.slice(0, 10))}</>
            : 'YouTube da esta cifra redondeada.'}</div>
        </div>
        <div className="tile">
          <div className="k"><i className="sw c-neutral" />Vídeos públicos</div>
          <div className="v">{canal.videoCount ?? videos.length}</div>
          <div className="s">{videos[0]?.publishedAt ? `El último, ${relativeTime(videos[0].publishedAt)}.` : 'Sin vídeos públicos.'}</div>
        </div>
        <div className="tile">
          <div className="k"><i className="sw c-views" />Último día, vídeo a vídeo</div>
          <div className="v">{canal.totals.gain == null ? '—' : conSigno(canal.totals.gain)}</div>
          <div className="s">{canal.totals.gain == null ? 'Hace falta una medición de ayer para comparar.' : `Suma de ${canal.totals.gainVideos} ${canal.totals.gainVideos === 1 ? 'vídeo' : 'vídeos'} con medición de ayer.`}</div>
        </div>
      </div>

      <section className="panel" data-test="personal-daily">
        <header className="panel-h">
          <div>
            <h2>Día a día</h2>
            <p className="panel-hint">Visitas que gana el canal cada día. Se apunta la cifra cada vez que la aplicación pide datos a YouTube, así que los días en que no se abre no aparecen.</p>
          </div>
          {conGanancia.length > 0 && <div className="panel-aside"><div className="legend compact"><span><i className="sw c-personal" />Visitas ganadas</span><span><i className="sw c-unmeasured" />Sin comparación</span><span className="faint">escala: 0 – {compact(niceMax(Math.max(1, ...conGanancia.map((d) => d.viewsGain!))))}</span></div></div>}
        </header>
        {canal.daily.length < 2 ? (
          <div className="nodata" data-test="personal-daily-empty"><Info size={15} /><span>Las estadísticas diarias empiezan {canal.daily.length ? 'hoy' : 'con la primera actualización'}: YouTube no entrega el historial de días anteriores, solo la cifra actual. Mañana verás aquí la primera diferencia.</span></div>
        ) : (
          <>
            <DayBars days={canal.daily} />
            <div className="rows flat">
              <div className="row hdr cols-day">
                <span>Día</span><span className="num">Visitas ganadas</span><span className="num">Visitas totales</span><span className="num">Suscriptores</span><span className="num">Vídeos subidos</span>
              </div>
              {[...canal.daily].reverse().map((d) => (
                <div key={d.day} className="row static cols-day" data-test="personal-day" data-day={d.day}>
                  <span>{diaLargo(d.day)}{d.daysSincePrevious != null && d.daysSincePrevious > 1 && <span className="est" title="Los días anteriores no se midieron: la diferencia los incluye">{d.daysSincePrevious} días</span>}</span>
                  <span className="num tnum strong" data-test="personal-day-gain">{d.viewsGain == null ? <span className="faint">—</span> : <span className={d.viewsGain > 0 ? 'ok' : ''}>{conSigno(d.viewsGain)}</span>}</span>
                  <span className="num tnum">{formatCount(d.totalViews)}</span>
                  <span className="num tnum">{formatCount(d.subscribers)}{d.subscribersGain ? <span className={`delta ${d.subscribersGain > 0 ? 'ok' : 'bad'}`}>{conSigno(d.subscribersGain)}</span> : null}</span>
                  <span className="num tnum">{d.uploads || <span className="faint">—</span>}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel" data-test="personal-videos">
        <header className="panel-h">
          <div>
            <h2>Vídeos</h2>
            <p className="panel-hint">Todos los vídeos públicos del canal, del más reciente al más antiguo.</p>
          </div>
        </header>
        {videos.length === 0 ? <div className="nodata"><Info size={15} /><span>YouTube no devuelve ningún vídeo público de este canal.</span></div> : (
          <div className="rows flat">
            <div className="row hdr cols-pvideo">
              <span>Vídeo</span><span>Subido</span><span className="num">Dur.</span><span className="num">Visitas</span><span className="num">Último día</span><span className="num">Likes</span><span className="num">% likes</span><span className="num">Coment.</span><span>Evolución</span><span />
            </div>
            {videos.map((v: ChannelVideo) => (
              <div key={v.videoId} className="row static cols-pvideo" data-test="personal-row" data-video={v.videoId}>
                <span className="t1" title={v.title ?? ''}>{v.title ?? 'Sin título'}</span>
                <span className="tnum">{subido(v.publishedAt)}</span>
                <span className="num tnum">{v.durationSeconds == null ? '—' : formatDuration(v.durationSeconds)}</span>
                <span className="num tnum strong">{v.views == null ? <span className="faint">sin medir</span> : formatCount(v.views)}</span>
                <span className="num tnum" title={v.gain ? `Ganadas en las últimas ${v.gain.hours} h, entre dos mediciones reales` : 'Sin una medición de hace un día con la que comparar'}>
                  {v.gain ? <span className={v.gain.views > 0 ? 'ok' : 'faint'}>+{formatCount(v.gain.views)}</span> : <span className="faint">—</span>}
                </span>
                <span className="num tnum">{v.likes == null ? '—' : formatCount(v.likes)}</span>
                <span className="num tnum">{pct(v.likes, v.views)}</span>
                <span className="num tnum">{v.comments == null ? '—' : formatCount(v.comments)}</span>
                <Sparkline points={v.series.map((p) => ({ publicationId: 0, t: p.t, views: p.views }))} />
                <a className="ext icon" href={v.url} target="_blank" rel="noreferrer" title="Abrir en YouTube"><ExternalLink size={14} /></a>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
