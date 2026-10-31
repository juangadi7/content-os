import { useCallback, useEffect, useState } from 'react'
import type { AppState, SyncEventView, SyncSummary } from '../core/api'
import type { ClipFilter } from '../core/format'
import { Sidebar, type Section, type SyncStatus } from './components/Sidebar'
import { YouTubeModal } from './components/YouTubeModal'
import { AllClipsView } from './views/AllClipsView'
import { CampaignsView } from './views/CampaignsView'
import { ExtrasView } from './views/ExtrasView'
import { LongVideosView } from './views/LongVideosView'
import { WeekendView } from './views/WeekendView'
import { CanalesView } from './views/CanalesView'
import { ClipDetailView } from './views/ClipDetailView'
import { ClipListView } from './views/ClipListView'
import { PendingView } from './views/PendingView'
import { PersonalChannelsView } from './views/PersonalChannelsView'
import { PublishedView } from './views/PublishedView'
import { StatsView } from './views/StatsView'
import { TodayView } from './views/TodayView'
import { VyroView } from './views/VyroView'
import { CalendarView } from './views/CalendarView'
import { AccountBookView } from './views/AccountBookView'
import { VideoControlView } from './views/VideoControlView'

/** Una sola ventana: las pantallas se apilan y "volver" quita la de arriba. */
type View =
  | { name: 'campaigns' }
  | { name: 'today' }
  | { name: 'weekend' }
  | { name: 'calendar' }
  | { name: 'vyro' }
  | { name: 'campaign'; campaignId: string; filter: ClipFilter; search: string }
  | { name: 'all'; filter: ClipFilter; search: string }
  | { name: 'pending'; search: string }
  | { name: 'published' }
  | { name: 'stats' }
  | { name: 'channels' }
  | { name: 'personal' }
  | { name: 'extras' }
  | { name: 'long' }
  | { name: 'music' }
  | { name: 'accounts' }
  | { name: 'control' }
  | { name: 'clip'; clipId: string }

const RAIZ: Record<Section, View> = {
  today: { name: 'today' },
  weekend: { name: 'weekend' },
  calendar: { name: 'calendar' },
  vyro: { name: 'vyro' },
  campaigns: { name: 'campaigns' },
  all: { name: 'all', filter: 'all', search: '' },
  pending: { name: 'pending', search: '' },
  published: { name: 'published' },
  stats: { name: 'stats' },
  channels: { name: 'channels' },
  personal: { name: 'personal' },
  extras: { name: 'extras' },
  long: { name: 'long' },
  music: { name: 'music' },
  accounts: { name: 'accounts' },
  control: { name: 'control' }
}

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function resumen(s: SyncSummary): SyncStatus {
  const problemas = s.warnings + s.errors
  if (problemas === 0) return { phase: 'done', text: `Sincronizado · ${s.clipsSeen} clips`, problems: 0 }
  return { phase: 'done', text: `Sincronizado con ${problemas} ${problemas === 1 ? 'aviso' : 'avisos'}`, problems: problemas }
}

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [stack, setStack] = useState<View[]>([RAIZ.campaigns])
  const [section, setSection] = useState<Section>('campaigns')
  const [sync, setSync] = useState<SyncStatus>({ phase: 'idle', text: '', problems: 0 })
  const [refresh, setRefresh] = useState(0)
  const [problems, setProblems] = useState<SyncEventView[] | null>(null)
  const [youtube, setYoutube] = useState(false)

  const view = stack[stack.length - 1]
  const push = (v: View) => setStack((s) => [...s, v])
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  const replaceTop = (v: View) => setStack((s) => [...s.slice(0, -1), v])
  const goSection = (s: Section) => {
    setSection(s)
    setStack([RAIZ[s]])
  }

  const reload = useCallback(async () => {
    setState(await window.contentOS.getState())
    setRefresh((n) => n + 1)
  }, [])

  const sincronizar = useCallback(async () => {
    setSync({ phase: 'running', text: 'Sincronizando…', problems: 0 })
    try {
      const r = await window.contentOS.sync()
      setState(r.state)
      setRefresh((n) => n + 1)
      setSync(resumen(r.summary))
      // de paso, cifras de YouTube (como mucho una medición cada 30 minutos por vídeo)
      if (r.state.youtubeConnected) {
        void window.contentOS.youtubeRefresh(false).then(() => reload()).catch(() => undefined)
      }
    } catch (e) {
      setSync({ phase: 'error', text: mensaje(e), problems: 0 })
    }
  }, [])

  // al abrir: enseñar lo que ya hay y, en segundo plano, volver a leer la biblioteca
  useEffect(() => {
    void (async () => {
      try {
        const s = await window.contentOS.getState()
        setState(s)
        if (s.configuredRoots.length > 0) void sincronizar()
      } catch (e) {
        setFatal(mensaje(e))
      }
    })()
  }, [sincronizar])

  // la aplicación se sincroniza sola cuando cambia la carpeta de campañas
  useEffect(
    () =>
      window.contentOS.onLibraryChanged((r) => {
        setState(r.state)
        setRefresh((n) => n + 1)
        const s = r.summary
        if (s.created + s.updated + s.disappeared > 0) {
          const partes = [s.created ? `${s.created} ${s.created === 1 ? 'nuevo' : 'nuevos'}` : '', s.updated ? `${s.updated} ${s.updated === 1 ? 'cambiado' : 'cambiados'}` : '', s.disappeared ? `${s.disappeared} ${s.disappeared === 1 ? 'retirado' : 'retirados'}` : ''].filter(Boolean)
          setSync({ phase: 'done', text: `Actualizado solo · ${partes.join(', ')}`, problems: s.warnings + s.errors })
        }
      }),
    []
  )

  // al pulsar un aviso de Windows se abre el apartado que corresponde
  useEffect(() => window.contentOS.onNavigate((s) => {
    if (s === 'control' || s === 'today' || s === 'vyro') goSection(s)
  }), [])

  // cambios que llegan solos (comprobación periódica de Vyro)
  useEffect(
    () =>
      window.contentOS.onStateChanged((s) => {
        setState(s)
        setRefresh((n) => n + 1)
      }),
    []
  )

  // cifras "en vivo": con la app abierta, se vuelven a pedir cada 15 minutos
  const conectado = state?.youtubeConnected ?? false
  /** «Actualizar»: mira YouTube (lo ya subido se marca solo) y recalcula «Hoy» y «Fin de semana». */
  const actualizar = useCallback(async () => {
    if (conectado) await window.contentOS.youtubeRefresh(true).catch(() => undefined)
    await reload()
  }, [conectado, reload])
  // al volver a la ventana se recalcula (como mucho una vez cada 30 s)
  useEffect(() => {
    let ultima = 0
    const alVolver = () => {
      if (document.visibilityState === 'hidden' || Date.now() - ultima < 30_000) return
      ultima = Date.now()
      void reload()
    }
    window.addEventListener('focus', alVolver)
    document.addEventListener('visibilitychange', alVolver)
    return () => {
      window.removeEventListener('focus', alVolver)
      document.removeEventListener('visibilitychange', alVolver)
    }
  }, [reload])
  useEffect(() => {
    if (!conectado) return
    const id = window.setInterval(() => {
      void window.contentOS.youtubeRefresh(false).then(() => reload()).catch(() => undefined)
    }, 15 * 60_000)
    return () => window.clearInterval(id)
  }, [conectado, reload])

  // Esc o el botón "atrás" del ratón: volver
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.veil')) back()
    }
    const raton = (e: MouseEvent) => {
      if (e.button === 3) back()
    }
    window.addEventListener('keydown', tecla)
    window.addEventListener('mouseup', raton)
    return () => {
      window.removeEventListener('keydown', tecla)
      window.removeEventListener('mouseup', raton)
    }
  }, [])

  if (!state) return <div className="main"><div className="page">{fatal ? <p className="bad">{fatal}</p> : null}</div></div>

  const añadirBiblioteca = async () => {
    try {
      const s = await window.contentOS.addLibrary()
      if (s) {
        setState(s)
        void sincronizar()
      }
    } catch (e) {
      setSync({ phase: 'error', text: mensaje(e), problems: 0 })
    }
  }
  const verProblemas = async () => setProblems(await window.contentOS.listSyncProblems())
  const abrirClip = (clipId: string) => push({ name: 'clip', clipId })
  const syncing = sync.phase === 'running'
  const anterior = stack[stack.length - 2]
  const etiquetaVolver =
    anterior?.name === 'campaign'
      ? state.campaigns.find((c) => c.campaignId === anterior.campaignId)?.displayName ?? 'Campaña'
      : anterior?.name === 'all' ? 'Todos los clips' : anterior?.name === 'pending' ? 'Pendientes' : anterior?.name === 'published' ? 'Publicados' : anterior?.name === 'stats' ? 'Estadísticas' : anterior?.name === 'channels' ? 'Canales' : anterior?.name === 'today' ? 'Hoy' : anterior?.name === 'vyro' ? 'Vyro' : 'Volver'

  return (
    <div className="app">
      <Sidebar state={state} section={section} sync={sync} onSection={goSection} onSync={sincronizar} onShowProblems={verProblemas} onYouTube={() => setYoutube(true)} />
      <main className="main" data-view={view.name}>
        <div className="page" key={view.name === 'clip' ? view.clipId : view.name === 'campaign' ? view.campaignId : view.name}>
        {view.name === 'campaigns' && (
          <CampaignsView
            state={state}
            syncing={syncing}
            onOpen={(campaignId) => push({ name: 'campaign', campaignId, filter: 'all', search: '' })}
            onSync={sincronizar}
            onAddLibrary={añadirBiblioteca}
          />
        )}
        {view.name === 'campaign' && (
          <ClipListView
            scope="campaign"
            campaign={state.campaigns.find((c) => c.campaignId === view.campaignId) ?? null}
            filter={view.filter}
            search={view.search}
            refresh={refresh}
            syncing={syncing}
            onFilter={(filter, search) => replaceTop({ ...view, filter, search })}
            onOpen={abrirClip}
            onBack={back}
            onSync={sincronizar}
            accounts={state.accounts}
            onAccounts={async (ids) => {
              setState(await window.contentOS.setCampaignAccounts(view.campaignId, ids))
              setRefresh((n) => n + 1)
            }}
            onTerms={async (t) => {
              setState(await window.contentOS.setCampaignTerms({ campaignId: view.campaignId, ...t }))
              setRefresh((n) => n + 1)
            }}
            onStatus={async (cambio) => {
              setState(await window.contentOS.setCampaignStatus({ campaignId: view.campaignId, ...cambio }))
              setRefresh((n) => n + 1)
            }}
            onTrash={async () => {
              setState(await window.contentOS.trashCampaign(view.campaignId))
              setRefresh((n) => n + 1)
              back()
            }}
          />
        )}
        {view.name === 'all' && (
          <AllClipsView campaigns={state.campaigns} search={view.search} refresh={refresh} onSearch={(search) => replaceTop({ ...view, search })} onOpen={abrirClip} />
        )}
        {view.name === 'pending' && (
          <PendingView campaigns={state.campaigns} search={view.search} refresh={refresh} onSearch={(search) => replaceTop({ ...view, search })} onOpen={abrirClip} />
        )}
        {view.name === 'today' && <TodayView refresh={refresh} onOpen={abrirClip} onChanged={reload} onRefresh={actualizar} />}
        {view.name === 'vyro' && (
          <VyroView refresh={refresh} onChanged={reload} onOpenClip={abrirClip} onSeen={async () => setState(await window.contentOS.getState())}
            onOpenCampaign={(campaignId) => push({ name: 'campaign', campaignId, filter: 'all', search: '' })} />
        )}
        {view.name === 'published' && <PublishedView refresh={refresh} onOpen={abrirClip} />}
        {view.name === 'stats' && <StatsView state={state} refresh={refresh} onOpen={abrirClip} onYouTube={() => setYoutube(true)} onChanged={reload} />}
        {view.name === 'channels' && <CanalesView state={state} refresh={refresh} onOpen={abrirClip} onYouTube={() => setYoutube(true)} onChanged={reload} />}
        {view.name === 'personal' && <PersonalChannelsView state={state} refresh={refresh} onState={setState} onYouTube={() => setYoutube(true)} onChanged={reload} />}
        {view.name === 'weekend' && <WeekendView refresh={refresh} onOpen={abrirClip} onChanged={reload} onRefresh={actualizar} />}
        {view.name === 'calendar' && (
          <CalendarView refresh={refresh} onSection={goSection} onOpenClip={abrirClip}
            onOpenCampaign={(campaignId) => push({ name: 'campaign', campaignId, filter: 'all', search: '' })} />
        )}
        {view.name === 'extras' && <ExtrasView refresh={refresh} onChanged={reload} />}
        {view.name === 'long' && <LongVideosView key="long" kind="long" refresh={refresh} onChanged={reload} />}
        {view.name === 'music' && <LongVideosView key="music" kind="music" refresh={refresh} onChanged={reload} />}
        {view.name === 'accounts' && <AccountBookView refresh={refresh} />}
        {view.name === 'control' && (
          <VideoControlView refresh={refresh} onOpenClip={abrirClip} onChanged={reload} onVyro={() => goSection('vyro')}
            onCheckNow={async () => {
              if (conectado) await window.contentOS.youtubeRefresh(true).catch(() => undefined)
              await window.contentOS.vyroSyncSubmissions().catch(() => undefined)
              await reload()
            }} />
        )}
        {view.name === 'clip' && <ClipDetailView clipId={view.clipId} refresh={refresh} backLabel={etiquetaVolver} onBack={back} onChanged={reload} />}
        </div>
      </main>

      {youtube && <YouTubeModal state={state} onState={setState} onRefreshed={reload} onClose={() => setYoutube(false)} />}

      {problems && (
        <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && setProblems(null)}>
          <div className="modal" data-test="problems-modal">
            <h2>Avisos de la última sincronización</h2>
            {problems.length === 0 ? (
              <p className="muted">Sin avisos.</p>
            ) : (
              <ul className="list-plain">
                {problems.map((p) => (
                  <li key={p.id} className={p.level === 'error' ? 'bad' : 'warn'}>
                    {p.message} <span className="faint mono">{p.clipId ?? p.campaignId ?? ''}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="foot">
              <span className="sp" />
              <button className="btn" onClick={() => setProblems(null)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
