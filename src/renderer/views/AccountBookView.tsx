import { Check, Copy, Mail } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AccountBook } from '../../core/api'
import { PLATFORM_LABEL, PLATFORMS } from '../../core/format'
import { Empty, useCopy } from '../components/Common'
import { PageHeader } from '../components/PageHeader'

/** Qué correo usa cada canal (PLAN\cuentas.json). Solo para consultar; nunca hay contraseñas. */
export function AccountBookView(props: { refresh: number }) {
  const [libro, setLibro] = useState<AccountBook | null>(null)
  const [copiado, copiar] = useCopy()

  useEffect(() => {
    let vivo = true
    void window.contentOS.getAccountBook().then((l) => vivo && setLibro(l)).catch(() => undefined)
    return () => {
      vivo = false
    }
  }, [props.refresh])

  if (!libro) return null

  return (
    <>
      <PageHeader title="Cuentas" titleTest="accounts-book-title"
        meta={<span>{libro.entries.length ? `${libro.byEmail.length} correos · ${libro.entries.length} canales${libro.updatedAt ? ` · actualizado ${new Date(libro.updatedAt + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}` : ''}` : ''}</span>} />
      {libro.error && <div className="banner bad"><span>{libro.error}</span></div>}
      {libro.entries.length === 0 ? (
        <Empty title="Aún no hay cuentas apuntadas" test="accounts-book-empty">
          <p>Dile a Claude qué correo usa cada canal y aparecerá aquí.</p>
        </Empty>
      ) : (
        <>
          <div className="abook" data-test="accounts-book">
            {libro.byEmail.map((g) => (
              <section className="abook-card" key={g.email} data-test="accounts-book-email">
                <header>
                  <Mail size={16} />
                  <h2>{g.email}</h2>
                  <span className="sp" />
                  <button className="btn small ghost" title="Copiar el correo" onClick={() => void copiar(g.email, g.email)}>
                    {copiado === g.email ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </header>
                <ul>
                  {g.entries.map((e) => (
                    <li key={e.platform + e.channel}>
                      <span className={`abook-pf ${e.platform}`}>{PLATFORM_LABEL[e.platform]}</span>
                      <span className="abook-ch">{e.channel}</span>
                      {e.note && <span className="faint small">{e.note}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <h2 className="abook-sec">Por plataforma</h2>
          <table className="abook-t">
            <tbody>
              {PLATFORMS.flatMap((p) => libro.entries.filter((e) => e.platform === p)).map((e) => (
                <tr key={e.platform + e.channel}>
                  <td><span className={`abook-pf ${e.platform}`}>{PLATFORM_LABEL[e.platform]}</span></td>
                  <td>{e.channel}</td>
                  <td className="muted">{e.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint small" style={{ marginTop: 12 }}>Para cambiar algo, díselo a Claude: lo apunta en PLAN\cuentas.json. Aquí nunca se guardan contraseñas.</p>
        </>
      )}
    </>
  )
}
