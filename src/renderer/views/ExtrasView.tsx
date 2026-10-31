import { ArrowLeft, Check, Copy, ExternalLink, FolderOpen, Play, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { extraThumbUrl, extraUrl, type ExtraPlatform, type ExtrasView as Datos, type ExtraVideo } from '../../core/api'
import { formatDuration, PLATFORM_LABEL } from '../../core/format'
import { Empty, useCopy } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const PLATAFORMAS: ExtraPlatform[] = ['youtube', 'tiktok', 'instagram']
const mb = (n: number) => `${(n / 1_048_576).toFixed(0)} MB`
/** Texto listo para pegar al subir: descripción + hashtags. */
const paraPegar = (v: ExtraVideo) => [v.description, v.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')].filter(Boolean).join('\n\n')

/** Un vídeo: se ve dentro de la tarjeta, con sus textos para copiar y dónde se ha subido. */
function Tarjeta({ v, busy, onToggle }: { v: ExtraVideo; busy: boolean; onToggle: (p: ExtraPlatform, on: boolean) => void }) {
  const [duracion, setDuracion] = useState<number | null>(null)
  const [jugando, setJugando] = useState(false)
  const ref = useRef<HTMLVideoElement>(null)
  const [copiado, copiar] = useCopy()
  const subidas = PLATAFORMAS.filter((p) => v.uploaded[p])
  return (
    <article className="xcard" data-test="extra-video" data-id={v.id}>
      <div className="xvideo">
        <video ref={ref} src={`${extraUrl(v.id)}#t=1.5`} preload="metadata" controls={jugando} playsInline
          onLoadedMetadata={(e) => setDuracion(e.currentTarget.duration)} onEnded={() => setJugando(false)} />
        {!jugando && (
          <button className="xplay" data-test="extra-play" title="Ver aquí" onClick={() => { setJugando(true); void ref.current?.play() }}>
            <Play size={26} fill="currentColor" />
          </button>
        )}
        {duracion != null && !jugando && <span className="xdur">{formatDuration(duracion)}</span>}
      </div>
      <div className="xbody">
        <h3 title={v.title}>{v.title}</h3>
        <div className="xmeta">
          <span>{mb(v.sizeBytes)}</span>
          {subidas.length > 0 ? <span className="ok">Subido a {subidas.map((p) => PLATFORM_LABEL[p]).join(', ')}</span> : <span>Sin subir</span>}
        </div>
        <div className="xcopy">
          <button className="btn small" data-test="extra-copy-title" onClick={() => void copiar('t', v.title)}>
            {copiado === 't' ? <Check size={13} /> : <Copy size={13} />}{copiado === 't' ? 'Copiado' : 'Título'}
          </button>
          <button className="btn small" data-test="extra-copy-desc" disabled={!paraPegar(v)} onClick={() => void copiar('d', paraPegar(v))}>
            {copiado === 'd' ? <Check size={13} /> : <Copy size={13} />}{copiado === 'd' ? 'Copiado' : 'Descripción'}
          </button>
          <span className="sp" />
          <button className="btn small ghost" title="Abrir con el reproductor de Windows" onClick={() => void window.contentOS.openExtra(v.id)}><ExternalLink size={13} /></button>
          <button className="btn small ghost" title="Mostrar en la carpeta" onClick={() => void window.contentOS.showExtraInFolder(v.id)}><FolderOpen size={13} /></button>
        </div>
        <div className="xplat" role="group" aria-label="Marcar dónde está subido">
          {PLATAFORMAS.map((p) => {
            const on = !!v.uploaded[p]
            return (
              <button key={p} className={`xchip ${p} ${on ? 'on' : ''}`} data-test="extra-mark" data-platform={p} disabled={busy} aria-pressed={on}
                title={on ? `Subido el ${new Date(v.uploaded[p]!).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}. Pulsa para desmarcar.` : 'Marcar como subido'}
                onClick={() => onToggle(p, !on)}>
                {on && <Check size={12} />}{PLATFORM_LABEL[p]}
              </button>
            )
          })}
        </div>
      </div>
    </article>
  )
}

/**
 * Vídeos hechos sin campaña detrás (pruebas y montajes propios): no cobran por visitas ni entran en el plan,
 * en las estadísticas ni en los pagos. La aplicación solo los lee de la carpeta FUERA_DE_CAMPAÑA.
 */
export function ExtrasView(props: { refresh: number; onChanged: () => void }) {
  const [datos, setDatos] = useState<Datos | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Lo que se va a mandar a la Papelera, a la espera de confirmar: un grupo (su id) o todo (null). */
  const [borrar, setBorrar] = useState<{ groupId: string | null; texto: string } | null>(null)
  /** Vídeo original abierto (su carpeta); null = la portada con todas las tarjetas. */
  const [abierto, setAbierto] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    void window.contentOS.listExtras().then((d) => vivo && setDatos(d))
    return () => {
      vivo = false
    }
  }, [props.refresh])

  if (!datos) return null

  const marcar = async (id: string, p: ExtraPlatform, on: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setDatos(await window.contentOS.setExtraUploaded(id, p, on))
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const papelera = async (groupId: string | null) => {
    setBusy(true)
    setError(null)
    try {
      setDatos(await window.contentOS.trashExtras(groupId))
      setBorrar(null)
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const subido = (v: ExtraVideo) => PLATAFORMAS.some((p) => v.uploaded[p])
  const sinSubir = datos.groups.flatMap((g) => g.videos).filter((v) => !subido(v)).length
  const grupo = datos.groups.find((g) => g.id === abierto) ?? null
  const confirmacion = borrar && (
    <div className="banner bad xconfirm" data-test="extras-trash-confirm">
      <Trash2 size={15} />
      <span>Se mandan a la Papelera de Windows {borrar.texto}, con sus textos. Se pueden recuperar desde la Papelera.</span>
      <button className="btn small danger" data-test="extras-trash-yes" disabled={busy} onClick={() => void papelera(borrar.groupId)}>Enviar a la Papelera</button>
      <button className="btn small ghost" onClick={() => setBorrar(null)}>Cancelar</button>
    </div>
  )

  // ---- dentro de un vídeo original: sus clips
  if (grupo) {
    const pendientes = grupo.videos.filter((v) => !subido(v)).length
    return (
      <>
        <button className="linklike xback" data-test="extras-back" onClick={() => setAbierto(null)}><ArrowLeft size={14} />Fuera de campaña</button>
        <PageHeader title={grupo.name} titleTest="extras-group-title"
          meta={<>{grupo.channel && <span>{grupo.channel} · </span>}<span>{grupo.videos.length} {grupo.videos.length === 1 ? 'clip' : 'clips'} · {pendientes} sin subir</span></>}>
          {grupo.sourceUrl && /^https:\/\//i.test(grupo.sourceUrl) && <a className="btn" href={grupo.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />Vídeo original</a>}
          <button className="btn" data-test="extras-trash-group" disabled={busy} onClick={() => setBorrar({ groupId: grupo.id, texto: `los ${grupo.videos.length} clips de «${grupo.name}»` })}>
            <Trash2 size={14} />Eliminar
          </button>
        </PageHeader>
        {confirmacion}
        {error && <div className="banner bad" data-test="extras-error"><span>{error}</span></div>}
        {grupo.notes && <p className="xnotes">{grupo.notes}</p>}
        <div className="xgrid" data-test="extras-group">
          {grupo.videos.map((v) => <Tarjeta key={v.id} v={v} busy={busy} onToggle={(p, on) => void marcar(v.id, p, on)} />)}
        </div>
      </>
    )
  }

  // ---- portada: una tarjeta por vídeo original, como en Campañas
  return (
    <>
      <PageHeader title="Fuera de campaña" titleTest="extras-title"
        meta={<><span data-test="extras-count">{datos.groups.length} {datos.groups.length === 1 ? 'vídeo original' : 'vídeos originales'} · {datos.total} {datos.total === 1 ? 'clip' : 'clips'}</span>{datos.total > 0 && <span> · {sinSubir} sin subir</span>}<span> · no cobran por visitas</span></>}>
        <button className="btn" data-test="extras-folder" onClick={() => void window.contentOS.showExtraInFolder(null)}><FolderOpen size={14} />Abrir carpeta</button>
        {datos.total > 0 && (
          <button className="btn" data-test="extras-trash-all" disabled={busy} onClick={() => setBorrar({ groupId: null, texto: `los ${datos.total} clips de todos los vídeos` })}>
            <Trash2 size={14} />Eliminar todo
          </button>
        )}
      </PageHeader>
      {confirmacion}
      {error && <div className="banner bad" data-test="extras-error"><span>{error}</span></div>}

      {datos.total === 0 ? (
        <Empty title="Aún no hay vídeos fuera de campaña" test="extras-empty">
          <p>Aquí aparecen los vídeos hechos sin campaña detrás: pruebas, montajes propios o clips para tus canales.</p>
          <p className="faint small">Van en la carpeta <code>{datos.folder}</code>, una subcarpeta por vídeo original.</p>
        </Empty>
      ) : (
        <div className="cards xgcards">
          {datos.groups.map((g) => {
            const pendientes = g.videos.filter((v) => !subido(v)).length
            return (
              <button key={g.id} className="card xgcard" data-test="extras-group-card" data-group={g.id} onClick={() => setAbierto(g.id)}>
                <div className="xgthumb">
                  {g.hasThumb
                    ? <img src={extraThumbUrl(g.id)} alt="" />
                    : <video src={`${extraUrl(g.videos[0].id)}#t=1.5`} preload="metadata" muted />}
                  <span className="xgcount">{g.videos.length} {g.videos.length === 1 ? 'clip' : 'clips'}</span>
                </div>
                <div className="xgbody">
                  <h3>{g.name}</h3>
                  <div className="meta">{g.channel ?? 'Vídeo propio'} · {new Date(g.updatedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                  <dl>
                    <dt>Clips</dt><dd>{g.videos.length}</dd>
                    <dt>Sin subir</dt><dd className={pendientes ? '' : 'ok'} data-test="extras-group-pending">{pendientes ? pendientes : 'Todos subidos'}</dd>
                  </dl>
                  <span className="go">Ver clips →</span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
