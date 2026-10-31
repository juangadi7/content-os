import { ArrowLeft, ExternalLink, FolderOpen, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { clipUrl, thumbUrl, type ClipDetail } from '../../core/api'
import { dondeTexto, formatDuration, hashtagsText, qaLabel, scoreLabel } from '../../core/format'
import { Chip, clipEstado } from '../components/ClipCard'
import { CopyBlock, Empty, FileStatus, useCopy } from '../components/Common'
import { PublicationPanel } from '../components/PublicationPanel'

const fechaHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '—')
const seg = (n: number | null) => (n == null ? '—' : `${n.toFixed(2)} s`)

/**
 * Ficha de un clip: a la izquierda el vídeo, a la derecha qué es, qué hay que respetar al publicarlo,
 * los textos para copiar y dónde está publicado. Los datos del clip son de solo lectura; lo único
 * que se puede cambiar aquí son sus publicaciones (igual que antes).
 */
export function ClipDetailView(props: { clipId: string; refresh: number; backLabel: string; onBack: () => void; onChanged: () => void }) {
  const [clip, setClip] = useState<ClipDetail | null | undefined>(undefined)
  const [aviso, setAviso] = useState<string | null>(null)
  const [copiado, copiar] = useCopy()
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    let vivo = true
    void window.contentOS.getClip(props.clipId).then((c) => vivo && setClip(c))
    return () => {
      vivo = false
    }
  }, [props.clipId, props.refresh])

  const volver = (
    <button className="dv-back" data-test="back" onClick={props.onBack}><ArrowLeft size={15} />{props.backLabel}</button>
  )

  if (clip === undefined) {
    return (
      <>
        {volver}
        <div className="dv" aria-hidden="true">
          <div className="dv-left"><div className="dv-player skeleton" /></div>
          <div className="dv-right"><div className="panel skeleton" style={{ height: 150 }} /><div className="panel skeleton" style={{ height: 240 }} /></div>
        </div>
      </>
    )
  }
  if (clip === null) {
    return (
      <>
        {volver}
        <Empty title="Este clip ya no está en CONTENT OS" />
      </>
    )
  }

  const hayArchivo = !!clip.resolvedPath && clip.fileState !== 'missing'
  const [estado, tono] = clipEstado(clip)
  const ejecutar = async (f: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await f()
    setAviso(r.ok ? null : r.error ?? 'No se pudo abrir.')
  }
  const ver = () => {
    const v = video.current
    if (!v) return
    v.currentTime = 0
    void v.play()
  }

  return (
    <>
      {volver}
      <div className="dv" data-test="clip-detail" data-clip={clip.clipId}>
        <div className="dv-left">
          <div className="dv-player">
            {hayArchivo ? (
              <video ref={video} data-test="video" src={clipUrl(clip.clipId)} poster={clip.hasThumb ? thumbUrl(clip.clipId, clip.thumbVersion) : undefined} controls preload="metadata" />
            ) : (
              <div className="nofile" data-test="no-file">
                <strong>No se encuentra el vídeo</strong>
                <span>{clip.filename ?? 'Sin nombre de archivo'}</span>
                <span className="faint">Puede que la campaña se esté regenerando o que la carpeta se haya movido. Sincroniza para volver a buscarlo.</span>
              </div>
            )}
          </div>
          <div className="dv-actions">
            <button className="btn primary" data-test="play" disabled={!hayArchivo} onClick={ver}><Play size={14} />Ver clip</button>
            <button className="btn" data-test="open-file" disabled={!hayArchivo} onClick={() => ejecutar(() => window.contentOS.openClipFile(clip.clipId))} title="Abrir el MP4 con el reproductor de Windows"><ExternalLink size={14} />Abrir archivo</button>
            <button className="btn" data-test="open-folder" disabled={!hayArchivo} onClick={() => ejecutar(() => window.contentOS.showClipInFolder(clip.clipId))} title="Mostrarlo en el Explorador, para arrastrarlo a la plataforma"><FolderOpen size={14} />Abrir carpeta</button>
          </div>
          {aviso && <p className="bad small" style={{ marginTop: 8 }}>{aviso}</p>}
        </div>

        <div className="dv-right">
          <header className="dv-head">
            <div className="dv-eyebrow">{clip.campaignName}{clip.presentInSource ? ` · puesto ${clip.position}` : ''}</div>
            <h1 data-test="clip-title">{clip.title ?? clip.filename ?? clip.clipId}</h1>
            <div className="dv-chips" data-test="detail-chips">
              <Chip tone={tono}>{estado}</Chip>
              {clip.publishedOn.map((d) => <Chip key={d.platform + d.account} tone="plat">{dondeTexto(d)}</Chip>)}
              {clip.campaignClosed && clip.published.length > 0 && <Chip tone="closed">Campaña cerrada</Chip>}
            </div>
            <dl className="dv-facts">
              <div><dt>Puntuación</dt><dd className={clip.score == null ? 'none' : ''} data-test="detail-score">{scoreLabel(clip.score)}</dd></div>
              <div><dt>QA</dt><dd>{qaLabel(clip.qaScore)}</dd></div>
              <div><dt>Duración</dt><dd>{formatDuration(clip.duration)}</dd></div>
              <div><dt>Archivo</dt><dd className="none"><FileStatus clip={clip} /></dd></div>
            </dl>
          </header>

          {clip.checklist.length > 0 && (
            <section className="panel dv-rules" data-test="checklist">
              <header className="panel-h"><div><h2>Al publicar</h2><p className="panel-hint">Lo que pide la campaña para este clip.</p></div></header>
              <ul className="checklist">
                {clip.checklist.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </section>
          )}

          <section className="panel dv-copy">
            <header className="panel-h"><div><h2>Textos para copiar</h2><p className="panel-hint">Tal como salen de la ficha del clip. «Copiar» los deja en el portapapeles.</p></div></header>
            <CopyBlock id="title" label="Título" text={clip.title ?? ''} emptyText="Sin título" copied={copiado} onCopy={copiar} />
            <CopyBlock id="caption" label="Descripción" text={clip.caption ?? ''} emptyText="Sin descripción" copied={copiado} onCopy={copiar} />
            <CopyBlock id="hashtags" label="Hashtags" text={hashtagsText(clip.hashtags)} emptyText="Esta campaña no lleva hashtags" copied={copiado} onCopy={copiar} />
          </section>

          <section className="panel dv-pubs">
            <PublicationPanel
              clip={clip}
              onChange={(c) => {
                setClip(c)
                props.onChanged()
              }}
            />
          </section>

          <details className="more dv-more">
            <summary>Detalles técnicos</summary>
            <dl>
              <dt>Identificador</dt><dd className="mono">{clip.clipId}</dd>
              <dt>Fuente</dt><dd>{clip.source ?? '—'}</dd>
              <dt>Tramo</dt><dd>{seg(clip.startTime)} → {seg(clip.endTime)}</dd>
              <dt>Generado</dt><dd>{fechaHora(clip.createdAt)}</dd>
              <dt>Origen del score</dt><dd>{clip.score == null ? '—' : clip.scoreOrigin === 'unknown' || !clip.scoreOrigin ? 'No consta' : clip.scoreOrigin}</dd>
              <dt>Motivo de selección</dt><dd>{clip.selectionReason ?? 'No consta'}</dd>
              <dt>Predicción</dt><dd className="faint">Todavía no disponible</dd>
              <dt>Controles de QA</dt>
              <dd>{clip.qaSummary ? Object.entries(clip.qaSummary).map(([k, v]) => `${k}: ${v}`).join(' · ') : '—'}</dd>
              <dt>Archivo</dt><dd className="mono">{clip.resolvedPath ?? clip.fullPath ?? '—'}</dd>
              <dt>SHA-256</dt><dd className="mono">{clip.sha256 ?? '—'}</dd>
              {clip.renderChangedAt && (<><dt>Último render nuevo</dt><dd>{fechaHora(clip.renderChangedAt)}</dd></>)}
              {clip.missingSince && (<><dt>Retirado desde</dt><dd>{fechaHora(clip.missingSince)}</dd></>)}
            </dl>
          </details>
        </div>
      </div>
    </>
  )
}
