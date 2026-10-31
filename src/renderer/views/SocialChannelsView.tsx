import { ArrowDown, ArrowUp, CircleAlert, ExternalLink, Info, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AppState, SocialAccountView, SocialPlatform, SocialVideoView } from '../../core/api'
import { formatCount, formatDuration, relativeTime } from '../../core/format'
import { diaCorto, Sparkline } from '../components/charts'
import { Empty, Thumb } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const subido = (iso: string | null) => (iso ? `${new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} · ${new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : '—')
const pct = (likes: number | null, views: number | null) => (likes == null || !views ? '—' : ((likes / views) * 100).toFixed(1).replace('.', ',') + ' %')
const NOMBRE: Record<SocialPlatform, string> = { tiktok: 'TikTok', instagram: 'Instagram' }
const RECIENTE_MS = 48 * 3600_000
const mediana = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

type Clave = 'date' | 'views' | 'gain' | 'likes'
type Filtro = 'todos' | 'clip' | 'sin' | 'repetidos'

/** Cuentas de TikTok o Instagram: cifras de cada vídeo, de qué clip es y si repite a otro (REGLA Nº1). */
export function SocialChannelsView(props: { platform: SocialPlatform; state: AppState; refresh: number; onOpen: (clipId: string) => void; onChanged: () => void }) {
  const { platform } = props
  const [cuentas, setCuentas] = useState<SocialAccountView[] | null>(null)
  const [elegida, setElegida] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [orden, setOrden] = useState<{ clave: Clave; asc: boolean }>({ clave: 'date', asc: false })
  const [filtro, setFiltro] = useState<Filtro>('todos')
  const ig = platform === 'instagram'

  useEffect(() => {
    let vivo = true
    void window.contentOS.socialDashboard().then((c) => vivo && setCuentas(c)).catch((e) => vivo && setAviso(mensaje(e)))
    return () => {
      vivo = false
    }
  }, [props.refresh])

  const deEsta = useMemo(() => (cuentas ?? []).filter((c) => c.platform === platform), [cuentas, platform])
  const cuenta = deEsta.find((c) => c.account === elegida) ?? deEsta[0] ?? null
  const videos = useMemo(() => {
    if (!cuenta) return []
    const valor = (v: SocialVideoView): number | null =>
      orden.clave === 'date' ? (v.publishedAt ? Date.parse(v.publishedAt) : null) : orden.clave === 'views' ? v.views : orden.clave === 'gain' ? v.gain?.views ?? null : v.likes
    return cuenta.videos
      .filter((v) => filtro === 'todos' || (filtro === 'clip' ? !!v.clipId : filtro === 'sin' ? !v.clipId : !!v.repeatOf))
      .sort((a, b) => {
        const x = valor(a)
        const y = valor(b)
        if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
        return orden.asc ? x - y : y - x
      })
  }, [cuenta, orden, filtro])

  const actualizar = async () => {
    setBusy(true)
    setAviso(null)
    try {
      const r = await window.contentOS.socialRefresh(true)
      const fallos = r.accounts.filter((a) => !a.ok && a.platform === platform)
      if (fallos.length) setAviso(fallos.map((f) => `${f.account}: ${f.error}`).join(' · '))
      setCuentas(await window.contentOS.socialDashboard())
      props.onChanged()
    } catch (e) {
      setAviso(mensaje(e))
    } finally {
      setBusy(false)
    }
  }

  const conectada = props.state.socialConnected.some((c) => c.platform === platform)
  const boton = (
    <button className="btn" data-test="social-refresh" disabled={busy || !conectada} onClick={() => void actualizar()}>
      <RefreshCw size={14} className={busy ? 'spin' : ''} />{busy ? 'Actualizando…' : 'Actualizar cifras'}
    </button>
  )

  if (!cuentas) return <PageHeader title="Canales" meta={aviso ?? 'Cargando…'} />
  if (!cuenta) {
    return (
      <>
        <PageHeader title="Canales" meta={`Tus cuentas de ${NOMBRE[platform]}`}>{boton}</PageHeader>
        {aviso && <div className="banner bad"><CircleAlert size={15} /><span>{aviso}</span></div>}
        <Empty title={conectada ? 'Aún no se han leído tus cuentas' : `${NOMBRE[platform]} no está conectado`} test="social-empty">
          <p>{conectada ? 'Pulsa «Actualizar cifras» para leerlas ahora (también se leen solas cada 30 minutos).'
            : `Falta la clave de ${NOMBRE[platform]} en la carpeta .secretos de tu usuario. Pídele a Claude que la configure.`}</p>
        </Empty>
      </>
    )
  }

  const ahora = Date.now()
  const conVisitas = cuenta.videos.map((v) => v.views).filter((v): v is number => v != null)
  const mejor = cuenta.videos.reduce<SocialVideoView | null>((m, v) => (v.views != null && (m == null || v.views > m.views!) ? v : m), null)
  const enSemana = cuenta.videos.filter((v) => v.publishedAt && ahora - Date.parse(v.publishedAt) < 7 * 24 * 3600_000).length
  const repetidos = cuenta.videos.filter((v) => v.repeatOf).length
  const emparejados = cuenta.videos.filter((v) => v.clipId).length
  const likes = cuenta.videos.reduce((s, v) => s + (v.likes ?? 0), 0)
  const th = (clave: Clave, texto: string) => (
    <button className={`th num ${orden.clave === clave ? 'on' : ''}`} onClick={() => setOrden((o) => ({ clave, asc: o.clave === clave ? !o.asc : false }))}>
      {texto}{orden.clave === clave && (orden.asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  )
  const chip = (f: Filtro, texto: string, n: number) => (
    <button className={`fchip ${filtro === f ? 'on' : ''} ${f === 'repetidos' && n > 0 ? 'warn' : ''}`} onClick={() => setFiltro(f)}><span>{texto}</span><i>{n}</i></button>
  )

  return (
    <>
      <PageHeader title="Canales" titleTest="channels-title"
        meta={<><span>{NOMBRE[platform]} · API oficial, solo lectura</span><span className="sep">·</span><span>Actualizado {relativeTime(cuenta.lastScanAt)}</span></>}>
        {boton}
      </PageHeader>

      {deEsta.length > 1 && (
        <div className="chan-tabs" data-test="social-accounts">
          {deEsta.map((c) => (
            <button key={c.account} className={`fchip ${c.account === cuenta.account ? 'on' : ''}`} onClick={() => setElegida(c.account)}>
              <span>{c.account}</span><i>{c.videos.length}</i>
            </button>
          ))}
        </div>
      )}
      {aviso && <div className="banner bad"><CircleAlert size={15} /><span>{aviso}</span></div>}
      {cuenta.error && <div className="banner bad"><CircleAlert size={15} /><span>No se pudo leer la última vez: {cuenta.error}. Se enseñan las cifras guardadas.</span></div>}

      <div className="kpis" data-test="social-kpis">
        <div className="tile">
          <div className="k"><i className="sw c-neutral" />Seguidores</div>
          <div className="v">{cuenta.followers == null ? '—' : formatCount(cuenta.followers)}</div>
          <div className="s">{cuenta.followersChange ? <><b className={cuenta.followersChange.delta > 0 ? 'up' : ''}>{cuenta.followersChange.delta > 0 ? '+' : ''}{formatCount(cuenta.followersChange.delta)}</b> desde el {diaCorto(cuenta.followersChange.since.slice(0, 10))}</> : cuenta.displayName ?? cuenta.account}</div>
        </div>
        {ig ? (
          <div className="tile">
            <div className="k"><i className="sw c-views" />Likes</div>
            <div className="v">{formatCount(likes)}</div>
            <div className="s">Las visitas de Instagram llegarán con la próxima actualización de la API.</div>
          </div>
        ) : (
          <div className="tile" data-test="social-views">
            <div className="k"><i className="sw c-views" />Visitas</div>
            <div className="v">{cuenta.totalViews == null ? '—' : formatCount(cuenta.totalViews)}</div>
            <div className="s">{cuenta.gain != null ? <><b className={cuenta.gain > 0 ? 'up' : ''}>+{formatCount(cuenta.gain)}</b> en el último día</> : 'Sin una medición de ayer con la que comparar.'}</div>
          </div>
        )}
        <div className="tile">
          <div className="k"><i className="sw c-goal" />{ig ? 'Emparejados con un clip' : 'Visitas por vídeo'}</div>
          <div className="v">{ig ? `${emparejados}/${cuenta.videos.length}` : mediana(conVisitas) == null ? '—' : formatCount(mediana(conVisitas))}</div>
          <div className="s">{ig ? 'Publicaciones que la app ha reconocido como clips tuyos.' : <>Mediana de {conVisitas.length} vídeos.{mejor && <> El mejor: <b>{formatCount(mejor.views)}</b></>}</>}</div>
        </div>
        <div className="tile">
          <div className="k"><i className="sw c-neutral" />{ig ? 'Publicaciones' : 'Vídeos'}</div>
          <div className="v">{cuenta.videoCount ?? cuenta.videos.length}</div>
          <div className="s">{enSemana} {enSemana === 1 ? 'subido' : 'subidos'} en los últimos 7 días.</div>
        </div>
      </div>

      {repetidos > 0 && (
        <div className="banner bad" data-test="social-repeated">
          <TriangleAlert size={15} />
          <span><b>REGLA Nº1:</b> {repetidos === 1 ? 'hay 1 vídeo que repite' : `hay ${repetidos} vídeos que repiten`} a otro ya subido en {NOMBRE[platform]}. Pulsa «Repetidos» para verlos y borra a mano el que tenga menos visitas.</span>
        </div>
      )}

      <section className="panel" data-test="social-videos">
        <header className="panel-h">
          <div>
            <h2>Vídeos</h2>
            <p className="panel-hint">Cada vídeo dice de qué clip y campaña es. Pulsa una fila con clip para abrirlo, o una cabecera para ordenar.</p>
          </div>
          <div className="panel-aside chan-tabs" style={{ marginBottom: 0 }}>
            {chip('todos', 'Todos', cuenta.videos.length)}
            {chip('clip', 'Con clip', emparejados)}
            {chip('sin', 'Sin emparejar', cuenta.videos.length - emparejados)}
            {chip('repetidos', 'Repetidos', repetidos)}
          </div>
        </header>
        <div className="rows flat">
          <div className={`row hdr ${ig ? 'cols-ig' : 'cols-chan'}`}>
            <span />
            <span>Vídeo</span>
            <button className={`th ${orden.clave === 'date' ? 'on' : ''}`} onClick={() => setOrden((o) => ({ clave: 'date', asc: o.clave === 'date' ? !o.asc : false }))}>
              Subido{orden.clave === 'date' && (orden.asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
            </button>
            {!ig && <span className="num">Dur.</span>}
            {!ig && th('views', 'Visitas')}
            {!ig && th('gain', 'Último día')}
            {th('likes', 'Likes')}
            {!ig && <span className="num">% likes</span>}
            <span className="num">Coment.</span>
            {!ig && <span>Evolución</span>}
            <span />
          </div>
          {videos.length === 0 && <div className="nodata"><Info size={15} /><span>No hay vídeos con este filtro.</span></div>}
          {videos.map((v) => (
            <div key={v.videoId} className={`row ${ig ? 'cols-ig' : 'cols-chan'} ${v.clipId ? '' : 'static'}`} data-test="social-row" data-video={v.videoId} onClick={() => v.clipId && props.onOpen(v.clipId)}>
              {v.clipId ? <Thumb clip={{ clipId: v.clipId, hasThumb: v.hasThumb, thumbVersion: v.thumbVersion }} /> : <div className="thumb ph" title="Sin emparejar con un clip">▶</div>}
              <div className="chan-t">
                <span className="t1" title={v.description}>{v.clipTitle ?? (v.description || 'Sin descripción')}</span>
                <span className="t2">
                  {v.campaignName ?? <span className="faint">Sin emparejar con un clip</span>}
                  {v.publishedAt && ahora - Date.parse(v.publishedAt) < RECIENTE_MS && <span className="chip-s" title="Aún está recibiendo su primer reparto">menos de 48 h</span>}
                  {v.repeatOf && <span className="chip-s warn" title="Repite a otro vídeo ya subido en esta plataforma">repetido</span>}
                </span>
              </div>
              <span className="tnum">{subido(v.publishedAt)}</span>
              {!ig && <span className="num tnum">{v.durationSeconds == null ? '—' : formatDuration(v.durationSeconds)}</span>}
              {!ig && <span className="num tnum strong">{v.views == null ? <span className="faint">sin medir</span> : formatCount(v.views)}</span>}
              {!ig && (
                <span className="num tnum" title={v.gain ? `Ganadas en las últimas ${v.gain.hours} h, entre dos mediciones reales` : 'Sin una medición de hace un día con la que comparar'}>
                  {v.gain ? <span className={v.gain.views > 0 ? 'ok' : 'faint'}>+{formatCount(v.gain.views)}</span> : <span className="faint">—</span>}
                </span>
              )}
              <span className="num tnum">{v.likes == null ? '—' : formatCount(v.likes)}</span>
              {!ig && <span className="num tnum">{pct(v.likes, v.views)}</span>}
              <span className="num tnum">{v.comments == null ? '—' : formatCount(v.comments)}</span>
              {!ig && <Sparkline points={v.series.map((p) => ({ publicationId: 0, t: p.t, views: p.views }))} />}
              {v.url ? <a className="ext icon" href={v.url} target="_blank" rel="noreferrer" title={`Abrir en ${NOMBRE[platform]}`} onClick={(e) => e.stopPropagation()}><ExternalLink size={14} /></a> : <span />}
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
