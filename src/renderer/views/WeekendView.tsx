import { CalendarClock, Check, Copy, FolderOpen, Info, Play, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WeekendAccount, WeekendPlan, WeekendSlot } from '../../core/api'
import { formatDuration, PLATFORM_LABEL } from '../../core/format'
import { Empty, Thumb, useCopy } from '../components/Common'
import { PageHeader } from '../components/PageHeader'
import { RefreshButton } from '../components/RefreshButton'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
const nombreDia = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
const DONDE: Record<string, string> = {
  youtube: 'YouTube Studio → Subir → Visibilidad → Programar',
  tiktok: 'TikTok Studio en el navegador (tiktok.com/tiktokstudio) → Subir → Programar',
  instagram: 'App de Instagram → Configuración avanzada → Programar (o Meta Business Suite)',
}

/**
 * Se prepara el viernes: para cada canal, qué clip sale el sábado y el domingo y a qué hora, con todo lo
 * necesario para programarlo (título, descripción, archivo). «Marcar programado» lo apunta como publicado a esa
 * hora: «Hoy» ya no lo propone y, cuando YouTube lo publique, se enlaza solo.
 */
export function WeekendView(props: { refresh: number; onOpen: (clipId: string) => void; onChanged: () => void; onRefresh?: () => Promise<void> }) {
  const [plan, setPlan] = useState<WeekendPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiado, copiar] = useCopy()
  /** Clip elegido a mano para cada hueco (clave del hueco -> clipId). */
  const [elegidos, setElegidos] = useState<Record<string, string>>({})
  const [eligiendo, setEligiendo] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    void window.contentOS.getWeekendPlan().then((p) => vivo && setPlan(p))
    return () => {
      vivo = false
    }
  }, [props.refresh])

  if (!plan) return null

  const hacer = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await f()
      setPlan(await window.contentOS.getWeekendPlan())
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const claveHueco = (a: WeekendAccount, s: WeekendSlot) => `${a.account.id}-${s.at}`
  /** Lo que va en el hueco: el elegido a mano o el que propone la app. */
  const efectivo = (a: WeekendAccount, s: WeekendSlot) => {
    const id = elegidos[claveHueco(a, s)]
    const o = id ? a.options.find((x) => x.clip.clipId === id) : null
    if (o) return { clip: o.clip, caption: o.caption, daysLeft: o.endsAt ? Math.round((Date.parse(o.endsAt + 'T00:00:00Z') - Date.parse(s.day + 'T00:00:00Z')) / 86_400_000) + 1 : null, manual: true }
    return s.clip ? { clip: s.clip, caption: s.caption, daysLeft: s.daysLeft, manual: false } : null
  }
  /** Clips ya puestos en otros huecos de la misma plataforma (para no repetir uno). */
  const ocupados = (a: WeekendAccount, s: WeekendSlot) => new Set(plan.accounts.filter((x) => x.account.platform === a.account.platform)
    .flatMap((x) => x.slots.filter((y) => !(x === a && y === s)).map((y) => y.scheduled?.clipId ?? efectivo(x, y)?.clip.clipId)).filter(Boolean) as string[])
  const programar = (a: WeekendAccount, s: WeekendSlot) => {
    const e = efectivo(a, s)
    if (!e) return
    return hacer(async () => {
      await window.contentOS.savePublication({ clipId: e.clip.clipId, platform: a.account.platform, account: a.account.name, publishedAt: s.at })
      setElegidos((x) => {
        const y = { ...x }
        delete y[claveHueco(a, s)]
        return y
      })
    })
  }
  const deshacer = (s: WeekendSlot) => hacer(() => window.contentOS.deletePublication(s.scheduled!.clipId, s.scheduled!.publicationId))

  const huecos = plan.accounts.flatMap((a) => a.slots)
  const hechos = huecos.filter((s) => s.scheduled).length
  const pendientes = plan.accounts.flatMap((a) => a.slots.filter((s) => !s.scheduled && efectivo(a, s))).length
  const plataformas = [...new Set(plan.accounts.map((a) => a.account.platform))]

  const fila = (a: WeekendAccount, s: WeekendSlot, i: number) => {
    const k0 = `${a.account.id}-${s.day}-${i}`
    const ck = claveHueco(a, s)
    const e = s.scheduled ? null : efectivo(a, s)
    const usados = eligiendo === ck ? ocupados(a, s) : null
    const selector = eligiendo === ck && (
      <div className="wpick" data-test="weekend-pick">
        <select data-test="weekend-pick-select" autoFocus value={e?.clip.clipId ?? ''} onChange={(ev) => { setElegidos((x) => ({ ...x, [ck]: ev.target.value })); setEligiendo(null) }}>
          {!e && <option value="">Elige un clip…</option>}
          {a.options.filter((o) => (!o.endsAt || o.endsAt >= s.day) && (!usados!.has(o.clip.clipId) || o.clip.clipId === e?.clip.clipId)).map((o) => (
            <option key={o.clip.clipId} value={o.clip.clipId}>{(o.clip.title ?? o.clip.filename ?? o.clip.clipId).slice(0, 70)} · {o.clip.campaignName}</option>
          ))}
        </select>
        <button className="btn small ghost" onClick={() => setEligiendo(null)}>Cancelar</button>
      </div>
    )
    if (s.scheduled) {
      return (
        <div className="wslot done" key={k0} data-test="weekend-done" data-clip={s.scheduled.clipId}>
          <span className="wtime">{hora(s.scheduled.at)}</span>
          <Check size={15} />
          <button className="linklike wtitle" onClick={() => props.onOpen(s.scheduled!.clipId)} title={s.scheduled.title ?? ''}>{s.scheduled.title}</button>
          <span className="faint small">Programado</span>
          <button className="linklike faint small" data-test="weekend-undo" disabled={busy} onClick={() => void deshacer(s)}>Deshacer</button>
        </div>
      )
    }
    if (!e) {
      return (
        <div className="wslot empty" key={k0} data-test="weekend-empty">
          <span className="wtime">{hora(s.at)}</span>
          <span className="faint">{a.options.length ? 'Sin clip propuesto.' : `No queda ningún clip para ${PLATFORM_LABEL[a.account.platform]}.`}</span>
          {a.options.length > 0 && !selector && <button className="linklike small" data-test="weekend-pick-open" onClick={() => setEligiendo(ck)}>Elegir uno</button>}
          {selector}
        </div>
      )
    }
    const k = e.clip
    const titulo = k.title ?? k.filename ?? k.clipId
    const clave = k0
    return (
      <div className={`wslot ${e.manual ? 'manual' : ''}`} key={k0} data-test="weekend-slot" data-clip={k.clipId}>
        <span className="wtime">{hora(s.at)}</span>
        <button className="wthumb" onClick={() => props.onOpen(k.clipId)} title="Abrir el clip"><Thumb clip={k} /></button>
        <div className="wbody">
          <div className="wtitle" title={titulo}>{titulo}</div>
          <div className="tclip-m">
            <span>{k.campaignName}</span>
            {e.daysLeft != null && <span className={e.daysLeft <= 1 ? 'warn' : ''}>{e.daysLeft === 1 ? 'su último día' : `le quedan ${e.daysLeft} días`}</span>}
            {e.manual && <span className="wmanual">elegido por ti</span>}
            <span>{formatDuration(k.duration)}</span>
          </div>
          <div className="wbtns">
            <button className="btn small" data-test="weekend-copy-title" onClick={() => void copiar(clave + 't', titulo)}>
              {copiado === clave + 't' ? <Check size={13} /> : <Copy size={13} />}{copiado === clave + 't' ? 'Copiado' : 'Título'}
            </button>
            <button className="btn small" data-test="weekend-copy-desc" disabled={!e.caption} onClick={() => void copiar(clave + 'd', e.caption ?? '')}>
              {copiado === clave + 'd' ? <Check size={13} /> : <Copy size={13} />}{copiado === clave + 'd' ? 'Copiado' : 'Descripción'}
            </button>
            <button className="btn small ghost" title="Mostrar el archivo en la carpeta (para arrastrarlo a la web)" onClick={() => void window.contentOS.showClipInFolder(k.clipId)}><FolderOpen size={13} /></button>
            <button className="btn small ghost" title="Ver el vídeo" onClick={() => void window.contentOS.openClipFile(k.clipId)}><Play size={13} /></button>
            <button className="btn small ghost" data-test="weekend-pick-open" title="Poner otro clip en este hueco" onClick={() => setEligiendo(eligiendo === ck ? null : ck)}>Elegir otro</button>
            <span className="sp" />
            <button className="btn small primary" data-test="weekend-mark" disabled={busy} onClick={() => void programar(a, s)}><CalendarClock size={13} />Marcar programado</button>
          </div>
          {selector}
        </div>
      </div>
    )
  }

  return (
    <>
      <PageHeader title="Fin de semana" titleTest="weekend-title"
        meta={<><span>{plan.days.map(nombreDia).join(' y ')}</span><span data-test="weekend-count"> · {hechos} programados · {pendientes} por programar</span></>}>
        {props.onRefresh && <RefreshButton onRefresh={props.onRefresh} />}
      </PageHeader>
      {error && <div className="banner bad" data-test="weekend-error"><TriangleAlert size={15} /><span>{error}</span></div>}

      {plan.accounts.length === 0 ? (
        <Empty title="No hay canales en el plan" test="weekend-noaccounts">
          <p>Añade tus canales en «Hoy» → «Canales…» y aquí aparecerá qué programar cada fin de semana.</p>
        </Empty>
      ) : (
        <>
          <div className="banner wguide" data-test="weekend-guide">
            <Info size={15} />
            <span>
              Hazlo el viernes: sube cada clip con su título y su descripción y prográmalo a la hora indicada. Después pulsa «Marcar programado».
              {plataformas.map((p) => <span key={p} className="wwhere"><strong>{PLATFORM_LABEL[p]}:</strong> {DONDE[p]}</span>)}
              <span className="wwhere">El lunes, envía a Vyro («Add posts») los enlaces de lo que se publicó.</span>
            </span>
          </div>
          <div className="tgrid wgrid">
            {plan.accounts.map((a) => (
              <section className="tcard" key={a.account.id} data-test="weekend-account" data-account={a.account.name}>
                <header className="tcard-h">
                  <span className={`tavatar ph ${a.account.platform}`} aria-hidden="true">{(a.account.name.replace(/^@/, '')[0] ?? '?').toUpperCase()}</span>
                  <div className="tcard-n">
                    <h2>{a.account.name}</h2>
                    <span className="tcard-p">{PLATFORM_LABEL[a.account.platform]} · {a.account.dailyLimit} al día</span>
                  </div>
                  <span className={`tpill ${a.slots.length && a.slots.every((s) => s.scheduled) ? 'ok' : ''}`}>{a.slots.filter((s) => s.scheduled).length} de {a.slots.length}</span>
                </header>
                {plan.days.map((d) => {
                  const del = a.slots.filter((s) => s.day === d)
                  return (
                    <div className="wday" key={d}>
                      <div className="wday-h">{nombreDia(d)}</div>
                      {del.length ? del.map((s, i) => fila(a, s, i)) : <div className="faint small">En reposo: ese día no se sube nada.</div>}
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
        </>
      )}
    </>
  )
}
