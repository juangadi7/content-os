import { useEffect, useRef, useState, type ReactNode } from 'react'
import { thumbUrl, type ClipView } from '../../core/api'
import { dondeTexto, PLATFORM_LABEL, type Platform } from '../../core/format'

/** Miniatura del clip, o un hueco limpio si el generador no dejó portada. */
export function Thumb({ clip }: { clip: Pick<ClipView, 'clipId' | 'hasThumb' | 'thumbVersion'> }) {
  const [rota, setRota] = useState(false)
  if (!clip.hasThumb || rota) return <div className="thumb ph" data-test="thumb-placeholder" title="Sin portada">▶</div>
  return <img className="thumb" src={thumbUrl(clip.clipId, clip.thumbVersion)} alt="" onError={() => setRota(true)} />
}

const ARCHIVO: Record<string, [string, string]> = {
  ok: ['Disponible', 'muted'],
  missing: ['Falta', 'bad'],
  hash_mismatch: ['Modificado', 'warn'],
  unverified: ['Sin verificar', 'muted'],
  unknown: ['Sin comprobar', 'muted']
}

export function FileStatus({ clip }: { clip: Pick<ClipView, 'fileState' | 'presentInSource'> }) {
  if (!clip.presentInSource) return <span className="warn" title="El generador ya no tiene este clip; CONTENT OS conserva sus datos">Retirado</span>
  const [texto, clase] = ARCHIVO[clip.fileState] ?? [clip.fileState, 'muted']
  return <span className={clase} data-test="file-state">{texto}</span>
}

export function PubStatus({ published, publishedOn }: { published: string[]; publishedOn?: { platform: string; account: string }[] }) {
  if (published.length === 0) return <span className="faint" data-test="pub-state">No publicado</span>
  const texto = publishedOn?.length ? publishedOn.map(dondeTexto).join(', ') : published.map((p) => PLATFORM_LABEL[p as Platform] ?? p).join(', ')
  return (
    <span className="ok dot" data-test="pub-state" title={texto}>
      Publicado · {texto}
    </span>
  )
}

export function Empty({ title, children, test }: { title: string; children?: ReactNode; test?: string }) {
  return (
    <div className="empty" data-test={test ?? 'empty'}>
      <h3>{title}</h3>
      {children}
    </div>
  )
}

/** Copia a través del proceso principal y enseña "Copiado" un momento. Sin alertas. */
export function useCopy(): [string | null, (clave: string, texto: string) => Promise<void>] {
  const [copiado, setCopiado] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copiar = async (clave: string, texto: string) => {
    const r = await window.contentOS.copyText(texto)
    if (!r.ok) return
    setCopiado(clave)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopiado(null), 1600)
  }
  return [copiado, copiar]
}

export function CopyBlock(props: { id: string; label: string; text: string; emptyText: string; copied: string | null; onCopy: (id: string, text: string) => void }) {
  const vacio = props.text === ''
  return (
    <div className="block">
      <div className="lbl">
        <span>{props.label}</span>
        <span className="sp" />
        {props.copied === props.id && <span className="copied" data-test={`copied-${props.id}`}>Copiado</span>}
        <button className="btn small" data-test={`copy-${props.id}`} disabled={vacio} onClick={() => props.onCopy(props.id, props.text)}>
          Copiar
        </button>
      </div>
      <div className={`box ${vacio ? 'none' : ''}`} data-test={`text-${props.id}`}>{vacio ? props.emptyText : props.text}</div>
    </div>
  )
}
