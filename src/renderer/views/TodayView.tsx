import { Check, Clock, Info, Moon, Play, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { avatarUrl, extraUrl, type ExtraPlatform, type ExtrasView, type ExtraVideo, type PlanAccount, type PlanClip, type PlanView } from '../../core/api'
import { formatDuration, PLATFORM_LABEL, scoreLabel } from '../../core/format'
import { AccountsModal } from '../components/AccountsModal'
import { Empty, Thumb } from '../components/Common'
import { PageHeader } from '../components/PageHeader'
import { VyroToSend } from '../components/VyroToSend'
import { RefreshButton } from '../components/RefreshButton'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const hm = (h: number, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
/** "hoy, 21:00" · "mañana, 12:00–15:00" · "jueves 15, 12:00–15:00" */
function cuando(iso: string, franja: [number, number] | null): string {
  const t = new Date(iso), hoy = new Date()
  const dias = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() - new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime()) / 86_400_000)
  const dia = dias === 0 ? 'hoy' : dias === 1 ? 'mañana' : t.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric' })
  // si cae justo al abrir la franja, se dice la franja entera; si no, la hora a partir de la cual se puede
  if (franja && t.getHours() === franja[0] && t.getMinutes() === 0) return `${dia}, ${hm(franja[0])}–${hm(franja[1])}`
  return `${dia}, desde las ${hm(t.getHours(), t.getMinutes())}`
}
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

/** Imagen del canal; si no se tiene (canal sin seguir, sin conexión, TikTok o Instagram), su inicial con el color de la plataforma. */
function Avatar({ a }: { a: PlanAccount }) {
  const [rota, setRota] = useState(false)
  const inicial = (a.account.name.replace(/^@/, '')[0] ?? '?').toUpperCase()
  if (a.channelId && !rota) return <img className="tavatar" data-test="today-avatar" data-kind="image" src={avatarUrl(a.channelId)} alt="" onError={() => setRota(true)} />
  return <span className={`tavatar ph ${a.account.platform}`} data-test="today-avatar" data-kind="initial" aria-hidden="true">{inicial}</span>
}

/**
 * Canal con hueco pero sin clip de campaña: dice por qué (si los clips que quedan van a otros canales) y propone
 * un vídeo de «Fuera de campaña» que aún no esté subido a esa plataforma.
 */
function SinClip({ a, extra, busy, onCanales, onSubido }: {
  a: PlanAccount; extra: { video: ExtraVideo; grupo: string } | null; busy: boolean; onCanales: () => void; onSubido: (id: string) => void
}) {
  const pf = PLATFORM_LABEL[a.account.platform]
  const otros = a.elsewhere.reduce((s, e) => s + e.clips, 0)
  return (
    <>
      {otros > 0 ? (
        <div className="tstate warn tlong" data-test="today-elsewhere">
          <Info size={15} />
          <span>
            Quedan <strong>{otros} {otros === 1 ? 'clip' : 'clips'}</strong> para {pf}, pero {otros === 1 ? 'es' : 'son'} de campañas asignadas a otros canales:{' '}
            {a.elsewhere.map((e, i) => (
              <span key={e.campaignId}>{i > 0 && '; '}{e.campaignName} ({e.clips}) → {e.owners.length ? e.owners.join(', ') : 'canales sin campañas asignadas'}</span>
            ))}.{' '}
            <button className="linklike tlink" data-test="today-elsewhere-change" onClick={onCanales}>Cambiar asignaciones</button>
          </span>
        </div>
      ) : (
        <div className="tstate">No quedan clips de campañas para {pf}.</div>
      )}
      {extra && (
        <div className="tclip textra" data-test="today-extra" data-extra={extra.video.id}>
          <div className="tclip-main">
            <video className="thumb" src={`${extraUrl(extra.video.id)}#t=1.5`} preload="metadata" muted />
            <span className="tclip-txt">
              <span className="tclip-t">{extra.video.title}</span>
              <span className="tclip-m"><span>Fuera de campaña</span><span>{extra.grupo}</span><span>no cobra por visitas</span></span>
            </span>
          </div>
          <div className="tclip-b">
            <button className="btn" data-test="today-extra-view" onClick={() => void window.contentOS.openExtra(extra.video.id)}><Play size={14} />Ver vídeo</button>
            <button className="btn primary" data-test="today-extra-mark" disabled={busy} onClick={() => onSubido(extra.video.id)}><Check size={15} />Marcar subido</button>
          </div>
        </div>
      )}
    </>
  )
}

/** Plan del día: una tarjeta por canal, con lo que toca subir ahora y los dos botones para hacerlo. */
export function TodayView(props: { refresh: number; onOpen: (clipId: string) => void; onChanged: () => void; onRefresh?: () => Promise<void> }) {
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [canales, setCanales] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [extras, setExtras] = useState<ExtrasView | null>(null)

  useEffect(() => {
    let vivo = true
    void window.contentOS.getPlan().then((p) => vivo && setPlan(p))
    void window.contentOS.listExtras().then((x) => vivo && setExtras(x)).catch(() => undefined)
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
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const subido = (a: PlanAccount, clipId: string) =>
    hacer(() => window.contentOS.savePublication({ clipId, platform: a.account.platform, account: a.account.name }))
  const deshacer = (clipId: string, publicationId: number) => hacer(() => window.contentOS.deletePublication(clipId, publicationId))
  /** El primer vídeo de «Fuera de campaña» (el grupo más reciente primero) que aún no está subido a esa plataforma. */
  const extraPara = (pf: ExtraPlatform): { video: ExtraVideo; grupo: string } | null => {
    for (const g of extras?.groups ?? []) {
      const v = g.videos.find((x) => !x.uploaded[pf])
      if (v) return { video: v, grupo: g.name }
    }
    return null
  }

  const fecha = new Date(plan.date + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
  const conCanales = plan.platforms.filter((p) => p.capacity > 0)
  const ahora = new Date().getHours()

  /** Un clip propuesto: portada, título, una línea de datos y los botones. */
  const clipFila = (a: PlanAccount, { clip, daysLeft }: PlanClip, siguiente: boolean) => (
    <div className={`tclip ${siguiente ? 'next' : ''}`} key={clip.clipId} data-test={siguiente ? 'today-upnext' : 'today-row'} data-clip={clip.clipId}>
      <button className="tclip-main" onClick={() => props.onOpen(clip.clipId)} title="Abrir el clip">
        <Thumb clip={clip} />
        <span className="tclip-txt">
          <span className="tclip-t">{clip.title ?? clip.filename ?? clip.clipId}</span>
          <span className="tclip-m">
            <span>{clip.campaignName}</span>
            {daysLeft != null && <span className={daysLeft <= 3 ? 'warn' : ''}>{daysLeft === 1 ? 'último día' : `quedan ${daysLeft} días`}</span>}
            <span>{scoreLabel(clip.score)}</span>
            <span>{formatDuration(clip.duration)}</span>
          </span>
        </span>
      </button>
      <div className="tclip-b">
        <button className="btn" data-test="today-view" onClick={() => props.onOpen(clip.clipId)}><Play size={14} />Ver vídeo</button>
        {!siguiente && <button className="btn primary" data-test="today-mark" disabled={busy} onClick={() => void subido(a, clip.clipId)}><Check size={15} />Marcar subido</button>}
      </div>
    </div>
  )

  return (
    <>
      <PageHeader title="Hoy" titleTest="today-title"
        meta={<><span>{fecha}</span>{conCanales.map((p) => <span key={p.platform} data-test="today-summary" className="tsum"><span className="sep">·</span>{PLATFORM_LABEL[p.platform]}: {p.pending} por subir</span>)}</>}>
        {props.onRefresh && <RefreshButton onRefresh={props.onRefresh} />}
        <button className="btn" data-test="accounts-open" onClick={() => setCanales(true)}>Canales…</button>
      </PageHeader>

      <VyroToSend refresh={props.refresh} onOpen={props.onOpen} onChanged={props.onChanged} />

      {plan.accounts.length === 0 ? (
        <Empty title={plan.allAccounts.length ? 'Todos tus canales están en pausa' : 'Añade tus canales'} test="today-empty">
          <p>Dime en qué canales publicas y cuántos clips al día quieres subir a cada uno. Te diré qué subir hoy y dónde.</p>
          <button className="btn primary" onClick={() => setCanales(true)}>Añadir canales</button>
        </Empty>
      ) : (
        <>
          {plan.warnings.map((w) => (
            <div className="banner" key={w.campaignId + w.platform} data-test="today-warning">
              <TriangleAlert size={15} />
              <span><strong>{w.campaignName}</strong>: {w.pending} clips y {w.daysLeft} {w.daysLeft === 1 ? 'día' : 'días'}. {w.wontFit === 1 ? 'Se queda fuera 1' : `Se quedan fuera ${w.wontFit}`} en {PLATFORM_LABEL[w.platform]} a este ritmo.</span>
            </div>
          ))}
          {error && <div className="banner bad" data-test="today-error"><TriangleAlert size={15} /><span>{error}</span></div>}

          <div className="tgrid">
            {plan.accounts.map((a) => {
              const lleno = a.doneToday.length >= a.account.dailyLimit
              const fueraDeFranja = a.suggestions.length > 0 && a.window != null && (ahora < a.window[0] || ahora >= a.window[1])
              return (
                <section className={`tcard ${a.suggestions.length ? 'todo' : ''}`} key={a.account.id} data-test="today-account" data-account={a.account.name} data-platform={a.account.platform}>
                  <header className="tcard-h">
                    <Avatar a={a} key={props.refresh} />
                    <div className="tcard-n">
                      <h2>{a.account.name}</h2>
                      <span className="tcard-p">{PLATFORM_LABEL[a.account.platform]}</span>
                    </div>
                    <span className={`tpill ${lleno ? 'ok' : ''}`} data-test="today-progress" title="Subidos hoy / tope diario">{a.doneToday.length} de {a.account.dailyLimit}{lleno && <Check size={13} />}</span>
                  </header>

                  {a.doneToday.map((d) => (
                    <div className="tdone" key={d.publicationId} data-test="today-done">
                      <Check size={14} />
                      <button className="linklike" onClick={() => props.onOpen(d.clipId)} title={d.title ?? ''}>{d.title}</button>
                      <span className="faint">{hora(d.publishedAt)}</span>
                      {!d.locked && <button className="linklike faint" data-test="today-undo" disabled={busy} onClick={() => deshacer(d.clipId, d.publicationId)}>Deshacer</button>}
                    </div>
                  ))}

                  {a.hold ? (
                    <div className="tstate" data-test="today-hold"><Moon size={15} />Canal en reposo: hoy no se sube nada.</div>
                  ) : a.suggestions.length > 0 ? (
                    <>
                      {fueraDeFranja && <div className="tstate warn" data-test="today-window"><Clock size={15} />Mejor entre las {hm(a.window![0])} y las {hm(a.window![1])}</div>}
                      {a.suggestions.map((s) => clipFila(a, s, false))}
                    </>
                  ) : a.nextAt ? (
                    <div data-test="today-next">
                      <div className="tstate"><Clock size={15} />Siguiente subida: <strong>{cuando(a.nextAt, a.window)}</strong></div>
                      {a.upNext && clipFila(a, a.upNext, true)}
                    </div>
                  ) : lleno ? (
                    <div className="tstate ok"><Check size={15} />Hecho por hoy.</div>
                  ) : (
                    <SinClip a={a} extra={extraPara(a.account.platform)} busy={busy}
                      onCanales={() => setCanales(true)}
                      onSubido={(id) => hacer(async () => { await window.contentOS.setExtraUploaded(id, a.account.platform, true); setExtras(await window.contentOS.listExtras()) })} />
                  )}

                  {a.note && (
                    <details className="tnote" data-test="today-note">
                      <summary><Info size={13} />Nota del canal</summary>
                      <p>{a.note}</p>
                    </details>
                  )}
                </section>
              )
            })}
          </div>

          {plan.skipped.length > 0 && (
            <details className="tskip" data-test="today-skipped">
              <summary>No se propone en {plan.skipped.length} {plan.skipped.length === 1 ? 'caso' : 'casos'}, y por qué</summary>
              <ul className="list-plain">
                {plan.skipped.map((s) => (
                  <li key={s.platform + s.campaignId + s.reason}>
                    <strong>{s.campaignName}</strong> en {PLATFORM_LABEL[s.platform]}: {s.whole ? `ningún clip (${s.clips})` : `${s.clips} ${s.clips === 1 ? 'clip' : 'clips'}`}. {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {plan.adviceErrors.map((e) => <p key={e} className="bad small">{e}</p>)}
          {plan.adviceUpdatedAt && <p className="faint small tfoot">Recomendaciones de los canales actualizadas el {plan.adviceUpdatedAt}.</p>}
        </>
      )}

      {canales && (
        <AccountsModal accounts={plan.allAccounts} onPlan={(p) => { setPlan(p); props.onChanged() }} onClose={() => setCanales(false)} />
      )}
    </>
  )
}
