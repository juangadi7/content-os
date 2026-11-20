import { CalendarClock, CircleCheck, Clock, ExternalLink, ListOrdered, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MetricoolQueueView as Datos } from '../../core/api'
import { Empty } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

const dia = (at: string | null) => {
  if (!at) return { d: 'Sin fecha', h: '' }
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) return { d: at, h: '' }
  return {
    d: t.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', ''),
    h: t.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  }
}
const fechaLarga = (at: string | null) => (at ? `${dia(at).d} · ${dia(at).h}` : '—')

/** «Cola de Metricool»: lo que la fábrica tiene preparado para subirse, por fecha (lee fabrica/datos/cola_metricool.json). */
export function MetricoolQueueView(props: { refresh: number }) {
  const [d, setD] = useState<Datos | null>(null)
  useEffect(() => {
    let vivo = true
    const leer = () => void window.contentOS.getMetricoolQueue().then((x) => vivo && setD(x))
    leer()
    // la fábrica la actualiza sola: se vuelve a leer cada minuto mientras la pantalla está abierta
    const id = window.setInterval(leer, 60_000)
    return () => {
      vivo = false
      window.clearInterval(id)
    }
  }, [props.refresh])
  if (!d) return null

  const hoy = new Date().toDateString()
  return (
    <>
      <PageHeader title="Cola de Metricool" titleTest="queue-title"
        meta={<span>Curiosidades · {d.updatedAt ? `actualizada ${fechaLarga(d.updatedAt)}` : 'sin actualizar'}</span>} />

      {!d.exists ? (
        <Empty title="Todavía no hay cola" test="queue-empty">
          <p>Aquí aparece lo que la fábrica deja programado en Metricool para subirse (archivo fabrica/datos/cola_metricool.json del canal de curiosidades).</p>
        </Empty>
      ) : (
        <>
          {d.problems.length > 0 && (
            <div className="banner bad" data-test="queue-problems">
              <TriangleAlert size={15} />
              <span>{d.problems.map((p, i) => <span key={i} className="qprob">{p}</span>)}</span>
            </div>
          )}
          <section className="kpis four" data-test="queue-summary">
            <div className="kpi glass">
              <span className="kicon"><ListOrdered size={15} /></span>
              <span className="klbl">En cola</span>
              <span className="knum">{d.pending}</span>
              <span className="kfoot"><span className="faint small">{d.pending === 1 ? 'vídeo programado' : 'vídeos programados'}</span></span>
            </div>
            <div className="kpi glass">
              <span className="kicon"><CalendarClock size={15} /></span>
              <span className="klbl">Hay vídeos hasta</span>
              <span className="knum qdate">{d.lastAt ? dia(d.lastAt).d : '—'}</span>
              <span className="kfoot"><span className="faint small">{d.lastAt ? `último a las ${dia(d.lastAt).h}` : 'cola vacía'}</span></span>
            </div>
            <div className={`kpi glass ${d.freeLeft <= 3 ? 'k-warn' : ''}`}>
              <span className="kicon"><Clock size={15} /></span>
              <span className="klbl">Gratis este mes</span>
              <span className="knum">{d.freeLeft}<span className="kof"> / 20</span></span>
              <span className="kfoot"><span className="faint small">{d.usedThisMonth} usados según la cola (plan gratis: 20 al mes)</span></span>
            </div>
            <div className="kpi glass">
              <span className="kicon"><CircleCheck size={15} /></span>
              <span className="klbl">Ya publicados</span>
              <span className="knum">{d.items.filter((i) => i.state === 'publicado').length}</span>
              <span className="kfoot"><span className="faint small">por Metricool</span></span>
            </div>
          </section>

          <section className="opanel glass" data-test="queue-list">
            {d.items.length === 0 && <p className="faint small">La cola está vacía.</p>}
            <ol className="qlist">
              {d.items.map((i) => {
                const f = dia(i.at)
                const esHoy = i.at ? new Date(i.at).toDateString() === hoy : false
                return (
                  <li key={`${i.folder}-${i.at}`} className={`qitem ${i.state} ${i.problem ? 'prob' : ''} ${esHoy ? 'hoy' : ''}`} data-test="queue-item" data-state={i.state}>
                    <div className="qwhen">
                      <span className="qday">{f.d}</span>
                      <span className="qhour">{f.h}</span>
                    </div>
                    <div className="qbody">
                      <strong className="ell" title={i.title ?? i.folder}>{i.number && <span className="qnum">{i.number}</span>}{i.title ?? i.folder}</strong>
                      <span className="faint small">{i.network}{i.problem && <span className="bad"> · {i.problem === 'ya_publicado' ? 'ya estaba publicado' : i.problem === 'doble' ? 'programado dos veces' : i.problem}</span>}</span>
                    </div>
                    <span className={`qstate ${i.state}`}>{i.state === 'publicado' ? 'Publicado' : esHoy ? 'Hoy' : 'Programado'}</span>
                    {i.youtubeId
                      ? <a className="btn small ghost" href={`https://www.youtube.com/shorts/${i.youtubeId}`} target="_blank" rel="noreferrer" title="Ver en YouTube"><ExternalLink size={13} /></a>
                      : <span />}
                  </li>
                )
              })}
            </ol>
          </section>
          <p className="faint small">La cola la mantiene la fábrica del canal; aquí solo se mira. Lo que no está en la cola lo subes tú a mano (Curiosidades → Vídeos).</p>
        </>
      )}
    </>
  )
}
