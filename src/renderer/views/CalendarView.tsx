import { CalendarClock, CalendarRange, ChevronLeft, ChevronRight, CircleCheck, Flag, ListTodo, Plus, Send, Sparkles, Trash2, Upload, X, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CalendarDay, CalendarItem, CalendarKind, CalendarView as Calendario } from '../../core/api'
import { PageHeader } from '../components/PageHeader'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fecha = (dia: string) => {
  const [y, m, d] = dia.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const mayuscula = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
/** Texto corto para la celda del mes: «Subir 2 en @canal» -> «↑2 @canal». */
const corto = (i: CalendarItem) => (i.kind === 'upload' ? i.title.replace(/^Subir (d+) en /, '↑$1 ') : i.title)
const SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

const TIPO: Record<CalendarKind, { icon: LucideIcon; label: string }> = {
  upload: { icon: Upload, label: 'Subir' },
  weekend: { icon: CalendarRange, label: 'Fin de semana' },
  vyro: { icon: Send, label: 'Vyro' },
  deadline: { icon: Flag, label: 'Plazo' },
  scheduled: { icon: CalendarClock, label: 'Programado' },
  published: { icon: CircleCheck, label: 'Subido' },
  purge: { icon: Trash2, label: 'Papelera' },
  task: { icon: ListTodo, label: 'Tarea' },
}

/** Lunes de la semana del día 1 hasta el domingo de la semana del último día: siempre semanas completas. */
function rejilla(mes: Date): { from: string; to: string } {
  const primero = new Date(mes.getFullYear(), mes.getMonth(), 1)
  const ultimo = new Date(mes.getFullYear(), mes.getMonth() + 1, 0)
  const desde = new Date(primero)
  desde.setDate(primero.getDate() - ((primero.getDay() + 6) % 7))
  const hasta = new Date(ultimo)
  hasta.setDate(ultimo.getDate() + ((7 - ultimo.getDay()) % 7))
  return { from: iso(desde), to: iso(hasta) }
}

/**
 * Calendario: cada día, lo que toca. Lo automático sale de «Hoy», «Fin de semana» y las campañas; las tareas,
 * de lo que apuntas aquí y de lo que Claude deja en PLAN\calendario.json.
 */
export function CalendarView(props: {
  refresh: number
  onSection: (s: 'today' | 'weekend' | 'vyro') => void
  onOpenClip: (clipId: string) => void
  onOpenCampaign: (campaignId: string) => void
}) {
  const [mes, setMes] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [cal, setCal] = useState<Calendario | null>(null)
  const [elegido, setElegido] = useState<string>(() => iso(new Date()))
  const [texto, setTexto] = useState('')
  const [hora, setHora] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const { from, to } = useMemo(() => rejilla(mes), [mes])

  useEffect(() => {
    let vivo = true
    void window.contentOS.getCalendar(from, to).then((c) => vivo && setCal(c)).catch((e) => vivo && setError(mensaje(e)))
    return () => {
      vivo = false
    }
  }, [from, to, props.refresh, tick])

  const recargar = () => setTick((n) => n + 1)
  const hacer = async (f: () => Promise<unknown>) => {
    setError(null)
    try {
      await f()
      recargar()
    } catch (e) {
      setError(mensaje(e))
    }
  }
  const mover = (n: number) => setMes((m) => new Date(m.getFullYear(), m.getMonth() + n, 1))
  const irAHoy = () => {
    const h = new Date()
    setMes(new Date(h.getFullYear(), h.getMonth(), 1))
    setElegido(iso(h))
  }

  const hoy = cal?.today ?? iso(new Date())
  const dia: CalendarDay | undefined = cal?.days.find((d) => d.date === elegido)
  const pendientesHoy = cal?.days.find((d) => d.date === hoy)?.items.filter((i) => !i.done && !i.forecast && i.kind !== 'published' && i.kind !== 'purge').length ?? 0

  const abrir = (i: CalendarItem) => {
    if (!i.link) return
    if ('view' in i.link) props.onSection(i.link.view)
    else if ('clipId' in i.link) props.onOpenClip(i.link.clipId)
    else props.onOpenCampaign(i.link.campaignId)
  }
  const anadir = () =>
    hacer(async () => {
      await window.contentOS.addCalendarTask({ day: elegido, time: hora || null, text: texto })
      setTexto('')
      setHora('')
    })

  const tituloMes = mayuscula(mes.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }))

  return (
    <>
      <PageHeader title="Calendario" titleTest="calendar-title"
        meta={<span data-test="calendar-today-count">{pendientesHoy ? `Hoy: ${pendientesHoy} ${pendientesHoy === 1 ? 'cosa' : 'cosas'} por hacer` : 'Hoy: nada pendiente'}</span>} />
      {error && <div className="banner bad" data-test="calendar-error"><span>{error}</span></div>}
      {cal?.notesError && <div className="banner warn"><span>{cal.notesError}</span></div>}

      <div className="cal">
        <section className="cal-month">
          <div className="cal-nav">
            <button className="btn small ghost" aria-label="Mes anterior" data-test="calendar-prev" onClick={() => mover(-1)}><ChevronLeft size={16} /></button>
            <h2 data-test="calendar-month">{tituloMes}</h2>
            <button className="btn small ghost" aria-label="Mes siguiente" data-test="calendar-next" onClick={() => mover(1)}><ChevronRight size={16} /></button>
            <span className="sp" />
            <button className="btn small" data-test="calendar-today" onClick={irAHoy}>Hoy</button>
          </div>
          <div className="cal-grid" role="grid">
            {SEMANA.map((s, i) => <div key={s} className={`cal-wd ${i >= 5 ? 'we' : ''}`}>{s}</div>)}
            {(cal?.days ?? []).map((d) => {
              const f = fecha(d.date)
              const fuera = f.getMonth() !== mes.getMonth()
              const finde = f.getDay() === 0 || f.getDay() === 6
              const visibles = d.items.slice(0, 3)
              const resto = d.items.length - visibles.length
              const porHacer = d.items.filter((i) => !i.done && i.kind !== 'published').length
              return (
                <button key={d.date} role="gridcell" data-test="calendar-day" data-day={d.date}
                  className={`cal-cell ${fuera ? 'out' : ''} ${finde ? 'we' : ''} ${d.date === hoy ? 'today' : ''} ${d.date === elegido ? 'sel' : ''} ${d.date < hoy ? 'past' : ''}`}
                  onClick={() => setElegido(d.date)}>
                  <span className="cal-n">{f.getDate()}{d.date >= hoy && porHacer > 0 && <i className="cal-dot" />}</span>
                  {visibles.map((i) => (
                    <span key={i.id} className={`cal-chip k-${i.kind} ${i.done ? 'done' : ''} ${i.forecast ? 'fc' : ''}`} title={i.title}>{corto(i)}</span>
                  ))}
                  {resto > 0 && <span className="cal-more">+{resto} más</span>}
                </button>
              )
            })}
          </div>
          <div className="cal-legend">
            {(['upload', 'weekend', 'deadline', 'scheduled', 'published', 'task'] as CalendarKind[]).map((k) => <span key={k}><i className={`k-${k}`} />{TIPO[k].label}</span>)}
            <span className="faint">Rayado = previsión</span>
          </div>
        </section>

        <aside className="cal-day" data-test="calendar-panel">
          <h2>{mayuscula(fecha(elegido).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }))}{elegido === hoy && <span className="cal-badge">Hoy</span>}</h2>
          {!dia || dia.items.length === 0 ? (
            <p className="faint cal-empty">Nada para este día.</p>
          ) : (
            <ul className="cal-items">
              {dia.items.map((i) => {
                const T = TIPO[i.kind]
                const marcable = i.kind === 'task' && i.taskId !== null
                return (
                  <li key={i.id} className={`cal-item k-${i.kind} ${i.done ? 'done' : ''} ${i.forecast ? 'fc' : ''}`} data-test="calendar-item" data-kind={i.kind} data-source={i.source}>
                    {marcable ? (
                      <input type="checkbox" checked={i.done} data-test="calendar-task-done" aria-label="Hecha"
                        onChange={(e) => void hacer(() => window.contentOS.setCalendarTaskDone(i.taskId!, e.target.checked))} />
                    ) : (
                      <span className="cal-ico"><T.icon size={15} /></span>
                    )}
                    <button className="cal-body" disabled={!i.link} onClick={() => abrir(i)}>
                      <span className="cal-t">{i.time && <b>{i.time}</b>}{i.title}</span>
                      {i.detail && <span className="cal-d">{i.detail}</span>}
                      <span className="cal-tags">
                        <span>{T.label}</span>
                        {i.forecast && <span>previsión</span>}
                        {i.source === 'claude' && <span className="claude"><Sparkles size={11} />de Claude</span>}
                        {i.source === 'mine' && <span>tuya</span>}
                      </span>
                    </button>
                    {i.source === 'mine' && typeof i.taskId === 'number' && (
                      <button className="btn small ghost cal-del" title="Borrar la tarea" data-test="calendar-task-delete"
                        onClick={() => void hacer(() => window.contentOS.deleteCalendarTask(i.taskId as number))}><X size={14} /></button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <form className="cal-add" onSubmit={(e) => { e.preventDefault(); if (texto.trim()) void anadir() }}>
            <input data-test="calendar-task-text" placeholder="Apuntar algo para este día…" value={texto} maxLength={500} onChange={(e) => setTexto(e.target.value)} />
            <input data-test="calendar-task-time" type="time" value={hora} onChange={(e) => setHora(e.target.value)} aria-label="Hora (opcional)" />
            <button className="btn small primary" data-test="calendar-task-add" disabled={!texto.trim()}><Plus size={14} />Añadir</button>
          </form>
          <p className="faint small cal-hint">
            Lo automático (subidas, fin de semana, plazos) se calcula solo. Lo que me pidas que te apunte aparece con «de Claude».
          </p>
        </aside>
      </div>
    </>
  )
}
