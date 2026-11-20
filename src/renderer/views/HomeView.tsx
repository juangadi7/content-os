import { ArrowUpRight, Download, Eye, Heart, Plus, Timer, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AppState, CalendarItem, OwnChannel, OwnChannelStats } from '../../core/api'
import { compact } from '../components/charts'
import { Bars, MiniLine } from '../components/ownCharts'
import { CANALES, type Section } from '../components/Sidebar'

type Periodo = 'week' | 'month' | 'year'
const DIAS: Record<Periodo, number> = { week: 7, month: 30, year: 365 }

const p2 = (n: number) => String(n).padStart(2, '0')
const diaLocal = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const masDias = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12)

/** Valor acumulado en un día: la última medición hasta ese día (null si aún no había ninguna). */
function valorEn(serie: { day: string; v: number }[], day: string): number | null {
  let r: number | null = null
  for (const x of serie) {
    if (x.day > day) break
    r = x.v
  }
  return r
}

function saludo(h: number) {
  return h < 6 ? 'Buenas noches' : h < 14 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches'
}

/** Inicio: cómo van tus canales (tarjetas de datos, visitas por día, lo de hoy y un acceso a cada canal). */
export function HomeView(props: { state: AppState; refresh: number; showVyro: boolean; onSection: (s: Section) => void; onImport: () => void }) {
  const [canales, setCanales] = useState<OwnChannelStats[] | null>(null)
  const [hoy, setHoy] = useState<CalendarItem[]>([])
  const [periodo, setPeriodo] = useState<Periodo>('week')

  useEffect(() => {
    let vivo = true
    void Promise.all(CANALES.map((c) => window.contentOS.getOwnStats(c.id))).then((x) => vivo && setCanales(x))
    const d = diaLocal(new Date())
    // sin Vyro, solo lo apuntado por ti o por Claude (lo automático del calendario es de las campañas)
    void window.contentOS.getCalendar(d, d).then((c) => vivo && setHoy(c.days[0]?.items.filter((i) => !i.done && (props.showVyro || i.source !== 'auto')) ?? []))
    return () => { vivo = false }
  }, [props.refresh, props.showVyro])

  const datos = useMemo(() => {
    if (!canales) return null
    const ahora = new Date()
    const fin = diaLocal(ahora)
    const n = DIAS[periodo]
    const ini = diaLocal(masDias(ahora, -n))
    const iniAnt = diaLocal(masDias(ahora, -2 * n))
    // visitas acumuladas de todos los canales, por día medido
    const dias = [...new Set(canales.flatMap((c) => c.daily.map((d) => d.day)))].sort()
    const porCanal = canales.map((c) => c.daily.map((d) => ({ day: d.day, v: d.total })))
    const visitas = dias.map((day) => ({ day, v: porCanal.reduce((a, s) => a + (valorEn(s, day) ?? 0), 0) }))
    const ganadas = (desde: string, hasta: string) => {
      const b = valorEn(visitas, hasta)
      return b == null ? null : b - (valorEn(visitas, desde) ?? 0)
    }
    const g = ganadas(ini, fin)
    const gAnt = ganadas(iniAnt, ini)
    const cambio = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : Math.round(((a - b) / b) * 100))

    const vids = canales.flatMap((c) => c.videos)
    const likes = vids.reduce((a, v) => a + (v.likes ?? 0), 0)
    const ret = vids.map((v) => v.retention).filter((x): x is number => x != null)
    // seguidores: suma de la última cifra de cada cuenta; cambio frente al inicio del periodo
    const cuentas = canales.flatMap((c) => c.followers)
    const segHoy = cuentas.reduce((a, f) => a + (f.series.at(-1)?.value ?? 0), 0)
    const segIni = cuentas.reduce((a, f) => a + (valorEn(f.series.map((s) => ({ day: s.t.slice(0, 10), v: s.value })), ini) ?? f.series[0]?.value ?? 0), 0)

    // barras: visitas ganadas por día (o por mes en el año); hueco si ese día no hubo medición
    const barras: { label: string; value: number | null }[] = []
    if (periodo === 'year') {
      for (let m = 11; m >= 0; m--) {
        const a = new Date(ahora.getFullYear(), ahora.getMonth() - m, 1, 12)
        const b = new Date(ahora.getFullYear(), ahora.getMonth() - m + 1, 0, 12)
        const v = ganadas(diaLocal(masDias(a, -1)), diaLocal(b))
        barras.push({ label: a.toLocaleDateString('es-ES', { month: 'short' }), value: dias.some((d) => d >= diaLocal(a) && d <= diaLocal(b)) ? v : null })
      }
    } else {
      for (let i = n - 1; i >= 0; i--) {
        const d = masDias(ahora, -i)
        const day = diaLocal(d)
        const medido = dias.includes(day)
        const antes = dias.filter((x) => x < day).at(-1)
        barras.push({
          label: periodo === 'week' ? d.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '') : String(d.getDate()),
          value: medido && antes ? (valorEn(visitas, day) ?? 0) - (valorEn(visitas, antes) ?? 0) : null
        })
      }
    }
    const enPeriodo = visitas.filter((x) => x.day >= ini).map((x) => x.v)
    return {
      visitas: { total: visitas.at(-1)?.v ?? null, ganadas: g, cambio: cambio(g, gAnt), serie: enPeriodo },
      likes,
      seguidores: cuentas.some((f) => f.series.length)
        ? { total: segHoy, cambio: segIni ? segHoy - segIni : null, serie: [segIni, segHoy] }
        : { total: null, cambio: null, serie: [] },
      retencion: ret.length ? Math.round((ret.reduce((a, b) => a + b, 0) / ret.length) * 10) / 10 : null,
      retN: ret.length,
      barras
    }
  }, [canales, periodo])

  const exportar = () => {
    if (!canales) return
    const filas = [['Canal', 'Vídeo', 'Red', 'Cuenta', 'Subido', 'Visitas', 'Likes', 'Comentarios', 'Compartidos', 'Retención %', 'Enlace']]
    for (const c of canales) for (const v of c.videos) for (const p of v.posts) {
      filas.push([c.name, v.title, p.platform, p.account, p.postedAt ?? '', ...(['views', 'likes', 'comments', 'shares', 'retention'] as const).map((m) => (p.latest[m] == null ? '' : String(p.latest[m]))), p.url ?? ''])
    }
    const csv = '﻿' + filas.map((f) => f.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `content-os_estadisticas_${diaLocal(new Date())}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const s = props.state
  const pendientes: Record<OwnChannel, number> = { gta: s.gtaPending, curio: s.curioPending, roblox: s.robloxPending }
  const signo = (n: number | null, sufijo = '') => (n == null ? null : <span className={`delta ${n >= 0 ? 'up' : 'down'}`}>{n > 0 ? '+' : ''}{n.toLocaleString('es-ES')}{sufijo}</span>)

  return (
    <div className="home" data-test="home">
      <header className="hhead">
        <div>
          <h1>{saludo(new Date().getHours())}, Juan</h1>
          <p className="muted small">Así van tus canales</p>
        </div>
        <span className="sp" />
        <div className="seg pills" data-test="home-period">
          {(['week', 'month', 'year'] as Periodo[]).map((p) => (
            <button key={p} className={periodo === p ? 'on' : ''} onClick={() => setPeriodo(p)}>{p === 'week' ? 'Semana' : p === 'month' ? 'Mes' : 'Año'}</button>
          ))}
        </div>
        <button className="btn pill glass" data-test="home-export" onClick={exportar}><Download size={14} />Exportar</button>
      </header>

      {datos && (
        <section className="kpis four">
          <div className="kpi glass lift k-views" data-test="home-kpi-views">
            <span className="kicon"><Eye size={15} /></span>
            <span className="klbl">Visitas ganadas</span>
            <span className="knum">{datos.visitas.ganadas == null ? '—' : compact(datos.visitas.ganadas)}</span>
            <span className="kfoot">{signo(datos.visitas.cambio, ' %') ?? <span className="faint small">{datos.visitas.total == null ? 'sin mediciones' : `${compact(datos.visitas.total)} en total`}</span>}<MiniLine values={datos.visitas.serie} cls="views" /></span>
          </div>
          <div className="kpi glass lift k-likes" data-test="home-kpi-likes">
            <span className="kicon"><Heart size={15} /></span>
            <span className="klbl">Likes</span>
            <span className="knum">{compact(datos.likes)}</span>
            <span className="kfoot"><span className="faint small">en todos los vídeos</span></span>
          </div>
          <div className="kpi glass lift k-followers" data-test="home-kpi-followers">
            <span className="kicon"><Users size={15} /></span>
            <span className="klbl">Seguidores</span>
            <span className="knum">{datos.seguidores.total == null ? '—' : compact(datos.seguidores.total)}</span>
            <span className="kfoot">{signo(datos.seguidores.cambio) ?? <span className="faint small">apunta tus cuentas</span>}<MiniLine values={datos.seguidores.serie} cls="followers" /></span>
          </div>
          <div className="kpi glass lift k-retention" data-test="home-kpi-retention">
            <span className="kicon"><Timer size={15} /></span>
            <span className="klbl">Retención media</span>
            <span className="knum">{datos.retencion == null ? '—' : `${datos.retencion.toLocaleString('es-ES')} %`}</span>
            <span className="kfoot"><span className="faint small">{datos.retN ? `de ${datos.retN} ${datos.retN === 1 ? 'vídeo' : 'vídeos'} (a mano)` : 'se apunta a mano'}</span></span>
          </div>
        </section>
      )}

      <div className="hgrid">
        <section className="opanel glass">
          <div className="ohead">
            <div>
              <h3>Visitas por {periodo === 'year' ? 'mes' : 'día'}</h3>
              <p className="faint small">Ganadas en tus 3 canales, según las mediciones</p>
            </div>
            {datos?.visitas.cambio != null && <span className={`delta ${datos.visitas.cambio >= 0 ? 'up' : 'down'}`}>{datos.visitas.cambio > 0 ? '+' : ''}{datos.visitas.cambio} % vs {periodo === 'week' ? 'semana' : periodo === 'month' ? 'mes' : 'año'} anterior</span>}
          </div>
          {datos && <Bars items={datos.barras} height={210} />}
        </section>

        <section className="opanel glass today-col" data-test="home-today">
          <div className="ohead">
            <div>
              <h3>Hoy</h3>
              <p className="faint small">{new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            </div>
            <button className="btn small ghost round" title="Añadir vídeos" onClick={props.onImport}><Plus size={14} /></button>
          </div>
          <ul className="tasks">
            {CANALES.filter((c) => pendientes[c.id] > 0).map((c) => (
              <li key={c.id} className={`task ${c.color}`} onClick={() => props.onSection(c.id)}>
                <strong>{c.nombre}</strong>
                <span className="faint small">{pendientes[c.id]} {pendientes[c.id] === 1 ? 'vídeo sin subir' : 'vídeos sin subir'} · 1 al día</span>
              </li>
            ))}
            {props.showVyro && s.vyroToSend > 0 && (
              <li className="task verde" onClick={() => props.onSection('today')}>
                <strong>Enviar {s.vyroToSend} {s.vyroToSend === 1 ? 'vídeo' : 'vídeos'} a Vyro</strong>
                <span className="faint small">Ya están publicados</span>
              </li>
            )}
            {hoy.slice(0, 5).map((i) => (
              <li key={i.id} className="task gris" onClick={() => props.onSection('calendar')}>
                <strong>{i.title}</strong>
                <span className="faint small">{[i.time, i.detail].filter(Boolean).join(' · ') || 'Calendario'}</span>
              </li>
            ))}
            {CANALES.every((c) => !pendientes[c.id]) && (!props.showVyro || s.vyroToSend === 0) && hoy.length === 0 && <li className="faint small">Nada pendiente para hoy.</li>}
          </ul>
        </section>
      </div>

      <section className={`chcards ${props.showVyro ? '' : 'three'}`}>
        {CANALES.map((c) => {
          const st = canales?.find((x) => x.channel === c.id)
          const vis = st?.videos.reduce((a, v) => a + (v.views ?? 0), 0) ?? 0
          return (
            <button key={c.id} className={`chcard glass lift ${c.color}`} data-test={`home-channel-${c.id}`} onClick={() => props.onSection(`${c.id}-stats`)}>
              <span className="chband"><c.icon size={18} /></span>
              <strong>{c.nombre}</strong>
              <span className="faint small">{s.ownVideos[c.id]} {s.ownVideos[c.id] === 1 ? 'vídeo' : 'vídeos'} · {vis ? `${compact(vis)} visitas` : 'sin cifras aún'}</span>
            </button>
          )
        })}
        {props.showVyro && <button className="chcard glass lift verde" data-test="home-channel-vyro" onClick={() => props.onSection('today')}>
          <span className="chband"><ArrowUpRight size={18} /></span>
          <strong>Vyro</strong>
          <span className="faint small">{s.vyroToSend} por enviar · {s.vyroNew} {s.vyroNew === 1 ? 'nueva' : 'nuevas'}</span>
        </button>}
      </section>
    </div>
  )
}
