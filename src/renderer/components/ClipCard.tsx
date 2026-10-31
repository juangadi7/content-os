import { Clapperboard } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { thumbUrl, type ClipView } from '../../core/api'
import { CLIP_STATE_LABEL, clipStateKey, dondeTexto, formatDuration, scoreLabel, type ClipStateKey } from '../../core/format'

/**
 * Tarjeta de un clip para las vistas en cuadrícula. Es una pieza reutilizable: recibe un clip y lo
 * dibuja; no sabe en qué pantalla está ni pide datos por su cuenta.
 *
 * `meta` es una línea libre de datos (p. ej. fecha y visitas en Publicados) y `test` el nombre con que la
 * encuentran las pruebas. `daysLeft` son los días de plazo de su campaña (null si no tiene). `note` queda previsto para la
 * nota interna del clip, que todavía no existe en los datos: mientras no llegue, no se dibuja nada.
 */
export function ClipCard(props: { clip: ClipView; daysLeft?: number | null; note?: string | null; meta?: ReactNode; test?: string; onOpen: (clipId: string) => void }) {
  const { clip: k, daysLeft } = props
  const [rota, setRota] = useState(false)
  const estado = clipEstado(k)
  return (
    <button className="ccard" data-test={props.test ?? 'clip-row'} data-clip={k.clipId} onClick={() => props.onOpen(k.clipId)} title={k.title ?? k.filename ?? ''}>
      <span className="ccard-img">
        {k.hasThumb && !rota
          ? <img src={thumbUrl(k.clipId, k.thumbVersion)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setRota(true)} />
          : <span className="ccard-ph" data-test="thumb-placeholder"><Clapperboard size={26} strokeWidth={1.5} /><small>Sin portada</small></span>}
        {k.duration != null && <span className="ccard-dur">{formatDuration(k.duration)}</span>}
      </span>
      <span className="ccard-body">
        <span className="ccard-t">{k.title ?? k.filename ?? k.clipId}</span>
        {props.note ? <span className="ccard-n">{props.note}</span> : null}
        <span className="ccard-c">{k.campaignName}</span>
        {props.meta ? <span className="ccard-m">{props.meta}</span> : null}
        <span className="ccard-f">
          <span className="ccard-chips">
          <Chip tone={estado[1]}>{estado[0]}</Chip>
          {k.publishedOn.map((d) => <Chip key={d.platform + d.account} tone="plat" title={`Publicado en ${dondeTexto(d)}`}>{dondeTexto(d)}</Chip>)}
          {daysLeft != null && !k.campaignClosed && <Chip tone={daysLeft <= 3 ? 'warn' : ''} title="Días que le quedan a la campaña">{daysLeft === 1 ? 'último día' : `${daysLeft} días`}</Chip>}
          </span>
          <span className={`ccard-s ${k.score == null ? 'none' : ''}`} data-test="row-score" title={k.score == null ? 'Este clip no tiene puntuación' : 'Puntuación del clip'}>{scoreLabel(k.score)}</span>
        </span>
      </span>
    </button>
  )
}

/**
 * Estado de un clip y el tono de su chip. Una sola definición para la tarjeta y la ficha, así no pueden
 * decir cosas distintas. No cambia el significado de nada: solo le pone nombre a lo que ya se sabía.
 */
const TONO: Record<ClipStateKey, string> = { pending: '', published: 'ok', closed: 'closed', missing: 'bad', retired: 'warn' }

export function clipEstado(k: Pick<ClipView, 'presentInSource' | 'fileState' | 'published' | 'campaignClosed'>): [string, string] {
  const e = clipStateKey(k)
  return [CLIP_STATE_LABEL[e], TONO[e]]
}

/** Etiqueta pequeña de estado. El color dice el tipo: verde hecho, ámbar atención, rojo problema, gris inactivo. */
export function Chip(props: { tone?: string; title?: string; children: ReactNode }) {
  return <span className={`chip-s ${props.tone ?? ''}`} title={props.title}>{props.children}</span>
}
