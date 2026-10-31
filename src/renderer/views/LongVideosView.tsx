import { Check, Copy, ExternalLink, FolderOpen, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { longThumbUrl, longUrl, type LongKind, type LongVideo, type LongVideosView as Datos } from '../../core/api'
import { formatDuration } from '../../core/format'
import { Empty, useCopy } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const mb = (n: number) => `${(n / 1_048_576).toFixed(0)} MB`
/** Texto listo para pegar en YouTube: descripción + hashtags. */
/** Textos de cada sección. */
const TEXTOS: Record<LongKind, { title: string; empty: string; intro: string }> = {
  long: {
    title: 'Vídeos largos',
    empty: 'Aún no hay vídeos largos',
    intro: 'Aquí aparecen los vídeos de tus canales propios, cada uno con sus 3 miniaturas y sus 3 títulos (A, B y C) para «Probar y comparar» de YouTube.'
  },
  music: {
    title: 'Vídeos de música',
    empty: 'Aún no hay vídeos de música',
    intro: 'Aquí aparecen los vídeos de ambiente y música (de varias horas), cada uno con sus 3 miniaturas y sus títulos para «Probar y comparar» de YouTube.'
  }
}
const paraPegar = (v: LongVideo) => [v.description, v.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')].filter(Boolean).join('\n\n')

/** Un vídeo largo: reproductor, sus 3 miniaturas y sus 3 títulos (A, B, C) para «Probar y comparar». */
function Ficha({ v, kind, busy, onToggle }: { v: LongVideo; kind: LongKind; busy: boolean; onToggle: (on: boolean) => void }) {
  const [duracion, setDuracion] = useState<number | null>(null)
  const [jugando, setJugando] = useState(false)
  const ref = useRef<HTMLVideoElement>(null)
  const [copiado, copiar] = useCopy()
  const boton = (clave: string, etiqueta: string, texto: string | null, test: string) => (
    <button className="btn small" data-test={test} disabled={!texto} onClick={() => texto && void copiar(clave, texto)}>
      {copiado === clave ? <Check size={13} /> : <Copy size={13} />}{copiado === clave ? 'Copiado' : etiqueta}
    </button>
  )
  return (
    <article className="lcard" data-test="long-video" data-id={v.id}>
      <div className="ltop">
        <div className="lvideo">
          {v.file ? (
            <>
              <video ref={ref} src={longUrl(v.id, kind)} preload="metadata" controls={jugando} playsInline
                poster={v.thumbs.includes('A') ? longThumbUrl(v.id, 'A', kind) : undefined}
                onLoadedMetadata={(e) => setDuracion(e.currentTarget.duration)} onEnded={() => setJugando(false)} />
              {!jugando && (
                <button className="xplay" data-test="long-play" title="Ver aquí" onClick={() => { setJugando(true); void ref.current?.play() }}>
                  <Play size={26} fill="currentColor" />
                </button>
              )}
              {duracion != null && !jugando && <span className="xdur">{formatDuration(duracion)}</span>}
            </>
          ) : <div className="lnovideo">Falta el MP4 en la carpeta</div>}
        </div>
        <div className="linfo">
          <h2 title={v.titles[0]?.text ?? v.id}>{v.titles[0]?.text ?? v.id}</h2>
          <div className="xmeta">
            {v.channel && <span>{v.channel}</span>}
            {v.sizeBytes != null && <span>{mb(v.sizeBytes)}</span>}
            {v.uploadedAt
              ? <span className="ok">Subido el {new Date(v.uploadedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</span>
              : <span>Sin subir</span>}
          </div>
          {v.schedule && <p className="lsched" data-test="long-schedule"><strong>Publicar:</strong> {v.schedule}</p>}
          <div className="xcopy">
            {boton('d', 'Descripción', paraPegar(v) || null, 'long-copy-desc')}
            {boton('c', 'Comentario fijado', v.pinnedComment, 'long-copy-comment')}
            <span className="sp" />
            <button className="btn small ghost" title="Abrir con el reproductor de Windows" disabled={!v.file} onClick={() => void window.contentOS.openLongVideo(v.id, kind)}><ExternalLink size={13} /></button>
            <button className="btn small ghost" title="Abrir la carpeta del vídeo" onClick={() => void window.contentOS.showLongInFolder(v.id, kind)}><FolderOpen size={13} /></button>
          </div>
          <button className={`xchip youtube lmark ${v.uploadedAt ? 'on' : ''}`} data-test="long-mark" disabled={busy} aria-pressed={!!v.uploadedAt}
            title={v.uploadedAt ? 'Pulsa para desmarcar' : 'Marcar como subido a YouTube'} onClick={() => onToggle(!v.uploadedAt)}>
            {v.uploadedAt && <Check size={12} />}{v.uploadedAt ? 'Subido a YouTube' : 'Marcar como subido a YouTube'}
          </button>
        </div>
      </div>

      <div className="lcols">
        <section>
          <h3>Miniaturas</h3>
          <div className="lthumbs" data-test="long-thumbs">
            {(['A', 'B', 'C'] as const).map((l) => (
              <figure key={l} className={`lthumb ${v.thumbs.includes(l) ? '' : 'falta'}`} data-letter={l}>
                {v.thumbs.includes(l) ? <img src={longThumbUrl(v.id, l, kind)} alt={`Miniatura ${l}`} /> : <span>Sin miniatura</span>}
                <figcaption>{l}{l === 'A' ? ' · principal' : ''}</figcaption>
              </figure>
            ))}
          </div>
        </section>
        <section>
          <h3>Títulos</h3>
          {v.titles.length === 0 ? <p className="faint small">Sin títulos en video.json</p> : (
            <ol className="ltitles" data-test="long-titles">
              {v.titles.map((t) => (
                <li key={t.letter} data-letter={t.letter}>
                  <span className="lletter">{t.letter}</span>
                  <span className="ltext">{t.text}<span className="lchars">{t.text.length} caracteres</span></span>
                  <button className="btn small ghost" title="Copiar título" data-test="long-copy-title" onClick={() => void copiar(`t${t.letter}`, t.text)}>
                    {copiado === `t${t.letter}` ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
      {v.notes && <p className="xnotes lnotes">{v.notes}</p>}
    </article>
  )
}

/**
 * Vídeos largos de los canales propios: cada uno con su carpeta (vídeo, 3 miniaturas, subtítulos) y sus
 * 3 títulos en orden A, B, C. La aplicación solo los lee de la carpeta VIDEOS_LARGOS.
 */
export function LongVideosView(props: { kind?: LongKind; refresh: number; onChanged: () => void }) {
  const kind = props.kind ?? 'long'
  const t = TEXTOS[kind]
  const [datos, setDatos] = useState<Datos | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    void window.contentOS.listLongVideos(kind).then((d) => vivo && setDatos(d))
    return () => {
      vivo = false
    }
  }, [props.refresh, kind])

  if (!datos) return null

  const marcar = async (id: string, on: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setDatos(await window.contentOS.setLongUploaded(id, on, kind))
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const sinSubir = datos.videos.filter((v) => !v.uploadedAt).length

  return (
    <>
      <PageHeader title={t.title} titleTest="long-title"
        meta={<span data-test="long-count">{datos.total} {datos.total === 1 ? 'vídeo' : 'vídeos'}{datos.total > 0 && ` · ${sinSubir} sin subir`}</span>}>
        <button className="btn" data-test="long-folder" onClick={() => void window.contentOS.showLongInFolder(null, kind)}><FolderOpen size={14} />Abrir carpeta</button>
      </PageHeader>
      {error && <div className="banner bad" data-test="long-error"><span>{error}</span></div>}
      {datos.total === 0 ? (
        <Empty title={t.empty} test="long-empty">
          <p>{t.intro}</p>
          <p className="faint small">Van en la carpeta <code>{datos.folder}</code>, una subcarpeta por vídeo.</p>
        </Empty>
      ) : (
        <div className="llist">
          {datos.videos.map((v) => <Ficha key={v.id} v={v} kind={kind} busy={busy} onToggle={(on) => void marcar(v.id, on)} />)}
        </div>
      )}
    </>
  )
}
