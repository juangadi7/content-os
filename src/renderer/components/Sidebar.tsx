import { Film, Mail, Music, ShieldCheck, CalendarCheck, CalendarDays, CalendarRange, ChartColumn, CircleCheck, Clapperboard, Clock, FolderKanban, LayoutGrid, MonitorPlay, Radar, RefreshCw, Sparkles, Tv, UserRound, type LucideIcon } from 'lucide-react'
import type { AppState } from '../../core/api'
import { relativeTime } from '../../core/format'

export type Section = 'vyro' | 'control' | 'accounts' | 'today' | 'calendar' | 'weekend' | 'campaigns' | 'all' | 'published' | 'pending' | 'stats' | 'channels' | 'personal' | 'extras' | 'long' | 'music'

export interface SyncStatus {
  phase: 'idle' | 'running' | 'done' | 'error'
  text: string
  problems: number
}

interface Item {
  id: Section
  label: string
  icon: LucideIcon
  count?: number
  /** El número va en rojo (algo que atender). */
  alert?: boolean
}

export function Sidebar(props: {
  state: AppState
  section: Section
  sync: SyncStatus
  onSection: (s: Section) => void
  onSync: () => void
  onShowProblems: () => void
  onYouTube: () => void
}) {
  const { state, section, sync } = props
  const c = state.counts
  const grupos: [string, Item[]][] = [
    ['Operar', [
      { id: 'today', label: 'Hoy', icon: CalendarCheck, count: state.todayLeft },
      { id: 'calendar', label: 'Calendario', icon: CalendarDays },
      { id: 'weekend', label: 'Fin de semana', icon: CalendarRange },
      { id: 'campaigns', label: 'Campañas', icon: FolderKanban, count: c.campaigns },
      { id: 'all', label: 'Todos los clips', icon: Clapperboard, count: c.clips },
      { id: 'pending', label: 'Pendientes', icon: Clock, count: c.pending }
    ]],
    ['Seguimiento', [
      { id: 'control', label: 'Control de vídeos', icon: ShieldCheck, count: state.videosAlert || undefined, alert: state.videosAlert > 0 },
      { id: 'published', label: 'Publicados', icon: CircleCheck, count: c.published },
      { id: 'stats', label: 'Estadísticas', icon: ChartColumn },
      { id: 'channels', label: 'Canales', icon: Tv, count: state.youtubeChannels.length + state.socialConnected.length || undefined }
    ]]
  ]
  const biblioteca = state.libraries.filter((l) => l.enabled)
  const rutas = biblioteca.length ? biblioteca.map((l) => l.path) : state.configuredRoots
  const noDisponible = biblioteca.some((l) => !l.available)
  const clase = sync.phase === 'error' ? 'bad' : sync.phase === 'done' && sync.problems ? 'warn' : sync.phase === 'done' ? 'ok' : 'muted'
  const punto = sync.phase === 'running' ? 'run' : sync.phase === 'error' || noDisponible ? 'bad' : sync.phase === 'done' && sync.problems ? 'warn' : sync.phase === 'done' ? 'ok' : ''

  return (
    <aside className="side">
      <div className="brand"><span className="logo"><LayoutGrid size={14} strokeWidth={2.4} /></span>CONTENT OS</div>
      <nav className="nav">
        {grupos.map(([titulo, items]) => (
          <div key={titulo} style={{ display: 'contents' }}>
            <div className="nav-group">{titulo}</div>
            {items.map(({ id, label, icon: Icono, count, alert }) => (
              <button key={id} className={section === id ? 'on' : ''} data-test={`nav-${id}`} onClick={() => props.onSection(id)}>
                <Icono size={16} strokeWidth={1.9} />
                <span className="lbl">{label}</span>
                {count != null && <span className={`n ${alert ? 'alert' : ''}`}>{count}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="nav-group personal">Personal</div>
        <button className={`personal ${section === 'personal' ? 'on' : ''}`} data-test="nav-personal" onClick={() => props.onSection('personal')}>
          <UserRound size={16} strokeWidth={1.9} />
          <span className="lbl">Canales personales</span>
          {state.personalChannels.length > 0 && <span className="n">{state.personalChannels.length}</span>}
        </button>
        <button className={`personal ${section === 'long' ? 'on' : ''}`} data-test="nav-long" onClick={() => props.onSection('long')}>
          <Film size={16} strokeWidth={1.9} />
          <span className="lbl">Vídeos largos</span>
          {state.longPending > 0 && <span className="n" title="Sin marcar como subidos">{state.longPending}</span>}
        </button>
        <button className={`personal ${section === 'music' ? 'on' : ''}`} data-test="nav-music" onClick={() => props.onSection('music')}>
          <Music size={16} strokeWidth={1.9} />
          <span className="lbl">Vídeos de música</span>
          {state.musicPending > 0 && <span className="n" title="Sin marcar como subidos">{state.musicPending}</span>}
        </button>
        <button className={`personal ${section === 'extras' ? 'on' : ''}`} data-test="nav-extras" onClick={() => props.onSection('extras')}>
          <Sparkles size={16} strokeWidth={1.9} />
          <span className="lbl">Fuera de campaña</span>
          {state.extrasCount > 0 && <span className="n">{state.extrasCount}</span>}
        </button>
        <button className={`personal ${section === 'accounts' ? 'on' : ''}`} data-test="nav-accounts" onClick={() => props.onSection('accounts')}>
          <Mail size={16} strokeWidth={1.9} />
          <span className="lbl">Cuentas</span>
        </button>
        <div className="nav-group">Fuentes</div>
        <button className={section === 'vyro' ? 'on' : ''} data-test="nav-vyro" onClick={() => props.onSection('vyro')}>
          <Radar size={16} strokeWidth={1.9} />
          <span className="lbl">Vyro</span>
          {state.vyroNew > 0 && <span className="n pill" data-test="vyro-badge">{state.vyroNew} {state.vyroNew === 1 ? 'nueva' : 'nuevas'}</span>}
          {state.vyroToSend > 0 && <span className="n pill warn" data-test="vyro-send-badge" title="Vídeos ya públicos que falta enviar a Vyro (están en «Hoy»)">{state.vyroToSend} por enviar</span>}
        </button>
        <button data-test="nav-youtube" onClick={props.onYouTube}>
          <MonitorPlay size={16} strokeWidth={1.9} />
          <span className="lbl">YouTube</span>
          <span className={`n ${state.youtubeConnected ? 'ok' : ''}`}>{state.youtubeConnected ? 'conectado' : 'conectar'}</span>
        </button>
      </nav>
      <div className="grow" />
      <div className="lib">
        <div className="lib-row">
          <span className={`dot-state ${punto}`} />
          <div className={`sync-msg ${clase}`} data-test="sync-status" title={sync.text}>
            {sync.phase === 'done' && sync.problems > 0 ? <button onClick={props.onShowProblems}>{sync.text}</button> : sync.text}
          </div>
        </div>
        <div className="lib-meta" title={rutas.join('\n')}>
          {rutas.length === 0 ? <span className="warn">Sin configurar</span> : noDisponible ? <span className="bad">La carpeta no está accesible</span> : (
            <>Última vez <span data-test="last-sync">{relativeTime(state.lastRun?.finishedAt)}</span> · <span className="path">{rutas[0].split(/[\\/]/).slice(-2).join('\\')}</span></>
          )}
        </div>
        <button className="btn wide" data-test="sync" disabled={sync.phase === 'running'} onClick={props.onSync}>
          <RefreshCw size={14} className={sync.phase === 'running' ? 'spin' : ''} />
          {sync.phase === 'running' ? 'Sincronizando…' : 'Sincronizar'}
        </button>
      </div>
    </aside>
  )
}
