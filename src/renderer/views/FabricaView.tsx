import { AlertTriangle, CalendarClock, Check, ChevronDown, ChevronRight, Clapperboard, ExternalLink, FileText, Film, FolderOpen, Gauge, Images, Lightbulb, Mic, Play, Search, ShieldCheck, Sparkles, TrendingUp, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fabricaImageUrl, type FabricaView as Datos } from '../../core/api'
import { tandaEnMarcha, type FabricaCola, type FabricaMejoras, type FabricaPaso, type FabricaTanda, type FabricaTema, type FabricaVideo } from '../../core/fabrica'
import { Empty } from '../components/Common'
import { estadoAgentes, FabricaSala } from '../components/FabricaSala'

/**
 * «Fábrica» de Curiosidades (16-nov-2026): el equipo de agentes de Claude que busca temas, escribe, anima y
 * revisa los Shorts. Aquí se ve cada tanda, la nota del revisor de cada vídeo y la cola de subida.
 * «Hacer tanda» abre una ventana con Claude Code haciendo /fabrica N; el panel se actualiza solo mientras tanto.
 */

const PASOS: { id: FabricaPaso; nombre: string }[] = [
  { id: 'tema', nombre: 'Tema' },
  { id: 'guion', nombre: 'Guion' },
  { id: 'voz', nombre: 'Voz y música' },
  { id: 'animacion', nombre: 'Animación' },
  { id: 'revision', nombre: 'Revisión' },
  { id: 'listo', nombre: 'Listo' }
]
const EQUIPO = [
  { icon: Search, nombre: 'Cazador de temas', que: 'Busca historias reales con giro y comprueba cada dato en 2 fuentes' },
  { icon: FileText, nombre: 'Guionista', que: 'Escribe el guion con la receta de los vídeos 41 y 42' },
  { icon: Mic, nombre: 'Voz y música', que: 'Pone la voz y la música propia' },
  { icon: Clapperboard, nombre: 'Animador', que: 'Monta y anima el vídeo' },
  { icon: ShieldCheck, nombre: 'Revisor', que: 'Pone nota sobre 100: pasa con 80 o más; si no, se rehace o se tira' },
  { icon: TrendingUp, nombre: 'Mejorador', que: 'Cada día mira los Shorts más virales y nuestras cifras, y propone cómo mejorar' }
]

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** «lun 17 nov» (una 2.ª tanda del mismo día, «2026-11-16-2», sale como «dom 16 nov (2)»). */
const fechaLarga = (f: string) => {
  const d = new Date(f.slice(0, 10) + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }).replace('.', '')
  return f.length > 10 ? `${d} (${f.slice(11)})` : d
}
const claseNota = (n: number | null) => (n == null ? 'gris' : n >= 80 ? 'verde' : n >= 65 ? 'ocre' : 'rojo')
const enMarcha = (t: FabricaTanda) => tandaEnMarcha(t)

export function FabricaView({ refresh }: { refresh: number }) {
  const [datos, setDatos] = useState<Datos | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fecha, setFecha] = useState<string | null>(null)
  const [tamaño, setTamaño] = useState(3)
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null)

  const cargar = useCallback(async () => {
    try {
      setDatos(await window.contentOS.getFabrica())
      setError(null)
    } catch (e) {
      setError(mensaje(e))
    }
  }, [])
  useEffect(() => { void cargar() }, [cargar, refresh])
  // mientras haya una tanda en marcha (o se acabe de lanzar), se vuelve a leer cada 10 s
  const vigilando = !!aviso?.ok || !!datos?.tandas.some(enMarcha)
  useEffect(() => {
    if (!vigilando) return
    const t = setInterval(() => void cargar(), 10_000)
    return () => clearInterval(t)
  }, [vigilando, cargar])

  const hacerTanda = async () => {
    const r = await window.contentOS.fabricaStart(tamaño)
    setAviso(r.ok
      ? { ok: true, texto: `Se ha abierto una ventana con Claude haciendo una tanda de ${tamaño}. Tarda un rato: este panel se va actualizando solo.` }
      : { ok: false, texto: r.error ?? 'No se ha podido abrir.' })
  }
  const abrir = async (what: 'folder' | 'report' | 'video' | 'sheet' | 'mejoras' | 'link', ref?: string) => {
    const r = await window.contentOS.fabricaOpen(what, ref)
    if (!r.ok) setAviso({ ok: false, texto: r.error ?? 'No se ha podido abrir.' })
  }

  if (error) return <Empty title="No se ha podido leer la fábrica">{error}</Empty>
  if (!datos) return <p className="faint">Cargando…</p>

  const tanda = datos.tandas.find((t) => t.fecha === fecha) ?? datos.tandas[0] ?? null
  const ultimaMejora = datos.mejoras[0]
  const hoy = new Date().toLocaleDateString('sv-SE')
  const actual = datos.tandas[0] ?? null
  const agentes = estadoAgentes(actual, ultimaMejora?.fecha === hoy)

  return (
    <div className="fab" data-test="fabrica">
      <div className="hhead">
        <div>
          <h1 data-test="page-title">Fábrica de vídeos</h1>
          <p className="faint small fab-sub">Curiosidades · un equipo de Claude busca temas, escribe, anima y revisa. Solo pasa lo que saca 80 o más.</p>
        </div>
        <span className="sp" />
        <div className="seg pills" title="Cuántos vídeos hace en cada tanda" data-test="fab-size">
          {[3, 5].map((n) => (
            <button key={n} className={tamaño === n ? 'on' : ''} onClick={() => setTamaño(n)}>{n} vídeos</button>
          ))}
        </div>
        <button className="btn pill primary fab-go" data-test="fab-start" onClick={hacerTanda}><Play size={14} />Hacer tanda</button>
        <button className="btn pill" data-test="fab-folder" title={datos.carpeta} onClick={() => abrir('folder')}><FolderOpen size={14} />Carpeta</button>
      </div>

      {aviso && (
        <div className={`fab-aviso glass ${aviso.ok ? 'ok' : 'bad'}`} data-test="fab-aviso">
          {aviso.ok ? <Sparkles size={15} /> : <X size={15} />}
          <span>{aviso.texto}</span>
          <button className="btn ghost round" title="Cerrar" onClick={() => setAviso(null)}><X size={13} /></button>
        </div>
      )}

      {ultimaMejora?.importante && (
        <div className="fab-aviso glass importante" data-test="fab-importante">
          <AlertTriangle size={16} />
          <span><b>Mejora gratis importante</b> ({fechaLarga(ultimaMejora.fecha)}): {ultimaMejora.aviso || ultimaMejora.resumen}</span>
          {ultimaMejora.tieneInforme && <button className="btn pill" onClick={() => abrir('mejoras', ultimaMejora.fecha)}><FileText size={14} />Ver</button>}
        </div>
      )}

      <section className="opanel glass fab-equipo">
        <h3><Sparkles size={15} />La sala{actual && enMarcha(actual) ? <span className="chip ocre">Trabajando ahora</span> : <span className="chip">En reposo · próxima tanda a las 7:05</span>}</h3>
        <FabricaSala agentes={agentes} enMarcha={!!actual && enMarcha(actual)} />
        <ol className="fab-cadena">
          {EQUIPO.map((p, i) => (
            <li key={p.nombre}>
              <span className="fab-ico"><p.icon size={16} /></span>
              <div><b>{p.nombre}</b><span className="faint small">{p.que}</span></div>
              {i < EQUIPO.length - 1 && <ChevronRight className="fab-flecha" size={16} />}
            </li>
          ))}
        </ol>
      </section>

      {!datos.existe ? (
        <Empty title="No encuentro la carpeta del canal">{datos.carpeta}</Empty>
      ) : !tanda ? (
        <Empty title="Todavía no hay ninguna tanda">Pulsa «Hacer tanda» y aparecerá aquí, paso a paso.</Empty>
      ) : (
        <>
          <div className="fab-tandas">
            <h2>Tanda del {fechaLarga(tanda.fecha)}{enMarcha(tanda) && <span className="chip ocre" data-test="fab-running">En marcha</span>}</h2>
            <span className="sp" />
            {datos.tandas.length > 1 && (
              <div className="seg pills" data-test="fab-tandas">
                {datos.tandas.slice(0, 6).map((t) => (
                  <button key={t.fecha} className={t.fecha === tanda.fecha ? 'on' : ''} onClick={() => setFecha(t.fecha)}>{fechaLarga(t.fecha)}</button>
                ))}
              </div>
            )}
            {tanda.tieneInforme && <button className="btn pill" onClick={() => abrir('report', tanda.fecha)}><FileText size={14} />Informe</button>}
          </div>

          <Cifras tanda={tanda} />

          <div className="fab-videos" data-test="fab-videos">
            {tanda.videos.map((v) => <Tarjeta key={v.id} v={v} onOpen={abrir} />)}
          </div>

          <div className="ogrid">
            <Temas temas={tanda.temas} />
            <Cola tanda={tanda} />
          </div>
        </>
      )}

      {datos.existe && <Mejoras lista={datos.mejoras} onOpen={abrir} />}
    </div>
  )
}

function Cifras({ tanda }: { tanda: FabricaTanda }) {
  const aprobados = tanda.videos.filter((v) => v.paso === 'listo' && (v.nota ?? 0) >= 80)
  const notas = tanda.videos.map((v) => v.nota).filter((n): n is number => n != null)
  const media = notas.length ? Math.round(notas.reduce((a, b) => a + b, 0) / notas.length) : null
  const elegidos = tanda.temas.filter((t) => t.estado === 'elegido').length
  const reserva = tanda.temas.filter((t) => t.estado === 'reserva').length
  const programados = tanda.cola.filter((c) => c.estado !== 'propuesto').length
  return (
    <div className="kpis four fab-kpis">
      <div className="kpi glass"><span className="kicon fk-verde"><Check size={16} /></span><span className="klbl">Vídeos aprobados</span>
        <span className="knum">{aprobados.length}<small> de {tanda.n}</small></span></div>
      <div className="kpi glass"><span className="kicon fk-azul"><Gauge size={16} /></span><span className="klbl">Nota media</span>
        <span className={`knum t-${claseNota(media)}`}>{media ?? '—'}<small> / 100</small></span></div>
      <div className="kpi glass"><span className="kicon fk-ocre"><Lightbulb size={16} /></span><span className="klbl">Temas encontrados</span>
        <span className="knum">{tanda.temas.length}</span><span className="kfoot faint small">{elegidos} elegidos · {reserva} de reserva</span></div>
      <div className="kpi glass"><span className="kicon fk-morado"><CalendarClock size={16} /></span><span className="klbl">En la cola de subida</span>
        <span className="knum">{tanda.cola.length}</span>
        <span className="kfoot faint small">{tanda.cola.length === 0 ? 'Sin lista todavía' : programados ? `${programados} programados en Metricool` : 'Esperando tu OK'}</span></div>
    </div>
  )
}

function Tarjeta({ v, onOpen }: { v: FabricaVideo; onOpen: (what: 'video' | 'sheet', ref: string) => void }) {
  const [abierta, setAbierta] = useState(false)
  const [sinFoto, setSinFoto] = useState(false)
  const r = v.revision
  const total = r?.total ?? v.nota
  const veredicto = v.paso === 'tirado' ? 'tirar' : r?.veredicto ?? null
  const iPaso = PASOS.findIndex((p) => p.id === v.paso)
  return (
    <article className={`fab-card glass ${v.paso === 'tirado' ? 'tirado' : ''}`} data-test="fab-card">
      <div className="fab-foto">
        {v.conFoto && !sinFoto ? <img src={fabricaImageUrl(v.id, 'f00_4.jpg')} alt="" onError={() => setSinFoto(true)} /> : <div className="fab-foto-ph"><Film size={22} /></div>}
        <span className="fab-num">{v.id.split('-')[0]}</span>
      </div>
      <div className="fab-info">
        <div className="fab-top">
          <h4 title={v.tema}>{v.titulo}</h4>
          <div className={`fab-nota n-${claseNota(total)}`} title="Nota del revisor">{total ?? '—'}</div>
        </div>
        <div className="fab-chips">
          {veredicto && <span className={`chip ${veredicto === 'pasa' ? 'verde' : veredicto === 'rehacer' ? 'ocre' : 'rojo'}`}>{veredicto === 'pasa' ? 'Pasa' : veredicto === 'rehacer' ? 'Rehacer' : 'Tirado'}</span>}
          {v.render && <span className="chip gris">{v.render}</span>}
          {v.intentos > 0 && <span className="chip gris">{v.intentos} {v.intentos === 1 ? 'intento' : 'intentos'}</span>}
        </div>
        {v.paso !== 'tirado' ? (
          <ol className="fab-pasos" aria-label="Paso">
            {PASOS.map((p, i) => <li key={p.id} className={i < iPaso || v.paso === 'listo' ? 'hecho' : i === iPaso ? 'ahora' : ''} title={p.nombre}><span>{p.nombre}</span></li>)}
          </ol>
        ) : v.motivo && <p className="small bad">{v.motivo}</p>}
        {r && (r.guion != null || r.video != null) && (
          <div className="fab-partes small">
            {r.guion != null && <span>Guion <b>{r.guion}</b>/60</span>}
            {r.video != null && <span>Vídeo <b>{r.video}</b>/40</span>}
            {r.notaTema != null && <span>Tema <b>{r.notaTema}</b>/10</span>}
          </div>
        )}
        <div className="fab-acc">
          <button className="btn ghost small" onClick={() => onOpen('video', v.id)}><Play size={13} />Ver vídeo</button>
          <button className="btn ghost small" onClick={() => onOpen('sheet', v.id)}><Images size={13} />Fotogramas</button>
          {r && <button className="btn ghost small" data-test="fab-why" onClick={() => setAbierta(!abierta)}>{abierta ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Por qué esta nota</button>}
        </div>
        {abierta && r && (
          <div className="fab-detalle">
            <ul className="fab-barras">
              {r.detalle.map((d) => (
                <li key={d.nombre}>
                  <span className="small">{d.nombre}</span>
                  <span className="fab-barra"><i style={{ width: `${d.max ? Math.min(100, (d.puntos / d.max) * 100) : 0}%` }} className={d.max && d.puntos < d.max * 0.7 ? 'flojo' : ''} /></span>
                  <span className="small mono">{d.puntos}{d.max ? `/${d.max}` : ''}</span>
                </li>
              ))}
            </ul>
            {r.queRehacer && <p className="small"><b>Qué rehacer:</b> {r.queRehacer}</p>}
            {r.notasVideo && <p className="small faint"><b>Vídeo:</b> {r.notasVideo}</p>}
            {r.notasGuion && <p className="small faint"><b>Guion:</b> {r.notasGuion}</p>}
          </div>
        )}
      </div>
    </article>
  )
}

const ESTADO_TEMA: Record<FabricaTema['estado'], [string, string]> = {
  elegido: ['Elegido', 'verde'],
  reserva: ['Reserva', 'azul'],
  fuera: ['Fuera', 'gris'],
  'sin revisar': ['Sin revisar', 'gris']
}

function Temas({ temas }: { temas: FabricaTema[] }) {
  const [abierto, setAbierto] = useState<string | null>(null)
  return (
    <section className="opanel glass" data-test="fab-temas">
      <h3><Lightbulb size={15} />Temas del cazador</h3>
      <p className="faint small">Los de reserva (nota 7 o más) se usan en la próxima tanda o si un vídeo se tira.</p>
      {temas.length === 0 ? <p className="faint small">El cazador todavía no ha traído temas.</p> : (
        <ul className="fab-temas">
          {temas.map((t) => {
            const [txt, color] = ESTADO_TEMA[t.estado]
            return (
              <li key={t.id} className={t.estado === 'fuera' ? 'apagado' : ''}>
                <button onClick={() => setAbierto(abierto === t.id ? null : t.id)}>
                  <span className={`fab-tnota n-${t.nota == null ? 'gris' : t.nota >= 7 ? 'verde' : 'gris'}`}>{t.nota ?? '—'}</span>
                  <span className="fab-ttema">{t.tema}</span>
                  <span className={`chip ${color}`}>{txt}</span>
                </button>
                {abierto === t.id && (
                  <div className="fab-tdet small">
                    {t.gancho && <p><b>Gancho:</b> {t.gancho}</p>}
                    {t.comentario && <p className="faint"><b>Revisor:</b> {t.comentario}</p>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const ESTADO_COLA: Record<FabricaCola['estado'], [string, string]> = {
  propuesto: ['Espera tu OK', 'ocre'],
  programado: ['Programado', 'verde'],
  publicado: ['Publicado', 'azul']
}

function Cola({ tanda }: { tanda: FabricaTanda }) {
  const cr = tanda.colaRevisada
  return (
    <section className="opanel glass" data-test="fab-cola">
      <h3><CalendarClock size={15} />Cola de subida · YouTube Shorts</h3>
      <p className="faint small">2 al día, 10:00 y 16:00: la fábrica programa sola lo que aprueba el revisor. {tanda.metricool}</p>
      {tanda.cola.length === 0 ? <p className="faint small">Sin lista todavía.</p> : (
        <ul className="fab-cola">
          {tanda.cola.map((c) => {
            const [txt, color] = ESTADO_COLA[c.estado]
            return (
              <li key={c.dia + c.hora + c.video}>
                <span className="fab-dia">{fechaLarga(c.dia)}{c.hora && <b className="fab-hora">{c.hora}</b>}</span>
                <span className="fab-cvid" title={c.archivo}>{c.video}</span>
                <span className={`chip ${color}`}>{txt}</span>
              </li>
            )
          })}
        </ul>
      )}
      {cr && (
        <div className="fab-revcola">
          <p className="small"><b>Revisión de la cola antigua</b></p>
          <div><span className="chip verde">Pasan</span> {cr.pasa.join(' · ') || '—'}</div>
          <div><span className="chip ocre">Rehacer</span> {cr.rehacer.join(' · ') || '—'}</div>
          <div><span className="chip rojo">Fuera</span> <span className="faint">{cr.tirar.join(' · ') || '—'}</span></div>
        </div>
      )}
    </section>
  )
}

const IMPORTANCIA: Record<FabricaMejoras['mejoras'][number]['importancia'], [string, string]> = {
  alta: ['Importante', 'rojo'],
  media: ['Media', 'ocre'],
  baja: ['Baja', '']
}
const QUIEN: Record<string, string> = {
  cazador: 'Cazador de temas', guionista: 'Guionista', animador: 'Animador', revisor: 'Revisor', voz: 'Voz',
  musica: 'Música', subida: 'Subida', juan: 'Tú'
}
const miles = (n: number | null) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 1 })} M` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n))

/** «Cómo mejorar»: el informe diario del mejorador (virales de fuera + nuestras cifras → mejoras gratis y de pago). */
export function Mejoras({ lista, onOpen }: { lista: FabricaMejoras[]; onOpen: (what: 'mejoras' | 'link', ref: string) => void }) {
  const [fecha, setFecha] = useState<string | null>(null)
  const [tipo, setTipo] = useState<'gratis' | 'pago'>('gratis')
  const m = lista.find((x) => x.fecha === fecha) ?? lista[0]
  if (!m) {
    return (
      <section className="opanel glass fab-mejoras" data-test="fab-mejoras">
        <h3><TrendingUp size={15} />Cómo mejorar</h3>
        <p className="faint small">El mejorador hace su primer informe con la próxima tanda: mira los Shorts más virales del momento y nuestras cifras, y propone cambios gratis y de pago.</p>
      </section>
    )
  }
  const visibles = m.mejoras.filter((x) => x.tipo === tipo)
  const cuenta = (t: 'gratis' | 'pago') => m.mejoras.filter((x) => x.tipo === t).length
  return (
    <section className="opanel glass fab-mejoras" data-test="fab-mejoras">
      <div className="fab-mhead">
        <h3><TrendingUp size={15} />Cómo mejorar · {fechaLarga(m.fecha)}</h3>
        <span className="sp" />
        {lista.length > 1 && (
          <div className="seg pills">
            {lista.slice(0, 5).map((x) => <button key={x.fecha} className={x.fecha === m.fecha ? 'on' : ''} onClick={() => setFecha(x.fecha)}>{fechaLarga(x.fecha)}</button>)}
          </div>
        )}
        {m.tieneInforme && <button className="btn pill" onClick={() => onOpen('mejoras', m.fecha)}><FileText size={14} />Informe</button>}
      </div>
      {m.resumen && <p className="fab-mres">{m.resumen}</p>}
      {m.nuestros && <p className="faint small"><b>Nuestros vídeos:</b> {m.nuestros}</p>}

      <div className="seg pills fab-mtipo" data-test="fab-mtipo">
        <button className={tipo === 'gratis' ? 'on' : ''} onClick={() => setTipo('gratis')}>Gratis ({cuenta('gratis')})</button>
        <button className={tipo === 'pago' ? 'on' : ''} onClick={() => setTipo('pago')}>Pagando ({cuenta('pago')})</button>
      </div>
      {visibles.length === 0 ? <p className="faint small">Hoy no hay ninguna {tipo === 'gratis' ? 'mejora gratis' : 'mejora de pago'} que valga la pena.</p> : (
        <ul className="fab-mlista">
          {visibles.map((x) => {
            const [txt, color] = IMPORTANCIA[x.importancia]
            return (
              <li key={x.titulo} className={x.importancia}>
                <div className="fab-mtop">
                  <b>{x.titulo}</b>
                  <span className={`chip ${color}`}>{txt}</span>
                  {x.tipo === 'pago' && x.coste && <span className="chip azul">{x.coste}</span>}
                  {x.quien && <span className="chip">{QUIEN[x.quien] ?? x.quien}</span>}
                </div>
                {x.que && <p>{x.que}</p>}
                {x.porQue && <p className="faint small">Por qué: {x.porQue}</p>}
              </li>
            )
          })}
        </ul>
      )}

      {m.virales.length > 0 && (
        <>
          <h4 className="fab-mvh">Los virales que ha mirado</h4>
          <ul className="fab-virales">
            {m.virales.map((v) => (
              <li key={v.enlace || v.titulo}>
                <button className="btn ghost" disabled={!v.enlace} onClick={() => onOpen('link', v.enlace)} title={v.enlace}>
                  <ExternalLink size={13} /><span className="fab-vt">{v.titulo}</span>{v.visitas != null && <span className="chip">{miles(v.visitas)} visitas</span>}
                </button>
                {v.porQue && <p className="faint small">{v.porQue}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
