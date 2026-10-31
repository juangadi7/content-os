/**
 * Gráficos de CONTENT OS, dibujados en SVG sin bibliotecas.
 * Norma común: solo se dibuja lo que se ha medido. Un cero real, un dato ausente y una estimación
 * se ven distintos, y nunca se une con una línea lo que no se midió.
 */
import { useEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { formatCount } from '../../core/format'
import type { DailyTotal, SeriesPoint } from '../../core/stats-series'

// ---------------------------------------------------------------- utilidades

/** 950 -> "950" · 11860 -> "11,9 mil" · 2400000 -> "2,4 M" */
export function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.', ',').replace(',0', '') + ' M'
  if (n >= 10_000) return (n / 1000).toFixed(1).replace('.', ',').replace(',0', '') + ' mil'
  return formatCount(n)
}

/** Tope redondo para un eje: 11860 -> 12000, 1481 -> 1500, 37 -> 40. */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p
  return 10 * p
}

export const diaCorto = (day: string) => new Date(day + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

// ---------------------------------------------------------------- tooltip

export interface TipState { x: number; y: number; content: ReactNode }

export function useTip(): [TipState | null, (e: ReactMouseEvent, content: ReactNode) => void, () => void] {
  const [tip, setTip] = useState<TipState | null>(null)
  return [tip, (e, content) => setTip({ x: e.clientX, y: e.clientY, content }), () => setTip(null)]
}

export function Tip({ tip }: { tip: TipState | null }) {
  if (!tip) return null
  const derecha = tip.x > window.innerWidth - 260
  // en el <body>: dentro de un panel quedaría atrapado por su contenedor
  return createPortal(
    <div className="tip" role="tooltip" style={{ left: derecha ? undefined : tip.x + 14, right: derecha ? window.innerWidth - tip.x + 14 : undefined, top: Math.min(tip.y + 14, window.innerHeight - 90) }}>
      {tip.content}
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------- evolución (línea)

/**
 * Visitas medidas por día. Un punto por cada día con mediciones; los días consecutivos se unen,
 * los que tienen un hueco entre medias no.
 */
export function LineChart({ data, height = 232 }: { data: DailyTotal[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [activo, setActivo] = useState<number | null>(null)
  const [tip, mostrar, ocultar] = useTip()
  const pad = { l: 56, r: 16, t: 12, b: 28 }
  const ancho = Math.max(w, 320)
  const iw = ancho - pad.l - pad.r
  const ih = height - pad.t - pad.b
  const t0 = new Date(data[0].day + 'T12:00:00').getTime()
  const span = Math.max(1, Math.round((new Date(data[data.length - 1].day + 'T12:00:00').getTime() - t0) / 86_400_000))
  const tope = niceMax(Math.max(...data.map((d) => d.views)))
  const x = (d: DailyTotal) => pad.l + (Math.round((new Date(d.day + 'T12:00:00').getTime() - t0) / 86_400_000) / span) * iw
  const y = (v: number) => pad.t + ih - (v / tope) * ih
  // tramos continuos: se cortan donde faltan días
  const tramos: DailyTotal[][] = []
  for (const d of data) {
    if (!tramos.length || d.gapBefore) tramos.push([d])
    else tramos[tramos.length - 1].push(d)
  }
  const marcas = [0, 0.25, 0.5, 0.75, 1].map((f) => f * tope)
  const paso = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 78))))
  const mover = (e: ReactMouseEvent<SVGRectElement>) => {
    const caja = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - caja.left + pad.l
    let mejor = 0
    data.forEach((d, i) => { if (Math.abs(x(d) - px) < Math.abs(x(data[mejor]) - px)) mejor = i })
    setActivo(mejor)
    const d = data[mejor]
    mostrar(e, (
      <>
        <div className="tip-t">{new Date(d.day + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'long' })}</div>
        <div><span className="sw" style={{ background: 'var(--c-views)' }} />{formatCount(d.views)} visitas medidas</div>
        <div className="tip-s">Suma de la última medición de {d.videos} {d.videos === 1 ? 'vídeo' : 'vídeos'}</div>
      </>
    ))
  }
  return (
    <div ref={ref} className="chart" data-test="chart-evolution">
      {w > 0 && (
        <svg width={ancho} height={height} role="img" aria-label={`Visitas medidas por día, de ${diaCorto(data[0].day)} a ${diaCorto(data[data.length - 1].day)}`}>
          {marcas.map((m) => (
            <g key={m}>
              <line x1={pad.l} x2={ancho - pad.r} y1={y(m)} y2={y(m)} className={m === 0 ? 'axis' : 'grid'} />
              <text x={pad.l - 10} y={y(m) + 4} textAnchor="end" className="tick">{compact(m)}</text>
            </g>
          ))}
          {data.map((d, i) => (i % paso === 0 || i === data.length - 1) && (
            <text key={d.day} x={x(d)} y={height - 8} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} className="tick">{diaCorto(d.day)}</text>
          ))}
          {tramos.filter((t) => t.length > 1).map((t) => (
            <g key={t[0].day}>
              <path d={`M${x(t[0])},${y(0)} ` + t.map((d) => `L${x(d)},${y(d.views)}`).join(' ') + ` L${x(t[t.length - 1])},${y(0)} Z`} className="area" />
              <path d={t.map((d, i) => `${i ? 'L' : 'M'}${x(d)},${y(d.views)}`).join(' ')} className="line" />
            </g>
          ))}
          {activo != null && <line x1={x(data[activo])} x2={x(data[activo])} y1={pad.t} y2={pad.t + ih} className="guide" />}
          {data.map((d, i) => <circle key={d.day} cx={x(d)} cy={y(d.views)} r={i === activo ? 4.5 : 3} className="dot" />)}
          <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" onMouseMove={mover} onMouseLeave={() => { setActivo(null); ocultar() }} />
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  )
}

// ---------------------------------------------------------------- minigráfico de un vídeo

/** Evolución de un vídeo. Con menos de dos mediciones no hay tendencia que enseñar. */
export function Sparkline({ points, width = 84, height = 22 }: { points: SeriesPoint[] | undefined; width?: number; height?: number }) {
  if (!points || points.length < 2) return <span className="faint" title="Hacen falta al menos dos mediciones">—</span>
  const t0 = new Date(points[0].t).getTime()
  const span = new Date(points[points.length - 1].t).getTime() - t0
  if (span <= 0) return <span className="faint">—</span>
  const min = Math.min(...points.map((p) => p.views))
  const max = Math.max(...points.map((p) => p.views))
  const px = (p: SeriesPoint) => 2 + ((new Date(p.t).getTime() - t0) / span) * (width - 6)
  const py = (p: SeriesPoint) => (max === min ? height / 2 : height - 3 - ((p.views - min) / (max - min)) * (height - 6))
  const ultimo = points[points.length - 1]
  const plano = max === min
  return (
    <svg width={width} height={height} className={`spark ${plano ? 'flat' : ''}`} role="img"
      aria-label={plano ? `Sin cambios en ${points.length} mediciones` : `De ${formatCount(points[0].views)} a ${formatCount(ultimo.views)} visitas en ${points.length} mediciones`}>
      <title>{plano ? `Sin cambios en ${points.length} mediciones` : `De ${formatCount(points[0].views)} a ${formatCount(ultimo.views)} en ${points.length} mediciones`}</title>
      <path d={points.map((p, i) => `${i ? 'L' : 'M'}${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(' ')} />
      <circle cx={px(ultimo)} cy={py(ultimo)} r="2" />
    </svg>
  )
}

// ---------------------------------------------------------------- tira por canal

export interface StripItem {
  key: string | number
  title: string
  /** null = sin medir (no es un cero). */
  views: number | null
  date: string | null
  onClick?: () => void
}

/**
 * Un vídeo por barra, en orden de subida. Sirve para ver de un vistazo si un canal deja de recibir
 * visitas. Cero real = marca roja en la base; sin medir = caja discontinua.
 */
export function StripChart({ items, max, height = 72 }: { items: StripItem[]; max: number; height?: number }) {
  const [tip, mostrar, ocultar] = useTip()
  const bw = items.length > 28 ? 9 : 14
  const gap = items.length > 28 ? 3 : 5
  const ancho = items.length * (bw + gap) + 2
  const base = height - 1
  const tope = niceMax(max)
  return (
    <div className="strip">
      <svg width={ancho} height={height} role="img" aria-label={`${items.length} vídeos en orden de subida`}>
        <line x1="0" x2={ancho} y1={base} y2={base} className="axis" />
        {items.map((it, i) => {
          const x0 = 1 + i * (bw + gap)
          const h = it.views == null ? 12 : it.views === 0 ? 3 : Math.max(4, (it.views / tope) * (height - 6))
          const clase = it.views == null ? 'bar unmeasured' : it.views === 0 ? 'bar zero' : 'bar'
          return (
            <rect key={it.key} x={x0} y={base - h} width={bw} height={h} rx="2" className={clase} style={{ cursor: it.onClick ? 'pointer' : 'default' }} onClick={it.onClick}
              onMouseMove={(e) => mostrar(e, (
                <>
                  <div className="tip-t">{it.title}</div>
                  <div>{it.views == null ? 'Sin medir todavía' : `${formatCount(it.views)} ${it.views === 1 ? 'visita' : 'visitas'}`}</div>
                  {it.date && <div className="tip-s">Subido el {new Date(it.date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} a las {new Date(it.date).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>}
                </>
              ))}
              onMouseLeave={ocultar} />
          )
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  )
}

// ---------------------------------------------------------------- ganancia por día / semana (barras)

export interface GainBar {
  /** Día (AAAA-MM-DD) o lunes de la semana. */
  key: string
  label: string
  value: number
  /** Días naturales que cubre la barra cuando la aplicación estuvo cerrada (solo vista diaria). */
  span?: number
  videos: number
}

/**
 * Visitas ganadas por día o por semana. Cada barra es una ganancia medida; una barra rayada
 * acumula varios días porque entre medias no hubo mediciones. Pulsar una barra la selecciona.
 */
export function GainBars({ data, selected, onSelect, unit, height = 220 }: { data: GainBar[]; selected: string | null; onSelect: (key: string) => void; unit: 'día' | 'semana'; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [tip, mostrar, ocultar] = useTip()
  const pad = { l: 52, r: 10, t: 14, b: 26 }
  const ancho = Math.max(w, 320)
  const iw = ancho - pad.l - pad.r
  const ih = height - pad.t - pad.b
  const tope = niceMax(Math.max(1, ...data.map((d) => d.value)))
  const media = data.length ? data.reduce((s, d) => s + d.value, 0) / data.length : 0
  const paso = iw / Math.max(1, data.length)
  const bw = Math.max(3, Math.min(34, paso * 0.68))
  const y = (v: number) => pad.t + ih - (Math.max(0, v) / tope) * ih
  const marcas = [0, 0.5, 1].map((f) => f * tope)
  const cada = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 62))))
  return (
    <div ref={ref} className="chart gains" data-test="chart-gains">
      {w > 0 && (
        <svg width={ancho} height={height} role="img" aria-label={`Visitas ganadas por ${unit}`}>
          <defs>
            <linearGradient id="gainFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--c-views)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="var(--c-views)" stopOpacity="0.45" />
            </linearGradient>
            <pattern id="gainHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--c-views)" opacity="0.35" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--c-views)" strokeWidth="3" />
            </pattern>
          </defs>
          {marcas.map((m) => (
            <g key={m}>
              <line x1={pad.l} x2={ancho - pad.r} y1={y(m)} y2={y(m)} className={m === 0 ? 'axis' : 'grid'} />
              <text x={pad.l - 10} y={y(m) + 4} textAnchor="end" className="tick">{compact(m)}</text>
            </g>
          ))}
          {media > 0 && (
            <g>
              <line x1={pad.l} x2={ancho - pad.r} y1={y(media)} y2={y(media)} className="avg" />
              <text x={pad.l + 6} y={y(media) - 5} textAnchor="start" className="tick avg-t">media {compact(Math.round(media))}</text>
            </g>
          )}
          {data.map((d, i) => {
            const cx = pad.l + paso * i + paso / 2
            const h = Math.max(d.value > 0 ? 2 : 0, ih - (y(d.value) - pad.t))
            const on = selected === d.key
            return (
              <g key={d.key} className={`gbar ${on ? 'on' : ''} ${selected && !on ? 'dim' : ''}`} onClick={() => onSelect(d.key)}
                onMouseMove={(e) => mostrar(e, (
                  <>
                    <div className="tip-t">{d.label}</div>
                    <div><span className="sw" style={{ background: 'var(--c-views)' }} />+{formatCount(d.value)} visitas</div>
                    <div className="tip-s">{d.span && d.span > 1 ? `Acumulado de ${d.span} días (sin mediciones entre medias) · ` : ''}{d.videos} {d.videos === 1 ? 'vídeo comparable' : 'vídeos comparables'}</div>
                  </>
                ))}
                onMouseLeave={ocultar}>
                <rect x={pad.l + paso * i} y={pad.t} width={paso} height={ih} fill="transparent" />
                <rect x={cx - bw / 2} y={pad.t + ih - h} width={bw} height={h} rx={Math.min(4, bw / 3)} fill={d.span && d.span > 1 ? 'url(#gainHatch)' : 'url(#gainFill)'} />
              </g>
            )
          })}
          {data.map((d, i) => (i % cada === 0 || i === data.length - 1) && (
            <text key={'l' + d.key} x={pad.l + paso * i + paso / 2} y={height - 8} textAnchor="middle" className="tick">{d.label.replace(/^semana del /, '').replace(' (en curso)', '*')}</text>
          ))}
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  )
}
