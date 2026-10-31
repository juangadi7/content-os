import { ArrowDown, ArrowUp, Info, Plus, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppState, SeriesPoint, StatsVideo, StatsView as Stats, UnmatchedVideo } from '../../core/api'
import { formatCount, formatDuration, PLATFORM_LABEL, PLATFORMS, relativeTime, scoreLabel, type Platform } from '../../core/format'
import { formatMoney } from '../../core/money'
import { comparableDelta, dailyGains, dailyTotals, gainBetween, localDay, seriesByPublication, type DailyGain } from '../../core/stats-series'
import { compact, diaCorto, GainBars, LineChart, niceMax, Sparkline, StripChart, type GainBar } from '../components/charts'
import { Empty, Thumb } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : '—')
const pct = (v: number | null) => (v == null ? '—' : (v * 100).toFixed(1).replace('.', ',') + ' %')
const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

type Rango = 7 | 28 | 0
type VistaDias = 'dia' | 'semana'

const diaLargo = (day: string) => new Date(day + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
const restarDias = (day: string, n: number) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() - n); return localDay(d.toISOString()) }
/** Lunes de la semana de un día, AAAA-MM-DD. */
const lunes = (day: string) => { const d = new Date(day + 'T12:00:00'); return restarDias(day, (d.getDay() + 6) % 7) }

/** Agrupa las ganancias diarias en barras por día (últimos 30) o por semana (lunes a domingo). */
function barrasDe(gains: DailyGain[], vista: VistaDias): { barras: GainBar[]; detalle: Map<string, { gain: number; top: Map<number, number>; days: string[] }> } {
  const detalle = new Map<string, { gain: number; top: Map<number, number>; days: string[] }>()
  for (const g of gains) {
    const k = vista === 'dia' ? g.day : lunes(g.day)
    const d = detalle.get(k) ?? { gain: 0, top: new Map<number, number>(), days: [] }
    d.gain += g.gain
    d.days.push(g.day)
    for (const t of g.top) d.top.set(t.publicationId, (d.top.get(t.publicationId) ?? 0) + t.gain)
    detalle.set(k, d)
  }
  const fuente = vista === 'dia' ? gains.slice(-30) : [...detalle.keys()].sort().slice(-16).map((k) => ({ day: k }))
  const barras = fuente.map((f) => {
    const k = f.day
    const g = vista === 'dia' ? (f as DailyGain) : null
    return {
      key: k,
      label: vista === 'dia' ? diaCorto(k) : 'semana del ' + diaCorto(k) + (detalle.get(k)!.days.length < 7 && k === lunes(gains[gains.length - 1].day) ? ' (en curso)' : ''),
      value: detalle.get(k)!.gain,
      span: g?.span,
      videos: g ? g.videos : Math.max(0, ...gains.filter((x) => lunes(x.day) === k).map((x) => x.videos))
    }
  })
  return { barras, detalle }
}

/** Minigráfico de área para un indicador: solo con dos puntos o más. */
function Tendencia({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const w = 160, h = 26, max = Math.max(1, ...values)
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - (v / max) * (h - 4)])
  const linea = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return <svg className="trend" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height={h} aria-hidden="true"><path className="a" d={`${linea} L${w},${h} L0,${h} Z`} /><path className="l" d={linea} /></svg>
}
type Orden = { clave: 'views' | 'date' | 'perDay' | 'earning' | 'score'; asc: boolean } | null

function Panel(props: { title: string; hint?: ReactNode; aside?: ReactNode; children: ReactNode; test?: string; className?: string }) {
  return (
    <section className={`panel ${props.className ?? ''}`} data-test={props.test}>
      <header className="panel-h">
        <div>
          <h2>{props.title}</h2>
          {props.hint && <p className="panel-hint">{props.hint}</p>}
        </div>
        {props.aside && <div className="panel-aside">{props.aside}</div>}
      </header>
      {props.children}
    </section>
  )
}

/** Mensaje honesto cuando un gráfico no tiene datos que lo respalden. */
function SinDatos({ children }: { children: ReactNode }) {
  return <div className="nodata"><Info size={15} /> <span>{children}</span></div>
}

/** Estadísticas reales de lo publicado: indicadores, evolución, camino al cobro, por canal, por campaña y por vídeo. */
export function StatsView(props: { state: AppState; refresh: number; onOpen: (clipId: string) => void; onYouTube: () => void; onChanged: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [serie, setSerie] = useState<SeriesPoint[]>([])
  const [busy, setBusy] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [tiktok, setTiktok] = useState('')
  const [hecho, setHecho] = useState<{ texto: string; alerta: string | null } | null>(null)
  const [plataforma, setPlataforma] = useState<Platform | 'all'>('all')
  const [rango, setRango] = useState<Rango>(0)
  const [orden, setOrden] = useState<Orden>(null)
  const [vistaDias, setVistaDias] = useState<VistaDias>('dia')
  const [diaSel, setDiaSel] = useState<string | null>(null)

  const cargar = async () => {
    const [s, p] = await Promise.all([window.contentOS.getStats(), window.contentOS.getStatsSeries().catch(() => [] as SeriesPoint[])])
    setStats(s)
    setSerie(p)
  }
  useEffect(() => {
    let vivo = true
    void Promise.all([window.contentOS.getStats(), window.contentOS.getStatsSeries().catch(() => [] as SeriesPoint[])]).then(([s, p]) => {
      if (!vivo) return
      setStats(s)
      setSerie(p)
    })
    return () => {
      vivo = false
    }
  }, [props.refresh])

  const actualizar = async () => {
    setBusy(true)
    setAviso(null)
    try {
      if (props.state.youtubeConnected) await window.contentOS.youtubeRefresh(true)
      const tk = await window.contentOS.tiktokRefresh(true)
      if (tk.error) setAviso(`TikTok: ${tk.error}`)
      await cargar()
      props.onChanged()
    } catch (e) {
      setAviso(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const aplicar = async (f: () => Promise<Stats>) => {
    try {
      setStats(await f())
      props.onChanged()
    } catch (e) {
      setAviso(mensaje(e))
    }
  }
  const añadirTikTok = async () => {
    setBusy(true)
    setAviso(null)
    setHecho(null)
    try {
      const r = await window.contentOS.tiktokAdd(tiktok)
      setHecho({
        texto: `${r.existed ? 'Actualizado' : 'Apuntado'}: «${r.title}» en ${r.account} · ${formatCount(r.views)} visitas`,
        alerta: r.extraHashtags.length ? `Ojo: lo publicaste con ${r.extraHashtags.join(' ')}, que no están en la ficha del clip. Si la campaña prohíbe hashtags ajenos, pueden rechazarlo: edita la descripción en TikTok.` : null
      })
      setTiktok('')
      await cargar()
      props.onChanged()
    } catch (e) {
      setAviso(mensaje(e))
    } finally {
      setBusy(false)
    }
  }

  const campañas = useMemo(() => new Map(props.state.campaigns.map((c) => [c.campaignId, c])), [props.state.campaigns])
  const videos = useMemo(() => (stats ? stats.videos.filter((v) => plataforma === 'all' || v.platform === plataforma) : []), [stats, plataforma])
  const porVideo = useMemo(() => seriesByPublication(serie), [serie])
  const dias = useMemo(() => {
    const ids = new Set(videos.map((v) => v.publicationId))
    const todos = dailyTotals(serie, ids)
    if (!rango) return todos
    const desde = new Date()
    desde.setDate(desde.getDate() - (rango - 1))
    return todos.filter((d) => d.day >= localDay(desde.toISOString()))
  }, [serie, videos, rango])
  const variacion = useMemo(() => comparableDelta(serie, new Set(videos.map((v) => v.publicationId))), [serie, videos])
  const ganancias = useMemo(() => dailyGains(serie, new Set(videos.map((v) => v.publicationId))), [serie, videos])
  const { barras, detalle } = useMemo(() => barrasDe(ganancias, vistaDias), [ganancias, vistaDias])

  if (!stats) {
    return (
      <>
        <PageHeader title="Estadísticas" meta="Cargando…" />
        <div className="kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="tile skeleton" />)}</div>
        <div className="panel skeleton" style={{ height: 280 }} />
      </>
    )
  }

  const conectado = props.state.youtubeConnected
  const medidos = videos.filter((v) => v.views != null)
  const total = plataforma === 'all' ? stats.totals : {
    views: medidos.reduce((s, v) => s + (v.views ?? 0), 0), likes: medidos.reduce((s, v) => s + (v.likes ?? 0), 0), comments: medidos.reduce((s, v) => s + (v.comments ?? 0), 0),
    measured: medidos.length, published: videos.length, lastMeasuredAt: medidos.map((v) => v.measuredAt!).sort().pop() ?? null,
    earning: Math.round(videos.reduce((s, v) => s + (v.earning ?? 0), 0) * 100) / 100, belowMin: videos.filter((v) => v.earningState === 'below_min').length
  }
  const conCondiciones = medidos.filter((v) => v.earningState !== 'no_terms')
  const cobran = conCondiciones.filter((v) => v.earningState === 'earning' || v.earningState === 'capped')
  const sinCondiciones = medidos.length - conCondiciones.length
  const plataformasUsadas = PLATFORMS.filter((p) => stats.videos.some((v) => v.platform === p))

  // camino al cobro: primero los que están más cerca de llegar; después los que ya cobran, de más a menos
  const camino = conCondiciones.map((v) => {
    const c = campañas.get(v.campaignId)
    const minimo = c?.minViews ?? null
    return { v, minimo, tope: c?.maxPayout ?? null, progreso: minimo ? Math.min(1, (v.views ?? 0) / minimo) : 1 }
  }).sort((a, b) => {
    const A = a.v.earningState === 'below_min', B = b.v.earningState === 'below_min'
    if (A !== B) return A ? -1 : 1
    return A ? b.progreso - a.progreso : (b.v.earning ?? 0) - (a.v.earning ?? 0)
  })

  // por canal, en orden de subida
  const canales = new Map<string, StatsVideo[]>()
  for (const v of videos) {
    const k = `${v.platform}|${(v.account || '(sin cuenta)').toLowerCase()}`
    canales.set(k, [...(canales.get(k) ?? []), v])
  }
  const tiras = [...canales.values()].map((lista) => {
    const enOrden = [...lista].sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))
    const m = enOrden.filter((v) => v.views != null)
    return { lista: enOrden, medidos: m.length, visitas: m.reduce((s, v) => s + (v.views ?? 0), 0), ceros: m.filter((v) => v.views === 0).length }
  }).sort((a, b) => b.visitas - a.visitas)
  const maxVideo = Math.max(1, ...medidos.map((v) => v.views ?? 0))

  const campañasVisibles = stats.campaigns.filter((c) => plataforma === 'all' || videos.some((v) => v.campaignId === c.campaignId))
  const maxCampaña = Math.max(1, ...campañasVisibles.map((c) => c.views))

  // visitas ganadas: últimos 7 días frente a los 7 anteriores, contados desde el último día medido
  const ultimoDia = ganancias.length ? ganancias[ganancias.length - 1].day : null
  const sem = ultimoDia ? gainBetween(ganancias, restarDias(ultimoDia, 6), ultimoDia) : 0
  const semAnt = ultimoDia ? gainBetween(ganancias, restarDias(ultimoDia, 13), restarDias(ultimoDia, 7)) : 0
  const cambioSem = semAnt > 0 ? (sem - semAnt) / semAnt : null
  const titulos = new Map(stats.videos.map((v) => [v.publicationId, v]))
  const clave = diaSel && detalle.has(diaSel) ? diaSel : barras.length ? barras[barras.length - 1].key : null
  const sel = clave ? detalle.get(clave)! : null
  const idxSel = clave ? barras.findIndex((b) => b.key === clave) : -1
  const anterior = idxSel > 0 ? barras[idxSel - 1] : null
  const topSel = sel ? [...sel.top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) : []

  const cajaTikTok = (
    <div className="tiktok-add" data-test="tiktok-add">
      <input className="search" data-test="tiktok-url" placeholder="Añadir vídeo de TikTok: pega su URL" value={tiktok}
        onChange={(e) => setTiktok(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && tiktok.trim() && !busy && void añadirTikTok()} />
      <button className="btn small" data-test="tiktok-save" disabled={busy || !tiktok.trim()} onClick={() => void añadirTikTok()}><Plus size={13} />Añadir</button>
    </div>
  )
  const avisosTikTok = (
    <>
      {hecho && <p className="ok small" data-test="tiktok-done" style={{ margin: '0 0 8px' }}>{hecho.texto}</p>}
      {hecho?.alerta && <p className="warn small" data-test="tiktok-warning" style={{ margin: '0 0 8px' }}>{hecho.alerta}</p>}
    </>
  )

  const filas = orden ? [...videos].sort((a, b) => {
    const val = (v: StatsVideo) => orden.clave === 'views' ? v.views : orden.clave === 'date' ? (v.publishedAt ? Date.parse(v.publishedAt) : null) : orden.clave === 'perDay' ? v.viewsPerDay : orden.clave === 'earning' ? v.earning : v.score
    const x = val(a), y = val(b)
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1 // los que no tienen dato, siempre al final
    return orden.asc ? x - y : y - x
  }) : videos
  const ordenar = (clave: NonNullable<Orden>['clave']) => setOrden((o) => (o?.clave !== clave ? { clave, asc: false } : o.asc ? null : { clave, asc: true }))
  const Th = (p: { clave: NonNullable<Orden>['clave']; children: ReactNode; num?: boolean }) => (
    <button className={`th ${p.num ? 'num' : ''} ${orden?.clave === p.clave ? 'on' : ''}`} onClick={() => ordenar(p.clave)} title="Ordenar por esta columna">
      {p.children}{orden?.clave === p.clave && (orden.asc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </button>
  )

  return (
    <>
      <PageHeader title="Estadísticas" meta={<>
        <span data-test="stats-updated">{total.lastMeasuredAt ? `actualizado ${relativeTime(total.lastMeasuredAt)}` : 'sin mediciones todavía'}</span>
        <span className="sep">·</span>
        <span>{total.measured} de {total.published} vídeos con cifras</span>
      </>}>
        {plataformasUsadas.length > 1 && (
          <div className="seg" data-test="stats-platform">
            <button className={plataforma === 'all' ? 'on' : ''} onClick={() => setPlataforma('all')}>Todas</button>
            {plataformasUsadas.map((p) => <button key={p} className={plataforma === p ? 'on' : ''} onClick={() => setPlataforma(p)}>{PLATFORM_LABEL[p]}</button>)}
          </div>
        )}
        <button className="btn" data-test="stats-refresh" disabled={busy} onClick={actualizar}><RefreshCw size={14} className={busy ? 'spin' : ''} />{busy ? 'Actualizando…' : 'Actualizar ahora'}</button>
        {!conectado && <button className="btn primary" onClick={props.onYouTube}>Conectar YouTube</button>}
      </PageHeader>

      {aviso && <div className="banner bad" data-test="stats-error"><TriangleAlert size={15} /><span>{aviso}</span></div>}
      {conectado && stats.channels.length === 0 && (
        <div className="banner" data-test="stats-no-channel">
          <Info size={15} /><span>Dile a CONTENT OS cuál es tu canal y encontrará tus vídeos y sus cifras sin que pegues ninguna URL.</span>
          <button className="btn small" onClick={props.onYouTube}>Añadir mi canal</button>
        </div>
      )}

      {stats.videos.length === 0 && stats.unmatched.length === 0 ? (
        <Empty title="Todavía no hay nada que medir" test="empty-stats">
          <p>{conectado ? 'Añade tu canal de YouTube, pega aquí la URL de un vídeo de TikTok o marca un clip como publicado.' : 'Conecta YouTube o pega aquí la URL de un vídeo de TikTok.'}</p>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>{cajaTikTok}</div>
          {avisosTikTok}
        </Empty>
      ) : (
        <>
          <div className="kpis k5" data-test="stats-totals">
            <div className="tile" data-test="stats-week">
              <div className="k"><i className="sw c-views" />Visitas ganadas · 7 días</div>
              <div className="v">{ganancias.length ? '+' + formatCount(sem) : '—'}</div>
              <Tendencia values={ganancias.slice(-14).map((g) => g.gain)} />
              <div className="s">{cambioSem == null ? (ganancias.length ? 'Sin semana anterior con la que comparar' : 'Hacen falta mediciones de dos días') : <><b className={cambioSem >= 0 ? 'up' : 'down'}>{cambioSem >= 0 ? '▲' : '▼'} {Math.abs(Math.round(cambioSem * 100))} %</b> frente a los 7 días anteriores</>}</div>
            </div>
            <div className="tile">
              <div className="k"><i className="sw c-views" />Visitas</div>
              <div className="v">{formatCount(total.views)}</div>
              <div className="s">
                {variacion && variacion.delta !== 0
                  ? <><b className={variacion.delta > 0 ? 'up' : ''}>{variacion.delta > 0 ? '+' : ''}{formatCount(variacion.delta)}</b> desde el {diaCorto(variacion.fromDay)} · {variacion.videos} {variacion.videos === 1 ? 'vídeo comparable' : 'vídeos comparables'}</>
                  : variacion ? <>Sin cambios desde el {diaCorto(variacion.fromDay)}</>
                  : <>{formatCount(total.likes)} likes · {formatCount(total.comments)} comentarios</>}
              </div>
            </div>
            <div className="tile" data-test="stats-earning" title="Visitas × pago de la campaña, solo en vídeos que superan el mínimo. Lo que paga de verdad lo decide Vyro.">
              <div className="k"><i className="sw c-money" />Ganancia estimada<span className="est">est.</span></div>
              <div className="v">{formatMoney(total.earning)}</div>
              <div className="s">{sinCondiciones > 0 ? `${sinCondiciones} ${sinCondiciones === 1 ? 'vídeo medido no cuenta' : 'vídeos medidos no cuentan'}: su campaña no tiene condiciones de pago` : 'Cálculo propio; lo que se paga lo decide Vyro'}</div>
            </div>
            <div className="tile">
              <div className="k"><i className="sw c-goal" />Vídeos que cobran</div>
              <div className="v">{cobran.length}<span className="of"> de {conCondiciones.length}</span></div>
              {conCondiciones.length > 0
                ? <><div className="meter"><i style={{ width: `${(cobran.length / conCondiciones.length) * 100}%` }} /></div><div className="s">{total.belowMin > 0 ? `${total.belowMin} por debajo del mínimo de visitas` : 'Todos superan el mínimo'}</div></>
                : <div className="s">Ningún vídeo medido tiene condiciones de pago</div>}
            </div>
            <div className="tile">
              <div className="k"><i className="sw c-neutral" />Vídeos medidos</div>
              <div className="v">{total.measured}<span className="of"> de {total.published}</span></div>
              {total.published > 0 && <div className="meter neutral"><i style={{ width: `${(total.measured / total.published) * 100}%` }} /></div>}
              <div className="s">{total.published - total.measured > 0 ? `${total.published - total.measured} sin cifras (sin URL o plataforma sin lectura)` : 'Todos tienen cifras'}</div>
            </div>
          </div>

          <Panel title="Visitas ganadas por día" test="stats-daily"
            hint="Lo que sumaron los vídeos cada día frente al día anterior medido. Pulsa una barra para ver qué vídeos tiraron de ese día."
            aside={<div className="seg small" data-test="stats-daily-mode">{([['dia', 'Por día'], ['semana', 'Por semana']] as [VistaDias, string][]).map(([v, t]) => <button key={v} className={vistaDias === v ? 'on' : ''} onClick={() => { setVistaDias(v); setDiaSel(null) }}>{t}</button>)}</div>}>
            {barras.length === 0 ? (
              <SinDatos>Para ver lo ganado cada día hacen falta mediciones de al menos dos días distintos.</SinDatos>
            ) : (
              <div className="day-grid">
                <GainBars data={barras} selected={clave} onSelect={setDiaSel} unit={vistaDias === 'dia' ? 'día' : 'semana'} />
                {sel && clave && (
                  <div className="day-detail" data-test="stats-day-detail">
                    <div className="dd-h"><span className="dd-day">{vistaDias === 'dia' ? diaLargo(clave) : barras[idxSel]?.label.replace(/^semana/, 'Semana')}</span></div>
                    <div className="dd-v">+{formatCount(sel.gain)}<small>visitas</small></div>
                    {anterior && anterior.value > 0 && !barras[idxSel]?.label.endsWith('(en curso)') && (
                      <div className="dd-cmp">
                        <b className={sel.gain >= anterior.value ? 'up' : 'down'}>{sel.gain >= anterior.value ? '▲' : '▼'} {Math.abs(Math.round(((sel.gain - anterior.value) / anterior.value) * 100))} %</b> frente {vistaDias === 'dia' ? `al ${anterior.label}` : 'a la semana anterior'}
                      </div>
                    )}
                    {topSel.length === 0 ? <p className="faint small">Ningún vídeo sumó visitas.</p> : (
                      <div className="dd-list">
                        {topSel.map(([id, g]) => {
                          const v = titulos.get(id)
                          return (
                            <button key={id} className="dd-item" onClick={() => v && props.onOpen(v.clipId)} title={v?.campaignName ?? undefined}>
                              <span className="t">{v?.title ?? v?.clipId ?? `Vídeo ${id}`}{v && <span className="p"> · {PLATFORM_LABEL[v.platform]}</span>}</span>
                              <span className="n">+{formatCount(g)}</span>
                              <span className="b"><i style={{ width: `${Math.max(2, (g / topSel[0][1]) * 100)}%` }} /></span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Panel>

          <div className="grid-2">
            <Panel title="Evolución de las visitas" test="stats-evolution"
              hint="Total medido cada día: la suma de la última medición de cada vídeo. Solo aparecen los días en que la aplicación midió."
              aside={<div className="seg small">{([[7, '7 días'], [28, '28 días'], [0, 'Todo']] as [Rango, string][]).map(([r, t]) => <button key={r} className={rango === r ? 'on' : ''} onClick={() => setRango(r)}>{t}</button>)}</div>}>
              {dias.length >= 2 ? (
                <>
                  <LineChart data={dias} />
                  <div className="legend">
                    <span><i className="sw c-views" />Visitas medidas</span>
                    {dias.some((d) => d.gapBefore) && <span className="faint">Los tramos sin línea son días sin mediciones (aplicación cerrada)</span>}
                    {dias[dias.length - 1].videos !== dias[0].videos && <span className="faint">El total también sube cuando se mide un vídeo por primera vez ({dias[0].videos} → {dias[dias.length - 1].videos} vídeos)</span>}
                  </div>
                </>
              ) : dias.length === 1 ? (
                <SinDatos>Solo hay mediciones de un día ({diaCorto(dias[0].day)}: {formatCount(dias[0].views)} visitas{rango ? ' en este rango' : ''}). La evolución aparece cuando haya mediciones de al menos dos días distintos.</SinDatos>
              ) : (
                <SinDatos>{rango ? 'No hay mediciones en este rango de fechas.' : 'Aún no hay mediciones guardadas. Se guardan solas con la aplicación abierta.'}</SinDatos>
              )}
            </Panel>

            <Panel title="Camino al cobro" test="stats-goal" hint="Visitas de cada vídeo frente al mínimo de su campaña. Arriba, los que están más cerca de llegar.">
              {camino.length === 0 ? (
                <SinDatos>Ningún vídeo medido pertenece a una campaña con condiciones de pago. Se ponen en la pantalla de cada campaña, botón «Condiciones…».</SinDatos>
              ) : (
                <div className="goals">
                  {camino.slice(0, 8).map(({ v, minimo, progreso }) => {
                    const cobra = v.earningState !== 'below_min'
                    return (
                      <button key={v.publicationId} className="goal" onClick={() => props.onOpen(v.clipId)} title={`${v.title ?? v.clipId} · ${v.campaignName}`}>
                        <span className="goal-t ell">{v.title ?? v.clipId}</span>
                        <span className={`goal-v ${cobra ? 'ok' : ''}`}>{cobra ? formatMoney(v.earning) + (v.earningState === 'capped' ? ' · tope' : '') : `faltan ${formatCount(v.missingViews)}`}</span>
                        <span className={`goal-bar ${cobra ? 'done' : ''}`}><i style={{ width: `${Math.max(1.5, progreso * 100)}%` }} /></span>
                        <span className="goal-s">{formatCount(v.views)}{minimo ? ` de ${formatCount(minimo)} visitas` : ' visitas · sin mínimo'}</span>
                      </button>
                    )
                  })}
                  {camino.length > 8 && <p className="faint small">Y {camino.length - 8} más en la tabla de abajo.</p>}
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Por canal, en orden de subida" test="stats-accounts"
            hint="Cada barra es un vídeo, del más antiguo al más reciente, todos a la misma escala. Sirve para ver si un canal deja de recibir visitas."
            aside={<div className="legend compact"><span><i className="sw c-views" />Visitas</span><span><i className="sw c-zero" />0 visitas</span><span><i className="sw c-unmeasured" />Sin medir</span><span className="faint">escala: 0 – {compact(niceMax(maxVideo))}</span></div>}>
            {tiras.length === 0 ? <SinDatos>No hay publicaciones en esta plataforma.</SinDatos> : (
              <div className="strips">
                {tiras.map((t) => (
                  <div className="strip-row" key={t.lista[0].platform + t.lista[0].account} data-test="stats-account">
                    <div className="strip-l">
                      <div className="strip-n ell">{t.lista[0].account || '(sin cuenta)'}</div>
                      <div className="faint small">{PLATFORM_LABEL[t.lista[0].platform]} · {t.lista.length} {t.lista.length === 1 ? 'vídeo' : 'vídeos'}</div>
                    </div>
                    <StripChart max={maxVideo} items={t.lista.map((v) => ({ key: v.publicationId, title: v.title ?? v.clipId, views: v.views, date: v.publishedAt, onClick: () => props.onOpen(v.clipId) }))} />
                    <div className="strip-r">
                      <div><b>{t.medidos ? formatCount(t.visitas) : '—'}</b> <span className="faint">visitas</span></div>
                      <div className="faint small">{t.medidos ? `media ${formatCount(t.visitas / t.medidos)}` : 'sin cifras'}{t.ceros > 0 && <span className="bad"> · {t.ceros} a cero</span>}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {campañasVisibles.length > 0 && (
            <Panel title="Por campaña" hint="Visitas medidas de los vídeos publicados de cada campaña.">
              <div className="rows flat" data-test="stats-campaigns">
                <div className="row hdr cols-camp2">
                  <span>Campaña</span><span>Visitas</span><span className="num">Publicados</span><span className="num">Media</span><span className="num">Ganado (est.)</span><span>Plazo</span>
                </div>
                {campañasVisibles.map((c) => {
                  const info = campañas.get(c.campaignId)
                  return (
                    <div className="row cols-camp2 static" key={c.campaignId}>
                      <span className="ell2"><span className="ell">{c.name}</span><span className="ell faint small">{c.bestTitle ? `Mejor: ${c.bestTitle} · ${formatCount(c.bestViews)}` : 'Sin vídeos medidos'}</span></span>
                      <span className="hbar">{c.measured ? <><i style={{ width: `${Math.max(1, (c.views / maxCampaña) * 100)}%` }} /><b>{formatCount(c.views)}</b></> : <span className="faint">sin medir</span>}</span>
                      <span className="num muted">{c.published} de {c.clips}</span>
                      <span className="num muted">{formatCount(c.measured ? c.views / c.measured : null)}</span>
                      <span className={`num ${c.earning ? 'ok' : 'muted'}`} title={c.earning == null ? 'Esta campaña no tiene condiciones de pago: ponlas en su pantalla' : c.belowMin ? `${c.belowMin} sin llegar al mínimo` : undefined}>{c.earning == null ? 'sin datos' : formatMoney(c.earning)}</span>
                      <span>{!info ? '—' : info.closed ? <span className="chip-s closed">Cerrada</span> : info.daysLeft != null ? <span className={`chip-s ${info.daysLeft <= 3 ? 'warn' : 'open'}`}>{info.daysLeft === 1 ? 'Último día' : `${info.daysLeft} días`}</span> : <span className="chip-s">Sin plazo</span>}</span>
                    </div>
                  )
                })}
              </div>
            </Panel>
          )}

          {stats.unmatched.length > 0 && (
            <Panel title={`Vídeos de tu canal sin emparejar · ${stats.unmatched.length}`} test="stats-unmatched" className="attn"
              hint="No he podido saber con seguridad a qué clip corresponden. Elige el clip, o márcalo como ajeno si no es de ninguna campaña.">
              <div className="rows flat">
                {stats.unmatched.map((v) => (
                  <UnmatchedRow key={v.videoId} video={v} stats={stats}
                    onLink={(clipId) => aplicar(() => window.contentOS.youtubeLinkVideo(v.videoId, clipId))}
                    onIgnore={() => aplicar(() => window.contentOS.youtubeIgnoreVideo(v.videoId, true))} />
                ))}
              </div>
            </Panel>
          )}

          <Panel title={`Por vídeo · ${videos.length}`} hint="Pulsa una cabecera para ordenar; un clic en la fila abre el clip."
            aside={cajaTikTok}>
            {avisosTikTok}
            <div className="rows flat" data-test="stats-videos">
              <div className="row hdr cols-stats2">
                <span /><span>Clip</span><span>Dónde</span><Th clave="date">Subido</Th>
                <Th clave="views" num>Visitas</Th><span>Tendencia</span><span className="num">Desde la anterior</span><Th clave="perDay" num>Por día</Th>
                <span className="num">Likes</span><span className="num">Com.</span><Th clave="earning" num>Ganado (est.)</Th><Th clave="score" num>Score</Th>
              </div>
              {filas.map((v) => (
                <VideoRow key={v.publicationId} v={v} serie={porVideo.get(v.publicationId)} onOpen={props.onOpen} onUnlink={() => v.videoId && aplicar(() => window.contentOS.youtubeUnlinkVideo(v.videoId!))} />
              ))}
            </div>
            {stats.ignored > 0 && <p className="faint small" style={{ marginTop: 8 }}>{stats.ignored} vídeos del canal marcados como ajenos a los clips.</p>}
          </Panel>
        </>
      )}
    </>
  )
}

function VideoRow({ v, serie, onOpen, onUnlink }: { v: StatsVideo; serie: SeriesPoint[] | undefined; onOpen: (clipId: string) => void; onUnlink: () => void }) {
  const sinMedir = v.views == null
  return (
    <div className="row cols-stats2" role="button" tabIndex={0} data-test="stats-row" data-clip={v.clipId} onClick={() => onOpen(v.clipId)} onKeyDown={(e) => e.key === 'Enter' && onOpen(v.clipId)}>
      <Thumb clip={{ clipId: v.clipId, hasThumb: v.hasThumb, thumbVersion: v.thumbVersion }} />
      <span className="ell2">
        <span className="ell">{v.title ?? v.clipId}</span>
        <span className="ell muted small">
          {v.campaignName}
          {v.matchState === 'auto' && (
            <>
              {' · '}
              <span title={`Emparejado solo: ${v.matchReason ?? ''}`}>emparejado solo</span>{' '}
              <button className="linkbtn" title="Este vídeo no es de este clip" onClick={(e) => { e.stopPropagation(); onUnlink() }}>¿no es este?</button>
            </>
          )}
        </span>
      </span>
      <span className="ell">
        {v.url ? <a className="ext" href={v.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{PLATFORM_LABEL[v.platform]}</a> : PLATFORM_LABEL[v.platform]}
        {v.account ? <span className="muted"> · {v.account}</span> : null}
      </span>
      <span className="muted">{fecha(v.publishedAt)}</span>
      <span className={`num ${sinMedir ? 'faint' : 'strong'}`} data-test="stats-views" title={v.measuredAt ? `Medido ${relativeTime(v.measuredAt)} · ${v.measurements} mediciones` : undefined}>
        {sinMedir ? (v.platform === 'instagram' ? 'pronto' : v.url ? 'sin medir' : 'sin URL') : formatCount(v.views)}
      </span>
      <span><Sparkline points={serie} /></span>
      <span className={`num ${v.viewsDelta ? 'ok' : 'faint'}`} title={v.previousAt ? `Medición anterior: ${relativeTime(v.previousAt)}` : 'Hace falta una segunda medición'}>
        {v.viewsDelta == null ? '—' : v.viewsDelta > 0 ? `+${formatCount(v.viewsDelta)}` : formatCount(v.viewsDelta)}
      </span>
      <span className="num muted">{formatCount(v.viewsPerDay)}</span>
      <span className="num muted">{formatCount(v.likes)}</span>
      <span className="num muted">{formatCount(v.comments)}</span>
      <span className={`num ${v.earningState === 'earning' || v.earningState === 'capped' ? 'ok' : 'faint'}`} data-test="stats-earned"
        title={v.earningState === 'below_min' ? `Faltan ${formatCount(v.missingViews)} visitas para empezar a cobrar` : v.earningState === 'capped' ? 'Ha llegado al tope por vídeo' : v.earningState === 'no_terms' ? 'La campaña no tiene condiciones de pago' : `Interacción ${pct(v.engagement)}`}>
        {v.earningState === 'below_min' ? `faltan ${formatCount(v.missingViews)}` : v.earningState === 'no_terms' || v.earning == null ? '—' : formatMoney(v.earning) + (v.earningState === 'capped' ? ' (tope)' : '')}
      </span>
      <span className={`num ${v.score == null ? 'faint' : 'muted'}`}>{scoreLabel(v.score)}</span>
    </div>
  )
}

function UnmatchedRow({ video, stats, onLink, onIgnore }: { video: UnmatchedVideo; stats: Stats; onLink: (clipId: string) => void; onIgnore: () => void }) {
  const [clipId, setClipId] = useState('')
  // primero los clips de duración parecida: suelen ser el bueno
  const opciones = [...stats.clipOptions].sort((a, b) => {
    const d = (x: number | null) => (video.durationSeconds != null && x != null ? Math.abs(x - video.durationSeconds) : 999)
    return d(a.duration) - d(b.duration)
  })
  return (
    <div className="row cols-unmatched static" data-test="unmatched-row" data-video={video.videoId}>
      <span className="ell2">
        <a className="ext ell" href={`https://www.youtube.com/shorts/${video.videoId}`} target="_blank" rel="noreferrer">{video.title ?? video.videoId}</a>
        <span className="muted small">{video.channel} · {fecha(video.publishedAt)} · {formatDuration(video.durationSeconds)}</span>
      </span>
      <span className="num">{formatCount(video.views)} <span className="muted small">visitas</span></span>
      <select data-test="unmatched-select" value={clipId} onChange={(e) => setClipId(e.target.value)}>
        <option value="">Elegir clip…</option>
        {opciones.map((o) => (
          <option key={o.clipId} value={o.clipId}>{o.title} — {o.campaignName} ({formatDuration(o.duration)})</option>
        ))}
      </select>
      <button className="btn small" data-test="unmatched-link" disabled={!clipId} onClick={() => onLink(clipId)}>Emparejar</button>
      <button className="btn small ghost" data-test="unmatched-ignore" onClick={onIgnore}>No es un clip</button>
    </div>
  )
}
