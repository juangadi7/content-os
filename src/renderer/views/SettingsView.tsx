import { Image, Mail, MonitorPlay, Radar, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { backgroundUrl, type AppState } from '../../core/api'
import { PageHeader } from '../components/PageHeader'
import fondoDeSerie from '../assets/fondo.jpg'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Ajustes: el fondo de pantalla y las conexiones (YouTube; TikTok e Instagram se conectan desde sus archivos). */
export function SettingsView(props: { state: AppState; onState: (s: AppState) => void; onYouTube: () => void; onAccounts: () => void; showVyro: boolean; onShowVyro: (v: boolean) => void }) {
  const [error, setError] = useState<string | null>(null)
  const s = props.state
  const elegir = async () => {
    setError(null)
    try {
      const r = await window.contentOS.pickBackground()
      if (r) props.onState(r)
    } catch (e) {
      setError(mensaje(e))
    }
  }
  return (
    <>
      <PageHeader title="Ajustes" titleTest="settings-title" />
      {error && <div className="banner bad"><span>{error}</span></div>}
      <div className="ogrid">
        <section className="opanel glass" data-test="settings-background">
          <h3><Image size={15} /> Fondo de pantalla</h3>
          <img className="bgprev" src={s.background ? backgroundUrl(s.background) : fondoDeSerie} alt="Fondo actual" />
          <p className="faint small">{s.background ? 'Usando tu imagen.' : 'Usando el fondo de serie (salón con ventanal al atardecer, generado en tu PC).'}</p>
          <div className="row-btns">
            <button className="btn" data-test="settings-pick-bg" onClick={() => void elegir()}><Image size={14} />Elegir imagen</button>
            {s.background && <button className="btn ghost" onClick={async () => props.onState(await window.contentOS.resetBackground())}><RotateCcw size={14} />Volver al de serie</button>}
          </div>
        </section>
        <section className="opanel glass">
          <h3><MonitorPlay size={15} /> Conexiones</h3>
          <ul className="list-plain small">
            <li>YouTube: {s.youtubeConnected ? <span className="ok">conectado</span> : <span className="warn">sin conectar</span>} <button className="btn small ghost" data-test="nav-youtube" onClick={props.onYouTube}>{s.youtubeConnected ? 'Ver' : 'Conectar'}</button></li>
            <li>TikTok: {s.socialConnected.filter((c) => c.platform === 'tiktok').map((c) => c.account).join(', ') || <span className="warn">ninguna cuenta conectada</span>}</li>
            <li>Instagram: {s.socialConnected.some((c) => c.platform === 'instagram') ? <span className="ok">conectado</span> : <span className="warn">sin conectar</span>}</li>
          </ul>
          <p className="faint small">Las cuentas de TikTok e Instagram se conectan con sus claves en la carpeta .secretos (pídeselo a Claude). Más adelante, Metricool podrá traer las cifras de todas.</p>
          <button className="btn small" data-test="nav-accounts" onClick={props.onAccounts}><Mail size={13} />Correos de cada cuenta</button>
        </section>
        <section className="opanel glass" data-test="settings-vyro">
          <h3><Radar size={15} /> Vyro (clips de campañas)</h3>
          <p className="faint small">Ahora no lo usas, así que está escondido del menú, de Inicio y de la campana. Al activarlo vuelven a salir sus apartados (Hoy, Campañas, Clips, Publicados…). No se borra nada.</p>
          <label className="toggle">
            <input type="checkbox" data-test="settings-show-vyro" checked={props.showVyro} onChange={(e) => props.onShowVyro(e.target.checked)} />
            <span>Enseñar Vyro en el menú</span>
          </label>
        </section>
      </div>
    </>
  )
}
