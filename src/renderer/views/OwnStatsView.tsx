import { ArrowDown, ArrowUp, ClipboardPen, ExternalLink, Info } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { DataSource, Metric, OwnChannel, OwnChannelStats, OwnPlatform, OwnVideoStats } from '../../core/api'
import { compact, diaCorto } from '../components/charts'
import { Bars, Lines, type LineSerie } from '../components/ownCharts'
import { OwnStatsForm, RED_NOMBRE } from '../components/OwnStatsForm'
import { PageHeader } from '../components/PageHeader'

type Filtro = 'all' | OwnPlatform
type Clave = 'postedAt' | 'views' | 'likes' | 'comments' | 'shares' | 'retention'
const REDES: OwnPlatform[] = ['tiktok', 'youtube', 'instagram']
const ETIQUETA: Record<Metric, string> = { views: 'Visitas', likes: 'Likes', comments: 'Comentarios', shares: 'Compartidos', retention: 'Retención' }

/** De dónde puede salir cada dato en cada red (lo que permiten sus API hoy). */
const ORIGEN_POSIBLE: Record<OwnPlatform, Record<Metric, string>> = {
  tiktok: { views: 'API (cuenta conectada) o a mano', likes: 'API o a mano', comments: 'API o a mano', shares: 'API o a mano', retention: 'A mano (TikTok Studio)' },
  youtube: { views: 'API (clave de YouTube)', likes: 'API', comments: 'API', shares: 'A mano (YouTube no lo da)', retention: 'A mano (YouTube Studio)' },
  instagram: { views: 'A mano (la conexión actual no las da)', likes: 'API o a mano', comments: 'API o a mano', shares: 'A mano', retention: 'A mano' }
}

const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString('es-ES'))
const pct = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`)
const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : '—')

/** Cifras de un vídeo con el filtro de red aplicado. */
function cifras(v: OwnVideoStats, f: Filtro): Record<Metric, number | null> & { origins: DataSource[] } {
  const ps = f === 'all' ? v.posts : v.posts.filter((p) => p.platform === f)
  const suma = (m: Metric) => (ps.some((p) => p.latest[m] != null) ? ps.reduce((a, p) => a + (p.latest[m] ?? 0), 0) : null)
  const ret = ps.map((p) => p.latest.retention).filter((x): x is number => x != null)
  return {
    views: suma('views'), likes: suma('likes'), comments: suma('comments'), shares: suma('shares'),
    retention: ret.length ? Math.round((ret.reduce((a, b) => a + b, 0) / ret.length) * 10) / 10 : null,
    origins: [...new Set(ps.flatMap((p) => Object.values(p.origin)))] as DataSource[]
  }
}

export function Fuente({ s }: { s: DataSource[] | undefined }) {
  if (!s || !s.length) return <span className="src none">sin datos</span>
  return <>{s.map((x) => <span key={x} className={`src ${x}`}>{x === 'api' ? 'API' : x === 'manual' ? 'a mano' : 'Metricool'}</span>)}</>
}

export function OwnStatsView(props: { channel: OwnChannel; refresh: number }) {
  const [d, setD] = useState<OwnChannelStats | null>(null)
  const [filtro, setFiltro] = useState<Filtro>('all')
  const [orden, setOrden] = useState<{ k: Clave; asc: boolean }>({ k: 'views', asc: false })
  const [comparar, setComparar] = useState<string[]>([])
  const [form, setForm] = useState<OwnVideoStats | null>(null)

  useEffect(() => {
    let vivo = true
    void window.contentOS.getOwnStats(props.channel).then((x) => vivo && setD(x))
    return () => { vivo = false }
  }, [props.channel, props.refresh])

  const filas = useMemo(() => {
    if (!d) return []
    const r = d.videos.map((v) => ({ v, c: cifras(v, filtro) })).filter((x) => filtro === 'all' || x.v.posts.some((p) => p.platform === filtro))
    const val = (x: (typeof r)[number]) => (orden.k === 'postedAt' ? (x.v.postedAt ? Date.parse(x.v.postedAt) : null) : x.c[orden.k])
    return r.sort((a, b) => {
      const va = val(a)
      const vb = val(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      return orden.asc ? va - vb : vb - va
    })
  }, [d, filtro, orden])

  if (!d) return null

  const total = (m: Metric) => {
    const xs = filas.map((x) => x.c[m]).filter((n): n is number => n != null)
    if (!xs.length) return null
    return m === 'retention' ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : xs.reduce((a, b) => a + b, 0)
  }
  const fuentes = (m: Metric): DataSource[] => [...new Set((filtro === 'all' ? REDES : [filtro]).flatMap((p) => d.sources[p][m] ?? []))]

  // evolución: visitas acumuladas por día y red (solo días medidos)
  const dia0 = d.daily[0] ? Date.parse(d.daily[0].day + 'T12:00:00') : 0
  const xDia = (day: string) => Math.round((Date.parse(day + 'T12:00:00') - dia0) / 864e5)
  const evol: LineSerie[] = (filtro === 'all' ? REDES : [filtro]).map((p) => ({
    name: RED_NOMBRE[p], cls: p,
    points: d.daily.filter((x) => x.byPlatform[p] != null).map((x) => ({ x: xDia(x.day), y: x.byPlatform[p] as number, label: diaCorto(x.day) }))
  })).filter((s) => s.points.length)

  // comparación: visitas según las horas desde que se subió (la subida con más visitas de cada vídeo)
  const serieDe = (id: string, cls: string): LineSerie | null => {
    const v = d.videos.find((x) => x.id === id)
    if (!v) return null
    const ps = (filtro === 'all' ? v.posts : v.posts.filter((p) => p.platform === filtro)).filter((p) => p.series.length && p.postedAt)
    const p = ps.sort((a, b) => (b.latest.views ?? 0) - (a.latest.views ?? 0))[0]
    if (!p) return { name: v.title, cls, points: [] }
    const t0 = Date.parse(p.postedAt as string)
    return { name: `${v.title} (${RED_NOMBRE[p.platform]})`, cls, points: p.series.map((s) => ({ x: Math.max(0, (Date.parse(s.t) - t0) / 3600_000), y: s.views, label: `${Math.round((Date.parse(s.t) - t0) / 3600_000)} h` })) }
  }
  const comparadas = comparar.map((id, i) => serieDe(id, i === 0 ? 'a' : 'b')).filter((s): s is LineSerie => !!s)

  const pocos = d.bestHours.every((h) => h.videos < 3)
  const mejor = [...d.bestHours].filter((h) => h.videos >= 3 && h.median != null).sort((a, b) => (b.median ?? 0) - (a.median ?? 0))[0]

  const cabecera = (k: Clave, txt: string) => (
    <button className={`th ${orden.k === k ? 'on' : ''}`} onClick={() => setOrden({ k, asc: orden.k === k ? !orden.asc : false })}>
      {txt}{orden.k === k && (orden.asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  )

  return (
    <>
      <PageHeader title={`${d.name} · estadísticas`} titleTest="own-stats-title"
        meta={<span>{d.videos.length} {d.videos.length === 1 ? 'vídeo' : 'vídeos'} · {d.accounts.length ? d.accounts.map((a) => `${RED_NOMBRE[a.platform]} ${a.account}`).join(' · ') : 'sin cuentas apuntadas'}</span>}>
        <div className="seg pills" data-test="own-stats-filter">
          {(['all', ...REDES] as Filtro[]).map((f) => (
            <button key={f} className={filtro === f ? 'on' : ''} onClick={() => setFiltro(f)}>{f === 'all' ? 'Todas' : RED_NOMBRE[f]}</button>
          ))}
        </div>
      </PageHeader>

      {d.accounts.length === 0 && (
        <div className="banner glass"><Info size={15} /><span>Apunta las cuentas de este canal en «Cuentas» para que las cifras de YouTube y de las cuentas conectadas lleguen solas. Mientras, puedes apuntarlas a mano en cada vídeo.</span></div>
      )}

      <section className="kpis">
        {(['views', 'likes', 'comments', 'shares', 'retention'] as Metric[]).map((m) => (
          <div key={m} className={`kpi glass lift k-${m}`} data-test={`own-kpi-${m}`}>
            <span className="klbl">{ETIQUETA[m]}{m === 'retention' && ' media'}</span>
            <span className="knum">{m === 'retention' ? pct(total(m)) : total(m) == null ? '—' : compact(total(m) as number)}</span>
            <span className="kfoot"><Fuente s={fuentes(m)} /></span>
          </div>
        ))}
      </section>

      <div className="ogrid">
        <section className="opanel glass">
          <h3>Evolución de visitas</h3>
          <p className="faint small">Visitas acumuladas cada día que hay mediciones, por red.</p>
          <Lines series={evol} xLabel={(x) => diaCorto(new Date(dia0 + x * 864e5).toISOString().slice(0, 10))} />
          <div className="legend">{evol.map((s) => <span key={s.name} className={`lg ${s.cls}`}>{s.name}</span>)}</div>
        </section>
        <section className="opanel glass">
          <h3>Mejor hora para subir</h3>
          <p className="faint small">Mediana de visitas a las ~48 h según la hora de subida.</p>
          <Bars height={170} items={d.bestHours.map((h) => ({ label: `${h.from}h`, value: h.videos ? h.median : null, hint: `${h.videos} ${h.videos === 1 ? 'vídeo' : 'vídeos'}` }))} />
          <p className={`small ${pocos ? 'warn' : ''}`} data-test="own-best-hour">
            {pocos ? 'Pocos datos: hacen falta al menos 3 vídeos medidos por franja para fiarse.' : mejor ? `Mejor franja: de ${mejor.from}:00 a ${mejor.from + 3}:00 (${mejor.videos} vídeos).` : 'Sin franja clara todavía.'}
          </p>
        </section>
      </div>

      <section className="opanel glass">
        <div className="ohead">
          <h3>Vídeos</h3>
          <span className="faint small">Marca 2 para compararlos · pulsa una cabecera para ordenar</span>
        </div>
        <div className="otable" data-test="own-table">
          <div className="orow hdr">
            <span />
            <span>Vídeo</span>
            {cabecera('postedAt', 'Subido')}
            {cabecera('views', 'Visitas')}
            {cabecera('likes', 'Likes')}
            {cabecera('comments', 'Coment.')}
            {cabecera('shares', 'Compart.')}
            {cabecera('retention', 'Retención')}
            <span />
          </div>
          {filas.map(({ v, c }) => (
            <div key={v.id} className="orow" data-test="own-row">
              <input type="checkbox" aria-label="Comparar" checked={comparar.includes(v.id)}
                onChange={(e) => setComparar((x) => (e.target.checked ? [...x.filter((i) => i !== v.id), v.id].slice(-2) : x.filter((i) => i !== v.id)))} />
              <span className="ell" title={v.title}>
                {v.title}
                <span className="redes">{v.posts.map((p) => (
                  <a key={p.platform} className={`rchip ${p.platform}`} title={`${RED_NOMBRE[p.platform]} ${p.account}${p.url ? '' : ' · sin enlace'}`}
                    href={p.url ?? undefined} target="_blank" rel="noreferrer">{RED_NOMBRE[p.platform][0]}{p.url && <ExternalLink size={9} />}</a>
                ))}</span>
              </span>
              <span className="num faint">{fecha(v.postedAt)}</span>
              <span className="num">{fmt(c.views)}</span>
              <span className="num">{fmt(c.likes)}</span>
              <span className="num">{fmt(c.comments)}</span>
              <span className="num">{fmt(c.shares)}</span>
              <span className="num">{pct(c.retention)}</span>
              <button className="btn small ghost" title="Apuntar cifras a mano" data-test="own-add-stats" onClick={() => setForm(v)}><ClipboardPen size={13} /></button>
            </div>
          ))}
          {filas.length === 0 && <p className="faint small pad">Ningún vídeo subido a esta red todavía.</p>}
        </div>
      </section>

      {comparar.length > 0 && (
        <section className="opanel glass" data-test="own-compare">
          <h3>Comparación</h3>
          <p className="faint small">{comparar.length < 2 ? 'Marca otro vídeo para compararlos.' : 'Visitas según las horas desde que se subió cada uno.'}</p>
          <Lines series={comparadas} xLabel={(x) => `${Math.round(x)} h`} />
          <div className="legend">{comparadas.map((s) => <span key={s.name} className={`lg ${s.cls}`}>{s.name}</span>)}</div>
          {comparar.length === 2 && (() => {
            const [a, b] = comparar.map((id) => d.videos.find((v) => v.id === id)).map((v) => (v ? cifras(v, filtro) : null))
            if (!a || !b) return null
            return (
              <div className="cmp">
                {(['views', 'likes', 'comments', 'shares', 'retention'] as Metric[]).map((m) => (
                  <div key={m}><span className="faint small">{ETIQUETA[m]}</span><span className="a">{m === 'retention' ? pct(a[m]) : fmt(a[m])}</span><span className="b">{m === 'retention' ? pct(b[m]) : fmt(b[m])}</span></div>
                ))}
              </div>
            )
          })()}
        </section>
      )}

      <section className="opanel glass" data-test="own-sources">
        <h3>De dónde sale cada dato</h3>
        <div className="srctable">
          <span />{REDES.map((p) => <strong key={p}>{RED_NOMBRE[p]}</strong>)}
          {(['views', 'likes', 'comments', 'shares', 'retention'] as Metric[]).map((m) => (
            <div key={m} style={{ display: 'contents' }}>
              <span className="faint">{ETIQUETA[m]}</span>
              {REDES.map((p) => <span key={p} className="small">{ORIGEN_POSIBLE[p][m]}</span>)}
            </div>
          ))}
        </div>
        <p className="faint small">Las etiquetas «API» y «a mano» de cada cifra dicen de dónde salió de verdad. Cuando la subida la haga Metricool, sus cifras saldrán como «Metricool».</p>
      </section>

      {form && <OwnStatsForm channel={props.channel} video={form.id} title={form.title} onDone={setD} onClose={() => setForm(null)} />}
    </>
  )
}
