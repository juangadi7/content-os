import { Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { VyroCampaignView, VyroView as VyroData } from '../../core/api'
import { formatBytes, formatCount, relativeTime } from '../../core/format'
import { OrderModal } from '../components/OrderModal'
import { Empty } from '../components/Common'
import { VyroAccount } from '../components/VyroAccount'
import { VyroToSend } from '../components/VyroToSend'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const dolares = (n: number | null, decimales = 0) => (n == null ? '—' : `${n.toLocaleString('es-ES', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })} $`)
const dia = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : '—')
const PLATAFORMA: Record<string, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', x: 'X' }

function estado(c: VyroCampaignView): [string, string] {
  if (!c.present) return ['Ya no aparece en Vyro', 'faint']
  if (c.locked) return ['Bloqueada', 'faint']
  if (c.status && c.status !== 'active') return ['Terminada', 'faint']
  if (c.endsAt && c.daysLeft == null) return ['Plazo terminado', 'faint']
  if (c.daysLeft != null) return [c.daysLeft === 1 ? 'Último día' : `Quedan ${c.daysLeft} días`, c.daysLeft <= 3 ? 'warn' : 'ok']
  return ['Abierta', 'ok']
}

/** Campañas publicadas en Vyro (lista pública) y cuáles tienes hechas. Solo lectura. */
export function VyroView(props: { refresh: number; onOpenCampaign: (campaignId: string) => void; onOpenClip?: (clipId: string) => void; onSeen: () => void; onChanged: () => void }) {
  const [data, setData] = useState<VyroData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pedido, setPedido] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    void window.contentOS.getVyro().then((v) => {
      if (!vivo) return
      // las nuevas siguen marcadas mientras miras esta pantalla; al volver a entrar ya no
      setData((antes) => (antes ? { ...v, campaigns: v.campaigns.map((c) => ({ ...c, isNew: c.isNew || !!antes.campaigns.find((a) => a.vyroId === c.vyroId)?.isNew })) } : v))
      if (v.newCount > 0) void window.contentOS.vyroAcknowledge().then(props.onSeen)
    })
    return () => {
      vivo = false
    }
  }, [props.refresh])

  if (!data) return null

  const hacer = async (f: () => Promise<VyroData>) => {
    setBusy(true)
    setError(null)
    try {
      const v = await f()
      setData((antes) => ({ ...v, campaigns: v.campaigns.map((c) => ({ ...c, isNew: c.isNew || !!antes?.campaigns.find((a) => a.vyroId === c.vyroId)?.isNew })) }))
      if (v.newCount > 0) void window.contentOS.vyroAcknowledge()
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const abiertas = data.campaigns.filter((c) => c.open)
  const cerradas = data.campaigns.filter((c) => !c.open)

  const tarjeta = (c: VyroCampaignView) => {
    const [texto, clase] = estado(c)
    return (
      <div className={`card vy ${c.open ? '' : 'closed'}`} key={c.vyroId} data-test="vyro-card" data-slug={c.slug} data-new={c.isNew ? 1 : 0}>
        <div className="meta" style={{ marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{c.brand}</span>
          {c.isNew && <span className="tag new" data-test="vyro-new">NUEVA</span>}
          <span className="sp" style={{ flex: 1 }} />
          <span className={clase}>{texto}</span>
        </div>
        <h3 title={c.name}>{c.name}</h3>
        <dl>
          <dt>Pago</dt><dd>{dolares(c.payRate, 2)} por 1.000 visitas</dd>
          <dt>Presupuesto libre</dt><dd>{dolares(c.budgetRemaining)}{c.budgetTotal != null && <span className="faint"> de {dolares(c.budgetTotal)}</span>}</dd>
          <dt>Termina</dt><dd>{dia(c.endsAt)}</dd>
          <dt>Mínimo para cobrar</dt><dd>{c.minViews != null ? `${formatCount(c.minViews)} visitas` : '—'}</dd>
          <dt>Duración mínima</dt><dd>{c.minLength != null ? `${c.minLength} s` : '—'}</dd>
          <dt>Hashtags</dt><dd className="ell" title={[...c.hashtags, ...c.disclosure].join(' ')}>{[...c.hashtags, ...c.disclosure].join(' ') || '—'}</dd>
          <dt>Plataformas</dt><dd>{c.platforms.map((p) => PLATAFORMA[p] ?? p).join(', ') || '—'}</dd>
        </dl>
        <div className="field" style={{ marginBottom: 10 }}>
          <label>Tu campaña</label>
          <select data-test="vyro-link" value={c.campaignId ?? ''} disabled={busy} onChange={(e) => void hacer(() => window.contentOS.vyroLink(c.vyroId, e.target.value || null))}>
            <option value="">— Sin hacer —</option>
            {data.localOptions.map((o) => <option key={o.campaignId} value={o.campaignId}>{o.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <a className="ext" href={c.url} target="_blank" rel="noreferrer">Abrir en Vyro</a>
          {c.materialLinks[0] && <a className="ext" href={c.materialLinks[0]} target="_blank" rel="noreferrer">Material</a>}
          <span style={{ flex: 1 }} />
          {c.campaignId
            ? <button className="linkbtn" onClick={() => props.onOpenCampaign(c.campaignId!)}>Ver mis clips →</button>
            : c.order
              ? (
                <button className="btn small" data-test="vyro-order" onClick={() => setPedido(c.vyroId)}>
                  {c.order.status === 'ready' ? 'Pedido listo' : c.order.files.length ? `Pedido · ${c.order.files.length} ${c.order.files.length === 1 ? 'archivo' : 'archivos'} · ${formatBytes(c.order.totalBytes)}` : 'Pedido · esperando material'}
                </button>
              )
              : c.open && (
                <>
                  <span className="warn small" data-test="vyro-todo">Sin hacer</span>
                  <button className="btn small primary" data-test="vyro-make" onClick={() => setPedido(c.vyroId)}>Hacer esta campaña</button>
                </>
              )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="head">
        <h1 data-test="vyro-title">Vyro</h1>
        <span className="muted" data-test="vyro-checked">{data.lastCheckAt ? `Comprobado ${relativeTime(data.lastCheckAt)}` : 'Sin comprobar todavía'}</span>
        <span className="sp" />
        <button className="btn" data-test="vyro-check" disabled={busy} onClick={() => void hacer(() => window.contentOS.vyroCheck())}>{busy ? 'Comprobando…' : 'Comprobar ahora'}</button>
      </div>
      <div className="banner vyro-about" data-test="vyro-about">
        <Info size={15} />
        <span>
          <strong>Qué es Vyro.</strong> Vyro es una plataforma de <em>clipping</em>: marcas, podcasts y creadores publican campañas y pagan a los
          clippers por cada 1.000 visitas que consiguen sus clips en TikTok, YouTube Shorts o Instagram Reels, a partir de un mínimo de visitas y
          hasta un tope por vídeo. Aquí CONTENT OS lee la lista pública de campañas, avisa de las nuevas, las enlaza con tus campañas locales y te
          dice qué vídeos publicados faltan por enviar para cobrar.
        </span>
      </div>
      <VyroAccount refresh={props.refresh} onChanged={props.onChanged} />
      {props.onOpenClip && <VyroToSend refresh={props.refresh} onOpen={props.onOpenClip} onChanged={props.onChanged} />}
      {(error || data.lastError) && (
        <div className="notice" data-test="vyro-error" style={{ borderLeftColor: 'var(--bad)' }}>
          <span><strong>No se pudo leer Vyro.</strong> {error ?? data.lastError} Lo de abajo es lo último que se leyó bien.</span>
        </div>
      )}
      {data.campaigns.length === 0 ? (
        <Empty title="Todavía no se ha leído la lista de Vyro" test="vyro-empty">
          <p>La aplicación la consulta sola cada 30 minutos mientras está abierta. No necesita tu cuenta: lee la lista pública.</p>
        </Empty>
      ) : (
        <>
          <div className="sec">
            <h2>Abiertas · {abiertas.length}</h2>
            {abiertas.length ? <div className="cards">{abiertas.map(tarjeta)}</div> : <p className="muted">Ahora mismo no hay ninguna abierta.</p>}
          </div>
          {cerradas.length > 0 && (
            <div className="sec">
              <h2>Bloqueadas o terminadas · {cerradas.length}</h2>
              <div className="cards">{cerradas.map(tarjeta)}</div>
            </div>
          )}
          {pedido && data.campaigns.find((c) => c.vyroId === pedido) && (
            <OrderModal campaign={data.campaigns.find((c) => c.vyroId === pedido)!} onData={(v) => setData(v)} onClose={() => setPedido(null)} />
          )}
          <p className="faint small">
            Se lee la lista pública de vyro.com cada 30 minutos, sin usar tu cuenta. Las reglas completas (texto obligatorio, límites por vídeo) solo están en Vyro al unirte: revísalas siempre allí.
            Cuando Vyro bloquea una campaña, la tuya se marca como cerrada; si no tenía fecha de fin, se le pone la de Vyro.
          </p>
        </>
      )}
    </>
  )
}
