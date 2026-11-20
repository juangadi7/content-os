import { ChartColumn, Check, ClipboardPen, Copy, ExternalLink, FolderOpen, Play, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { longThumbUrl, longUrl, type CityPlatform, type CityStats, type LongKind, type LongVideo, type LongVideosView as Datos, type OwnChannel, type OwnVideoStats } from '../../core/api'
import { compact } from '../components/charts'
import { OwnStatsForm } from '../components/OwnStatsForm'
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
  },
  roblox: {
    title: 'Historias Roblox',
    empty: 'Aún no hay historias Roblox',
    intro: 'Aquí aparecen los Shorts de historias Roblox (estilo @RakoEspanol): el vídeo, su miniatura, el título y la descripción para YouTube. Súbelos de uno en uno, uno al día.'
  },
  curio: {
    title: 'Curiosidades',
    empty: 'Aún no hay vídeos de curiosidades',
    intro: 'Aquí aparecen los Shorts de curiosidades (estilo @resultaaquee): el vídeo, su portada, el título y el texto del post. Súbelos de uno en uno, uno al día, y márcalos en cada red. Puedes añadir vídeos arrastrándolos a la ventana.'
  },
  gta: {
    title: 'GTA 6',
    empty: 'Aún no hay vídeos de GTA 6',
    intro: 'Aquí aparecen los Shorts de noticias de GTA 6 (serie con cuenta atrás): el vídeo, su portada, el título y el texto del post. Cada uno lleva en pantalla los días que faltan: súbelo el día que toca.'
  },
  city: {
    title: 'Vídeos de la ciudad',
    empty: 'Aún no hay vídeos de la ciudad',
    intro: 'Aquí aparece cada día de «La Ciudad de Todos»: el vídeo, su portada, el título y los textos de TikTok, Instagram y YouTube, y las cifras de la ciudad.'
  }
}
const REDES: { id: CityPlatform; nombre: string }[] = [
  { id: 'tiktok', nombre: 'TikTok' },
  { id: 'instagram', nombre: 'Instagram' },
  { id: 'youtube', nombre: 'YouTube' }
]
const pendienteCiudad = (v: LongVideo) => REDES.some((r) => !v.uploads[r.id])
/** Canales propios: se marcan por red, como la ciudad, y tienen cifras. */
const PROPIOS: LongKind[] = ['gta', 'curio', 'roblox']
const miles = (n: number) => n.toLocaleString('es-ES')

/** Cifras de la ciudad: vecinos, cada red, siguiente meta, cuenta atrás y los VIP. */
function PanelCiudad({ c }: { c: CityStats | null | undefined }) {
  if (!c) return <p className="faint small cityhint">Sin cifras todavía: aparecen cuando Claude apunta los datos del día.</p>
  const dias = c.gta6 ? Math.ceil((Date.parse(c.gta6 + 'T00:00:00') - Date.now()) / 864e5) : null
  return (
    <section className="citypanel" data-test="city-panel">
      <div className="cstat big"><span className="cnum">{miles(c.vecinos)}</span><span className="clbl">vecinos</span></div>
      {REDES.map((r) => {
        const x = c.cifras[r.id]
        return (
          <div key={r.id} className={`cstat ${r.id}`}>
            <span className="cnum">{x ? miles(x.seguidores) : '—'}</span>
            <span className="clbl">{r.nombre} · seguidores</span>
            <span className="csub">{x ? `${miles(x.comentarios)} comentarios` : 'sin datos'}</span>
          </div>
        )
      })}
      <div className="cstat">
        <span className="cnum">{c.siguienteMeta ? miles(c.siguienteMeta.vecinos - c.vecinos) : '✓'}</span>
        <span className="clbl">{c.siguienteMeta ? `faltan para ${miles(c.siguienteMeta.vecinos)}` : 'metas cumplidas'}</span>
        {c.siguienteMeta && <span className="csub">{c.siguienteMeta.obra}</span>}
      </div>
      {dias != null && <div className="cstat"><span className="cnum">{Math.max(0, dias)}</span><span className="clbl">días para GTA 6</span></div>}
      <div className="cvip">
        <span className="clbl">VIP · mansión en la colina ({c.vip.length}/10)</span>
        <div className="cviplist">
          {c.vip.length === 0 ? <span className="faint small">Nadie todavía</span> : c.vip.map((v, i) => (
            <span key={v.usuario} className={`cvipchip ${v.red}`}>{i + 1}. {v.usuario}</span>
          ))}
        </div>
        {c.resto > 0 && <span className="csub">+ {miles(c.resto)} vecinos más</span>}
        {c.fecha && <span className="csub">Cifras del {new Date(c.fecha + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</span>}
      </div>
    </section>
  )
}
const paraPegar = (v: LongVideo) => [v.description, v.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')].filter(Boolean).join('\n\n')

/** Un vídeo largo: reproductor, sus 3 miniaturas y sus 3 títulos (A, B, C) para «Probar y comparar». */
const programadoEl = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : `${d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`
}

function Ficha({ v, kind, busy, onToggle, stats, onStats }: { v: LongVideo; kind: LongKind; busy: boolean; onToggle: (on: boolean, platform?: CityPlatform) => void; stats?: OwnVideoStats; onStats?: () => void }) {
  const ciudad = kind === 'city'
  const propio = PROPIOS.includes(kind)
  const porRed = ciudad || propio
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
    <article className={`lcard ${ciudad ? 'city' : ''}`} data-test="long-video" data-id={v.id}>
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
            {v.scheduledAt && <span className="sched" data-test="long-scheduled">Programado en Metricool · {programadoEl(v.scheduledAt)}</span>}
            {porRed
              ? <span className={pendienteCiudad(v) ? '' : 'ok'}>Subido en {REDES.filter((r) => v.uploads[r.id]).length}/3 redes</span>
              : v.uploadedAt
                ? <span className="ok">Subido el {new Date(v.uploadedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</span>
                : <span>Sin subir</span>}
          </div>
          {v.schedule && <p className="lsched" data-test="long-schedule"><strong>Publicar:</strong> {v.schedule}</p>}
          <div className="xcopy">
            {ciudad ? (
              <>
                {boton('ty', 'Título YouTube', v.titles[0]?.text ?? null, 'city-copy-yt-title')}
                {boton('d', 'Descripción YouTube', paraPegar(v) || null, 'long-copy-desc')}
                {boton('tt', 'Texto TikTok', v.captions.tiktok ?? null, 'city-copy-tiktok')}
                {boton('ig', 'Texto Instagram', v.captions.instagram ?? null, 'city-copy-instagram')}
              </>
            ) : (
              <>
                {boton('d', 'Descripción', paraPegar(v) || null, 'long-copy-desc')}
                {boton('c', 'Comentario fijado', v.pinnedComment, 'long-copy-comment')}
              </>
            )}
            <span className="sp" />
            <button className="btn small ghost" title="Abrir con el reproductor de Windows" disabled={!v.file} onClick={() => void window.contentOS.openLongVideo(v.id, kind)}><ExternalLink size={13} /></button>
            <button className="btn small ghost" title="Abrir la carpeta del vídeo" onClick={() => void window.contentOS.showLongInFolder(v.id, kind)}><FolderOpen size={13} /></button>
          </div>
          {porRed ? (
            <div className="cmarks" data-test="city-marks">
              {REDES.map((r) => {
                const on = !!v.uploads[r.id]
                return (
                  <button key={r.id} className={`xchip ${r.id} ${on ? 'on' : ''}`} data-test={`city-mark-${r.id}`} disabled={busy} aria-pressed={on}
                    title={on ? 'Pulsa para desmarcar' : `Marcar como subido a ${r.nombre}`} onClick={() => onToggle(!on, r.id)}>
                    {on && <Check size={12} />}{r.nombre}
                  </button>
                )
              })}
              {propio && onStats && (
                <button className="btn small ghost" data-test="long-add-stats" title="Apuntar a mano visitas, likes, retención…" onClick={onStats}><ClipboardPen size={13} />Apuntar cifras</button>
              )}
            </div>
          ) : (
            <button className={`xchip youtube lmark ${v.uploadedAt ? 'on' : ''}`} data-test="long-mark" disabled={busy} aria-pressed={!!v.uploadedAt}
              title={v.uploadedAt ? 'Pulsa para desmarcar' : 'Marcar como subido a YouTube'} onClick={() => onToggle(!v.uploadedAt)}>
              {v.uploadedAt && <Check size={12} />}{v.uploadedAt ? 'Subido a YouTube' : 'Marcar como subido a YouTube'}
            </button>
          )}
        </div>
      </div>

      <div className="lcols">
        <section>
          <h3>{ciudad ? 'Portada (TikTok e Instagram)' : 'Miniaturas'}</h3>
          <div className="lthumbs" data-test="long-thumbs">
            {(ciudad ? (['A'] as const) : (['A', 'B', 'C'] as const)).map((l) => (
              <figure key={l} className={`lthumb ${v.thumbs.includes(l) ? '' : 'falta'}`} data-letter={l}>
                {v.thumbs.includes(l) ? <img src={longThumbUrl(v.id, l, kind)} alt={`Miniatura ${l}`} /> : <span>Sin miniatura</span>}
                <figcaption>{ciudad ? 'Portada' : `${l}${l === 'A' ? ' · principal' : ''}`}</figcaption>
              </figure>
            ))}
          </div>
        </section>
        <section>
          <h3>{ciudad ? 'Título de YouTube' : 'Títulos'}</h3>
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
      {propio && stats && stats.posts.length > 0 && (
        <div className="lstats" data-test="long-stats">
          {stats.posts.map((p) => (
            <span key={p.platform} className={`lstat ${p.platform}`}>
              <strong>{REDES.find((r) => r.id === p.platform)?.nombre}</strong>
              {p.latest.views != null ? `${compact(p.latest.views)} visitas` : 'visitas sin medir'}
              {p.latest.likes != null && ` · ${compact(p.latest.likes)} likes`}
              {p.latest.retention != null && ` · ${p.latest.retention.toLocaleString('es-ES')} % retención`}
              {p.studio.viewedPct != null && ` · ${p.studio.viewedPct.toLocaleString('es-ES')} % vieron`}
              {p.source === 'metricool' && <span className="src metricool">Metricool</span>}
              <span className={`src ${Object.values(p.origin)[0] ?? 'none'}`}>{Object.values(p.origin).includes('api') ? 'API' : Object.values(p.origin).length ? 'a mano' : 'sin datos'}</span>
            </span>
          ))}
        </div>
      )}
      {v.notes && <p className="xnotes lnotes">{v.notes}</p>}
    </article>
  )
}

/**
 * Vídeos largos de los canales propios: cada uno con su carpeta (vídeo, 3 miniaturas, subtítulos) y sus
 * 3 títulos en orden A, B, C. La aplicación solo los lee de la carpeta VIDEOS_LARGOS.
 */
export function LongVideosView(props: { kind?: LongKind; refresh: number; onChanged: () => void; onImport?: () => void; onStats?: () => void }) {
  const kind = props.kind ?? 'long'
  const t = TEXTOS[kind]
  const propio = PROPIOS.includes(kind)
  const [datos, setDatos] = useState<Datos | null>(null)
  const [cifras, setCifras] = useState<Map<string, OwnVideoStats>>(new Map())
  const [form, setForm] = useState<LongVideo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    void window.contentOS.listLongVideos(kind).then((d) => vivo && setDatos(d))
    if (propio) void window.contentOS.getOwnStats(kind as OwnChannel).then((s) => vivo && setCifras(new Map(s.videos.map((x) => [x.id, x]))))
    return () => {
      vivo = false
    }
  }, [props.refresh, kind])

  if (!datos) return null

  const marcar = async (id: string, on: boolean, platform?: CityPlatform) => {
    setBusy(true)
    setError(null)
    try {
      setDatos(await window.contentOS.setLongUploaded(id, on, kind, platform))
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const sinSubir = datos.videos.filter((v) => (kind === 'city' ? pendienteCiudad(v) : !v.uploadedAt && !v.scheduledAt)).length
  const programados = datos.videos.filter((v) => v.scheduledAt).length
  const recargarCifras = async () => {
    if (propio) setCifras(new Map((await window.contentOS.getOwnStats(kind as OwnChannel)).videos.map((x) => [x.id, x])))
  }

  return (
    <>
      <PageHeader title={t.title} titleTest="long-title"
        meta={<span data-test="long-count">{datos.total} {datos.total === 1 ? 'vídeo' : 'vídeos'}{datos.total > 0 && ` · ${sinSubir} por subir a mano`}{programados > 0 && ` · ${programados} en Metricool`}</span>}>
        {propio && props.onStats && <button className="btn" data-test="long-go-stats" onClick={props.onStats}><ChartColumn size={14} />Estadísticas</button>}
        {propio && props.onImport && <button className="btn primary" data-test="long-import" onClick={props.onImport}><Upload size={14} />Añadir vídeos</button>}
        <button className="btn" data-test="long-folder" onClick={() => void window.contentOS.showLongInFolder(null, kind)}><FolderOpen size={14} />Abrir carpeta</button>
      </PageHeader>
      {error && <div className="banner bad" data-test="long-error"><span>{error}</span></div>}
      {kind === 'city' && <PanelCiudad c={datos.city} />}
      {(datos.alerts ?? []).length > 0 && (
        <div className="banner bad" data-test="long-alerts">
          <span><strong>Cola de Metricool:</strong> {datos.alerts!.join(' · ')}</span>
        </div>
      )}
      {datos.total === 0 ? (
        <Empty title={t.empty} test="long-empty">
          <p>{t.intro}</p>
          <p className="faint small">Van en la carpeta <code>{datos.folder}</code>, una subcarpeta por vídeo.</p>
        </Empty>
      ) : (
        <div className="llist">
          {datos.videos.map((v) => (
            <Ficha key={v.id} v={v} kind={kind} busy={busy} stats={cifras.get(v.id)} onStats={propio ? () => setForm(v) : undefined}
              onToggle={(on, platform) => void marcar(v.id, on, platform).then(recargarCifras)} />
          ))}
        </div>
      )}
      {form && (
        <OwnStatsForm channel={kind as OwnChannel} video={form.id} title={form.titles[0]?.text ?? form.id}
          onDone={(s) => { setCifras(new Map(s.videos.map((x) => [x.id, x]))); void window.contentOS.listLongVideos(kind).then(setDatos); props.onChanged() }}
          onClose={() => setForm(null)} />
      )}
    </>
  )
}
