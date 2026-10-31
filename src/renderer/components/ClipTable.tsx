import type { ClipView } from '../../core/api'
import { formatDuration, qaLabel, scoreLabel } from '../../core/format'
import { FileStatus, PubStatus, Thumb } from './Common'

/** Lista de clips ya ordenada. El puesto (#) es el que trae cada clip, no la fila. */
export function ClipTable({ clips, onOpen, showCampaign = false }: { clips: ClipView[]; onOpen: (clipId: string) => void; showCampaign?: boolean }) {
  const cols = `cols-clips ${showCampaign ? 'with-camp' : ''}`
  return (
    <div className="rows" data-test="clip-rows">
      <div className={`row hdr ${cols}`}>
        <span className="num">#</span>
        <span />
        <span>Título</span>
        {showCampaign && <span>Campaña</span>}
        <span className="num">Score</span>
        <span className="num">QA</span>
        <span className="num">Dur.</span>
        <span>Archivo</span>
        <span>Publicación</span>
      </div>
      {clips.map((k) => (
        <button key={k.clipId} className={`row ${cols} ${k.presentInSource ? '' : 'gone'}`} data-test="clip-row" data-clip={k.clipId} onClick={() => onOpen(k.clipId)}>
          <span className="rank">{k.presentInSource ? k.position : '—'}</span>
          <Thumb clip={k} />
          <span className="ell" title={k.title ?? ''}>{k.title ?? k.filename ?? k.clipId}</span>
          {showCampaign && <span className="ell muted">{k.campaignName}</span>}
          <span className={`num ${k.score == null ? 'faint' : ''}`} data-test="row-score">{scoreLabel(k.score)}</span>
          <span className="num muted">{qaLabel(k.qaScore)}</span>
          <span className="num muted">{formatDuration(k.duration)}</span>
          <FileStatus clip={k} />
          <PubStatus published={k.published} publishedOn={k.publishedOn} />
        </button>
      ))}
    </div>
  )
}
