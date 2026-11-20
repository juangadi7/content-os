import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OwnChannel, OwnChannelStats, OwnPlatform } from '../../core/api'
import { RED_NOMBRE } from '../components/OwnStatsForm'
import { PageHeader } from '../components/PageHeader'
import { Fuente } from './OwnStatsView'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const REDES: OwnPlatform[] = ['tiktok', 'youtube', 'instagram']

/** Cuentas de un canal propio en cada red: qué @ usa y si sus cifras llegan solas (API) o hay que apuntarlas. */
export function OwnAccountsView(props: { channel: OwnChannel; refresh: number; youtubeConnected: boolean; onYouTube: () => void }) {
  const [d, setD] = useState<OwnChannelStats | null>(null)
  const [nuevo, setNuevo] = useState<Record<OwnPlatform, string>>({ tiktok: '', youtube: '', instagram: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let vivo = true
    void window.contentOS.getOwnStats(props.channel).then((x) => vivo && setD(x))
    return () => { vivo = false }
  }, [props.channel, props.refresh])
  if (!d) return null

  const añadir = async (p: OwnPlatform) => {
    setBusy(true)
    setError(null)
    try {
      setD(await window.contentOS.addOwnAccount(props.channel, p, nuevo[p]))
      setNuevo({ ...nuevo, [p]: '' })
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }
  const quitar = async (id: number) => {
    setBusy(true)
    try {
      setD(await window.contentOS.removeOwnAccount(props.channel, id))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title={`${d.name} · cuentas`} titleTest="own-accounts-title" meta={<span>Dónde se sube este canal en cada red</span>} />
      {error && <div className="banner bad" data-test="own-accounts-error"><span>{error}</span></div>}
      <div className="acols">
        {REDES.map((p) => {
          const cuentas = d.accounts.filter((a) => a.platform === p)
          return (
            <section key={p} className={`opanel glass acol ${p}`} data-test={`own-accounts-${p}`}>
              <h3><span className={`rdot ${p}`} />{RED_NOMBRE[p]}</h3>
              {cuentas.length === 0 && <p className="faint small">Sin cuenta apuntada.</p>}
              {cuentas.map((a) => (
                <div key={a.id} className="acc">
                  <div className="acc-main">
                    <strong>{a.account}</strong>
                    <Fuente s={[a.source]} />
                  </div>
                  <div className="faint small">
                    {a.followers != null ? `${a.followers.toLocaleString('es-ES')} ${p === 'youtube' ? 'suscriptores' : 'seguidores'}` : 'Seguidores sin medir'}
                  </div>
                  {a.note && <div className="small muted">{a.note}</div>}
                  <button className="btn small ghost" title="Quitar la cuenta de este canal" disabled={busy} onClick={() => void quitar(a.id)}><Trash2 size={13} /></button>
                </div>
              ))}
              <div className="addrow">
                <input placeholder="@cuenta o enlace del perfil" value={nuevo[p]} data-test={`own-account-input-${p}`}
                  onChange={(e) => setNuevo({ ...nuevo, [p]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && nuevo[p].trim() && void añadir(p)} />
                <button className="btn small" disabled={busy || !nuevo[p].trim()} data-test={`own-account-add-${p}`} onClick={() => void añadir(p)}><Plus size={13} />Añadir</button>
              </div>
              {p === 'youtube' && !props.youtubeConnected && (
                <button className="btn small ghost" onClick={props.onYouTube}>Conectar YouTube para que lleguen solas</button>
              )}
            </section>
          )
        })}
      </div>
      <p className="faint small">
        YouTube: al apuntar el canal, sus vídeos y cifras se leen solos con la clave de YouTube. TikTok e Instagram: solo llegan solas las cuentas
        ya conectadas con su API; el resto se apuntan a mano en cada vídeo («Apuntar cifras»). Cuando la subida la haga Metricool, sus cifras llegarán por ahí.
      </p>
    </>
  )
}
