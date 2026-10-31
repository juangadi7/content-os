import { Check, Copy, ExternalLink, EyeOff, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { VyroPending } from '../../core/api'
import { PLATFORM_LABEL, type Platform } from '../../core/format'
import { useCopy } from './Common'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const cuando = (iso: string) => {
  const d = new Date(iso)
  const hoy = new Date()
  const mismoDia = d.toDateString() === hoy.toDateString()
  const hora = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  return mismoDia ? `hoy, ${hora}` : `${d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })}, ${hora}`
}
const plazo = (fin: string | null) => {
  if (!fin) return null
  const dias = Math.round((Date.parse(fin + 'T00:00:00Z') - Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86_400_000)
  return dias <= 0 ? 'hoy es el último día' : dias === 1 ? 'mañana es el último día' : `hasta el ${new Date(fin + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}`
}

/**
 * «Enviar a Vyro»: lo ya publicado (también lo programado, en cuanto llega su hora) que falta mandar a Vyro con
 * «Add posts». Se queda aquí hasta que se marca como enviado.
 */
export function VyroToSend(props: { refresh: number; onOpen: (clipId: string) => void; onChanged: () => void }) {
  const [lista, setLista] = useState<VyroPending[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiado, copiar] = useCopy()

  useEffect(() => {
    let vivo = true
    void window.contentOS.getVyroPending().then((l) => vivo && setLista(l)).catch(() => undefined)
    return () => {
      vivo = false
    }
  }, [props.refresh])

  if (!lista || lista.length === 0) return null

  const ignorar = async (id: number) => {
    setBusy(true)
    setError(null)
    try {
      await window.contentOS.setControlIgnored(`p${id}`, true)
      setLista(await window.contentOS.getVyroPending())
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const enviado = async (id: number) => {
    setBusy(true)
    setError(null)
    try {
      setLista(await window.contentOS.setVyroSent(id, true))
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="vsend" data-test="vyro-send">
      <header className="vsend-h">
        <Send size={16} />
        <h2>Enviar a Vyro <span>{lista.length}</span></h2>
        <span className="faint small">Ya son públicos y no están en Vyro. Pega cada enlace en Vyro («Add posts»); si tu cuenta de Vyro está conectada, se quitan solos de aquí.</span>
        <span className="sp" />
        <a className="btn small" href="https://vyro.com" target="_blank" rel="noreferrer"><ExternalLink size={13} />Abrir Vyro</a>
      </header>
      {error && <p className="bad small">{error}</p>}
      <ul>
        {lista.map((p) => {
          const fin = plazo(p.endsAt)
          return (
            <li key={p.publicationId} data-test="vyro-send-item" data-publication={p.publicationId}>
              <span className="vsend-t">
                <span className={`vsend-pf ${p.platform}`}>{PLATFORM_LABEL[p.platform as Platform] ?? p.platform}{p.account ? ` · ${p.account}` : ''}</span>
                <button className="linklike" onClick={() => props.onOpen(p.clipId)} title={p.title}>{p.title}</button>
                {p.verified && <span className="vsend-no" data-test="vyro-send-verified" title="Comprobado con tus envíos de Vyro">no está en Vyro</span>}
              </span>
              <span className="vsend-m">
                salió {cuando(p.publishedAt)} · {p.campaignName}
                {fin && <span className={fin.includes('último') ? 'warn' : ''}> · {fin}</span>}
                {p.url && <> · <a className="vsend-url" href={p.url} target="_blank" rel="noreferrer" data-test="vyro-send-url">{p.url.replace(/^https?:\/\/(www\.)?/, '')}</a></>}
              </span>
              <span className="vsend-b">
                {p.url ? (
                  <>
                    <button className="btn small" data-test="vyro-send-copy" onClick={() => void copiar(String(p.publicationId), p.url!)}>
                      {copiado === String(p.publicationId) ? <Check size={13} /> : <Copy size={13} />}{copiado === String(p.publicationId) ? 'Copiado' : 'Copiar enlace'}
                    </button>
                    <a className="btn small ghost" href={p.url} target="_blank" rel="noreferrer" title="Abrir el vídeo"><ExternalLink size={13} /></a>
                  </>
                ) : (
                  <span className="faint small" title="Ábrelo en la plataforma y copia su enlace; si lo pegas en el clip («Editar»), la app lo recordará">sin enlace guardado</span>
                )}
                <button className="btn small ghost" data-test="vyro-send-ignore" disabled={busy} title="No lo vas a enviar a Vyro: fuera de esta lista (y de «Control de vídeos»)" onClick={() => void ignorar(p.publicationId)}><EyeOff size={13} />Ignorar</button>
                <button className="btn small primary" data-test="vyro-send-done" disabled={busy} onClick={() => void enviado(p.publicationId)}><Check size={13} />Enviado</button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
