/**
 * Gráficos de los canales propios (Inicio y Estadísticas). SVG sin bibliotecas.
 * Misma norma que charts.tsx: solo se dibuja lo medido; un día sin medición no se inventa.
 */
import { useEffect, useRef, useState } from 'react'
import { compact, niceMax, Tip, useTip } from './charts'

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

/** Barras con la más alta resaltada en azul (como el panel de referencia). */
export function Bars({ items, height = 180, unit = 'visitas' }: { items: { label: string; value: number | null; hint?: string }[]; height?: number; unit?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [tip, mostrar, ocultar] = useTip()
  const max = Math.max(0, ...items.map((i) => i.value ?? 0))
  const tope = niceMax(max)
  const base = height - 22
  const n = Math.max(1, items.length)
  const hueco = Math.max(6, Math.min(28, (w / n) * 0.35))
  const ancho = Math.max(6, (w - 36 - hueco * n) / n)
  return (
    <div ref={ref} className="obars">
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={`${unit} por día`}>
          {max > 0 && [0.5, 1].map((f) => (
            <g key={f}>
              <line x1={36} x2={w} y1={base - (base - 8) * f} y2={base - (base - 8) * f} className="grid" />
              <text x={30} y={base - (base - 8) * f + 4} className="ylab" textAnchor="end">{compact(tope * f)}</text>
            </g>
          ))}
          {max === 0 && <text x={w / 2} y={base / 2} className="ylab" textAnchor="middle">Aún no hay visitas medidas en este periodo</text>}
          {items.map((it, i) => {
            const x = 36 + hueco / 2 + i * (ancho + hueco)
            const h = it.value == null ? 0 : Math.max(3, (it.value / tope) * (base - 8))
            const top = it.value != null && it.value === max && max > 0
            return (
              <g key={i} onMouseMove={(e) => mostrar(e, <><strong>{it.label}</strong><br />{it.value == null ? 'Sin medir' : `${it.value.toLocaleString('es-ES')} ${unit}`}{it.hint && <><br /><span className="faint">{it.hint}</span></>}</>)} onMouseLeave={ocultar}>
                <rect x={x} y={8} width={ancho} height={base - 8} fill="transparent" />
                {it.value == null
                  ? <rect x={x} y={base - 10} width={ancho} height={10} rx={Math.min(8, ancho / 2)} className="bar hueco" />
                  : <rect x={x} y={base - h} width={ancho} height={h} rx={Math.min(10, ancho / 2)} className={`bar ${top ? 'top' : ''}`} />}
                {(n <= 14 || i % Math.ceil(n / 12) === 0) && <text x={x + ancho / 2} y={height - 6} className="xlab" textAnchor="middle">{it.label}</text>}
              </g>
            )
          })}
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  )
}

export interface LineSerie {
  name: string
  /** Clase de color: tiktok | youtube | instagram | a | b */
  cls: string
  points: { x: number; y: number; label: string }[]
}

/** Varias líneas sobre el mismo eje X numérico (días u horas). Los puntos se unen solo dentro de cada serie. */
export function Lines({ series, height = 200, xLabel }: { series: LineSerie[]; height?: number; xLabel: (x: number) => string }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const [tip, mostrar, ocultar] = useTip()
  const todos = series.flatMap((s) => s.points)
  if (!todos.length) return <div ref={ref} className="olines empty">Todavía no hay mediciones para dibujar.</div>
  const xs = todos.map((p) => p.x)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs, x0 + 1)
  const tope = niceMax(Math.max(...todos.map((p) => p.y)))
  const base = height - 22
  const X = (x: number) => 40 + ((x - x0) / (x1 - x0)) * Math.max(1, w - 52)
  const Y = (y: number) => base - (y / tope) * (base - 10)
  return (
    <div ref={ref} className="olines">
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label="Evolución">
          {[0.5, 1].map((f) => (
            <g key={f}>
              <line x1={40} x2={w} y1={Y(tope * f)} y2={Y(tope * f)} className="grid" />
              <text x={34} y={Y(tope * f) + 4} className="ylab" textAnchor="end">{compact(tope * f)}</text>
            </g>
          ))}
          <text x={40} y={height - 6} className="xlab">{xLabel(x0)}</text>
          <text x={w - 4} y={height - 6} className="xlab" textAnchor="end">{xLabel(x1)}</text>
          {series.map((s) => (
            <g key={s.name} className={`serie ${s.cls}`}>
              {s.points.length > 1 && <polyline fill="none" points={s.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')} />}
              {s.points.map((p, i) => (
                <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={3.2}
                  onMouseMove={(e) => mostrar(e, <><strong>{s.name}</strong><br />{p.label}: {p.y.toLocaleString('es-ES')}</>)} onMouseLeave={ocultar} />
              ))}
            </g>
          ))}
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  )
}

/** Mini gráfica de línea para las tarjetas de datos. */
export function MiniLine({ values, cls }: { values: number[]; cls: string }) {
  if (values.length < 2) return <svg className={`mini ${cls}`} width={72} height={24} aria-hidden="true" />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 70 + 1},${22 - ((v - min) / (max - min || 1)) * 20}`).join(' ')
  return (
    <svg className={`mini ${cls}`} width={72} height={24} aria-hidden="true">
      <polyline fill="none" points={pts} />
    </svg>
  )
}
