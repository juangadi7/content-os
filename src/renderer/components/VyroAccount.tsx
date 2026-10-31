import { LogIn, LogOut, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { VyroAccountView } from '../../core/api'
import { formatCount, relativeTime } from '../../core/format'
import { formatMoney } from '../../core/money'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Tu cuenta de Vyro: conectar (inicias sesión tú, en la web de Vyro), leer tus envíos y un resumen por campaña:
 * cuántos están pendientes, aprobados o rechazados, las visitas que cuenta Vyro y lo ganado.
 */
export function VyroAccount(props: { refresh: number; onChanged: () => void }) {
  const [cuenta, setCuenta] = useState<VyroAccountView | null>(null)
  const [busy, setBusy] = useState<null | 'conectar' | 'leer' | 'salir'>(null)
  const [error, setError] = useState<string | null>(null)
  const [saliendo, setSaliendo] = useState(false)

  useEffect(() => {
    let vivo = true
    void window.contentOS.getVyroAccount().then((c) => vivo && setCuenta(c)).catch(() => undefined)
    return () => {
      vivo = false
    }
  }, [props.refresh])

  // mientras lee, se pregunta cada pocos segundos hasta que acabe
  const leyendo = !!cuenta?.syncing
  useEffect(() => {
    if (!leyendo) return
    const id = window.setInterval(() => void window.contentOS.getVyroAccount().then((c) => {
      setCuenta(c)
      if (!c.syncing) props.onChanged()
    }).catch(() => undefined), 3000)
    return () => window.clearInterval(id)
  }, [leyendo])

  if (!cuenta) return null

  const hacer = async (que: 'conectar' | 'leer' | 'salir', f: () => Promise<VyroAccountView>) => {
    setBusy(que)
    setError(null)
    try {
      setCuenta(await f())
      setSaliendo(false)
      props.onChanged()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(null)
    }
  }

  if (!cuenta.connected) {
    return (
      <section className="vacc" data-test="vyro-account" data-connected="0">
        <div className="vacc-h">
          <h2>Tus envíos en Vyro</h2>
          <span className="sp" />
          <button className="btn primary" data-test="vyro-connect" disabled={busy !== null} onClick={() => void hacer('conectar', () => window.contentOS.vyroConnect())}>
            <LogIn size={14} />{busy === 'conectar' ? 'Esperando a que cierres la ventana…' : 'Conectar Vyro'}
          </button>
        </div>
        <p className="muted small">
          Se abre la web de Vyro: inicia sesión tú y cierra la ventana. Desde entonces la app lee tus envíos cada 30 minutos (solo lee: nunca envía nada)
          y marca sola como enviados los vídeos que ya están en Vyro, con su estado, las visitas que cuenta Vyro y lo ganado.
          Tu contraseña no pasa por la app; la sesión se guarda como en un navegador y la puedes borrar con «Desconectar».
        </p>
        {error && <p className="bad small">{error}</p>}
      </section>
    )
  }

  const s = cuenta.summary
  return (
    <section className="vacc" data-test="vyro-account" data-connected="1">
      <div className="vacc-h">
        <h2>Tus envíos en Vyro</h2>
        <span className="muted small" data-test="vyro-account-synced">
          {cuenta.syncing || busy === 'leer' ? 'Leyendo tus envíos…' : cuenta.lastSyncAt ? `Leídos ${relativeTime(cuenta.lastSyncAt)}` : 'Aún sin leer'}
        </span>
        <span className="sp" />
        <span className="vacc-earned" title="Lo que cuenta Vyro (pendiente y pagado)">{formatMoney(s.earned)} ganados</span>
        <button className="btn small" data-test="vyro-sync" disabled={busy !== null || cuenta.syncing} onClick={() => void hacer('leer', () => window.contentOS.vyroSyncSubmissions())}>
          <RefreshCw size={13} />Leer ahora
        </button>
        {saliendo ? (
          <>
            <button className="btn small danger" data-test="vyro-disconnect-confirm" disabled={busy !== null} onClick={() => void hacer('salir', () => window.contentOS.vyroDisconnect())}>Sí, desconectar</button>
            <button className="btn small ghost" onClick={() => setSaliendo(false)}>Cancelar</button>
          </>
        ) : (
          <button className="btn small ghost" data-test="vyro-disconnect" title="Borra la sesión de Vyro guardada en la app" onClick={() => setSaliendo(true)}><LogOut size={13} />Desconectar</button>
        )}
      </div>
      {(error || cuenta.error) && (
        <div className="banner bad" data-test="vyro-account-error"><TriangleAlert size={15} /><span>{error ?? cuenta.error}</span>
          {cuenta.error?.includes('Conectar') && <button className="btn small" onClick={() => void hacer('conectar', () => window.contentOS.vyroConnect())}>Volver a conectar</button>}
        </div>
      )}
      {s.campaigns.length === 0 ? (
        <p className="muted small">{cuenta.lastSyncAt ? 'No hay envíos en las campañas que tienes enlazadas.' : 'Pulsa «Leer ahora» para traer tus envíos.'}</p>
      ) : (
        <table className="vacc-t" data-test="vyro-submissions">
          <thead><tr><th>Campaña</th><th>Envíos</th><th>Pendientes</th><th>Aprobados</th><th>Rechazados</th><th>Visitas (Vyro)</th><th>Ganado</th></tr></thead>
          <tbody>
            {s.campaigns.map((c) => (
              <tr key={c.vyroId} data-test="vyro-submissions-row">
                <td>{c.name}{c.unmatched > 0 && <span className="faint small" title="Envíos que la app no sabe de qué clip son: publicados sin enlace guardado o desde una cuenta que no está en la app"> · {c.unmatched} sin clip</span>}</td>
                <td>{c.total}</td>
                <td className={c.pending ? 'warn' : 'faint'}>{c.pending}</td>
                <td className={c.approved ? 'ok' : 'faint'}>{c.approved}</td>
                <td className={c.rejected ? 'bad' : 'faint'}>{c.rejected}</td>
                <td>{formatCount(c.views)}</td>
                <td className={c.earned ? 'ok' : 'faint'}>{formatMoney(c.earned)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
