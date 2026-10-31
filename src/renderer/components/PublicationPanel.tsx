import { useState } from 'react'
import type { ClipDetail, PublicationView } from '../../core/api'
import { formatCount, PLATFORM_LABEL, PLATFORMS, relativeTime, type Platform } from '../../core/format'
import { formatMoney } from '../../core/money'
import { statusKind } from '../../core/vyro-submissions'

const VYRO_TEXTO = { pending: 'en revisión', approved: 'aprobado', rejected: 'rechazado' } as const
const VYRO_TONO = { pending: 'warn', approved: 'ok', rejected: 'bad' } as const

const fechaHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '')

/** Valor para <input type="datetime-local"> en hora local. */
function paraInput(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

interface Editing {
  platform: Platform
  publication: PublicationView | null
}

export function PublicationPanel({ clip, onChange }: { clip: ClipDetail; onChange: (c: ClipDetail) => void }) {
  const [editing, setEditing] = useState<Editing | null>(null)
  return (
    <div className="block" data-test="publications">
      <div className="lbl"><span>Publicación</span></div>
      <div className="pubs">
        {PLATFORMS.map((pf) => {
          const pubs = clip.publications.filter((p) => p.platform === pf)
          return (
            <div className="pub" key={pf} data-test={`pub-${pf}`}>
              <span className="pf">{PLATFORM_LABEL[pf]}</span>
              <div>
                {pubs.length === 0 && <span className="faint">No publicado</span>}
                {pubs.length === 0 && pf === 'youtube' && <div className="faint small" data-test="pub-auto-hint">Se marca solo, con su canal, cuando lo subes con este título a un canal de «Canales».</div>}
                {pubs.map((p) => (
                  <div key={p.id}>
                    <span className="ok dot">Publicado</span>
                    <span className="muted">
                      {' · '}{fechaHora(p.publishedAt)}{p.account ? ` · ${p.account}` : ''}
                    </span>
                    {p.url && <> · <a href={p.url} target="_blank" rel="noreferrer">Abrir</a></>}
                    {p.renderChangedSince && <span className="warn" title="El clip se ha vuelto a generar después de publicarlo"> · render anterior</span>}
                    {' '}
                    <button className="btn small ghost" data-test={`edit-${pf}`} onClick={() => setEditing({ platform: pf, publication: p })}>Editar</button>
                    {(p.vyro || p.vyroSentAt) && (
                      <div className="small" data-test={`vyro-${pf}`}>
                        <span className="faint">Vyro: </span>
                        {p.vyro ? (
                          <>
                            <span className={VYRO_TONO[statusKind(p.vyro.status)]}>{VYRO_TEXTO[statusKind(p.vyro.status)]}</span>
                            {p.vyro.views != null && <span className="muted"> · {formatCount(p.vyro.views)} visitas que cuenta Vyro</span>}
                            {p.vyro.earned ? <span className="ok"> · {formatMoney(p.vyro.earned)}</span> : null}
                            {p.vyro.error && <span className="bad"> · {p.vyro.error}</span>}
                          </>
                        ) : <span className="muted">enviado</span>}
                      </div>
                    )}
                    {p.latest && (
                      <div className="muted" data-test={`metrics-${pf}`}>
                        {formatCount(p.latest.views)} visitas · {formatCount(p.latest.likes)} likes · {formatCount(p.latest.comments)} comentarios
                        <span className="faint"> · medido {relativeTime(p.latest.measuredAt)}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="btns">
                <button className="btn small" data-test={`publish-${pf}`} onClick={() => setEditing({ platform: pf, publication: null })}>
                  {pubs.length ? 'Otra cuenta' : 'Marcar publicado'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {editing && (
        <PublishModal
          clip={clip}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null)
            onChange(c)
          }}
        />
      )}
    </div>
  )
}

function PublishModal({ clip, editing, onClose, onSaved }: { clip: ClipDetail; editing: Editing; onClose: () => void; onSaved: (c: ClipDetail) => void }) {
  const p = editing.publication
  const [account, setAccount] = useState(p?.account ?? '')
  const [url, setUrl] = useState(p?.url ?? '')
  const [fecha, setFecha] = useState(paraInput(p?.publishedAt ?? null))
  const [title, setTitle] = useState(p ? p.titleUsed ?? '' : clip.title ?? '')
  const [caption, setCaption] = useState(p ? p.captionUsed ?? '' : clip.caption ?? '')
  const [notes, setNotes] = useState(p?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmar, setConfirmar] = useState(false)
  const cuentas = clip.knownAccounts[editing.platform] ?? []

  const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

  const guardar = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(
        await window.contentOS.savePublication({
          id: p?.id,
          clipId: clip.clipId,
          platform: editing.platform,
          account,
          url,
          publishedAt: fecha ? new Date(fecha).toISOString() : null,
          titleUsed: title,
          captionUsed: caption,
          notes
        })
      )
    } catch (e) {
      setError(mensaje(e))
      setBusy(false)
    }
  }

  const quitar = async () => {
    if (!p) return
    setBusy(true)
    try {
      onSaved(await window.contentOS.deletePublication(clip.clipId, p.id))
    } catch (e) {
      setError(mensaje(e))
      setBusy(false)
    }
  }

  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-test="publish-modal">
        <h2>{p ? 'Editar publicación' : 'Marcar publicado'} · {PLATFORM_LABEL[editing.platform]}</h2>
        <div className="two">
          <div className="field">
            <label>Cuenta (opcional)</label>
            <input data-test="f-account" value={account} onChange={(e) => setAccount(e.target.value)} list="cuentas" placeholder="@canal" autoFocus />
            <datalist id="cuentas">{cuentas.map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <div className="field">
            <label>Fecha</label>
            <input data-test="f-date" type="datetime-local" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>URL del post (opcional)</label>
          <input data-test="f-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        <div className="field">
          <label>Título usado</label>
          <input data-test="f-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label>Descripción usada</label>
          <textarea data-test="f-caption" rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} />
        </div>
        <div className="field">
          <label>Notas</label>
          <textarea data-test="f-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && <p className="bad" data-test="publish-error">{error}</p>}
        <div className="foot">
          {p && !confirmar && <button className="btn ghost danger" disabled={busy} onClick={() => setConfirmar(true)}>Quitar publicación</button>}
          {p && confirmar && (
            <>
              <span className="muted">¿Seguro?</span>
              <button className="btn danger" data-test="confirm-remove" disabled={busy} onClick={quitar}>Sí, quitar</button>
            </>
          )}
          <span className="sp" />
          <button className="btn ghost" data-test="cancel-publication" disabled={busy} onClick={onClose}>Cancelar</button>
          <button className="btn primary" data-test="save-publication" disabled={busy} onClick={guardar}>Guardar</button>
        </div>
      </div>
    </div>
  )
}
