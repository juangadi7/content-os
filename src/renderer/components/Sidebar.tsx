import {
  Building, CalendarCheck, ChartColumn, ChevronDown, ChevronRight, CircleCheck, Clapperboard, Clock, Film, FolderKanban, Folders,
  Factory, Gamepad2, Ghost, House, Lightbulb, LayoutGrid, ListOrdered, Music, Radar, RefreshCw, Settings, ShieldCheck, Sparkles, Tv, UserRound, Users, Video, type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppState, OwnChannel } from '../../core/api'
import { relativeTime } from '../../core/format'

type OwnSection = OwnChannel | `${OwnChannel}-stats` | `${OwnChannel}-accounts` | 'curio-fabrica' | 'curio-queue'
export type Section =
  | 'home' | 'settings'
  | 'vyro' | 'control' | 'accounts' | 'today' | 'calendar' | 'weekend' | 'campaigns' | 'all' | 'published' | 'pending' | 'stats' | 'channels'
  | 'personal' | 'extras' | 'long' | 'music' | 'city'
  | OwnSection

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
  test?: string
}

/** Canales propios: nombre, icono y color (el mismo en el menú, en Inicio y en sus tarjetas). */
export const CANALES: { id: OwnChannel; nombre: string; icon: LucideIcon; color: string }[] = [
  { id: 'gta', nombre: 'GTA 6', icon: Gamepad2, color: 'azul' },
  { id: 'curio', nombre: 'Curiosidades', icon: Lightbulb, color: 'ocre' },
  { id: 'roblox', nombre: 'Historias Roblox', icon: Ghost, color: 'morado' }
]

const GUARDADO = 'cos:menu-abierto'
/** Desplegables abiertos (se recuerdan entre sesiones). Si no se puede leer, abiertos los canales. */
function leerAbiertos(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(GUARDADO) ?? 'null')
    if (v && typeof v === 'object') return v
  } catch {
    /* sin almacenamiento: valores por defecto */
  }
  return { gta: true }
}

/** ¿Se enseña Vyro? (16-nov-2026: Juan no lo usa ahora; se activa en Ajustes). Por defecto, no. */
const VER_VYRO = 'cos:mostrar-vyro'
export function leerVerVyro(): boolean {
  try {
    return localStorage.getItem(VER_VYRO) === '1'
  } catch {
    return false
  }
}
export function guardarVerVyro(v: boolean): void {
  try {
    localStorage.setItem(VER_VYRO, v ? '1' : '0')
  } catch {
    /* solo es comodidad */
  }
}

/** Grupo al que pertenece una sección (para abrirlo solo al entrar en ella). */
function grupoDe(s: Section): string[] {
  const propio = CANALES.find((c) => s === c.id || s.startsWith(c.id + '-'))
  if (propio) return [propio.id]
  if (['today', 'campaigns', 'all', 'pending', 'control', 'published', 'stats', 'channels', 'vyro'].includes(s)) return ['vyro']
  if (['personal', 'extras', 'long', 'music', 'city'].includes(s)) return ['otros']
  return []
}

export function Sidebar(props: {
  state: AppState
  section: Section
  sync: SyncStatus
  onSection: (s: Section) => void
  onSync: () => void
  onShowProblems: () => void
  onYouTube: () => void
  /** Enseñar el grupo «Vyro» (se activa en Ajustes). */
  showVyro: boolean
}) {
  const { state, section, sync } = props
  const c = state.counts
  const [abiertos, setAbiertos] = useState<Record<string, boolean>>(leerAbiertos)
  useEffect(() => {
    try {
      localStorage.setItem(GUARDADO, JSON.stringify(abiertos))
    } catch {
      /* da igual: solo es comodidad */
    }
  }, [abiertos])
  // al entrar en una sección (p. ej. desde Inicio o un aviso), su desplegable se abre
  useEffect(() => {
    const g = grupoDe(section)
    if (g.some((k) => !abiertos[k])) setAbiertos((a) => ({ ...a, ...(CANALES.some((c) => g.includes(c.id)) ? cerrados : {}), ...Object.fromEntries(g.map((k) => [k, true])) }))
  }, [section])
  const alternar = (k: string) => setAbiertos((a) => ({ ...a, [k]: !a[k] }))
  // canales en acordeón: abrir uno cierra los otros (menos lío a la vista)
  const cerrados = Object.fromEntries(CANALES.map((c) => [c.id, false]))
  const alternarCanal = (k: string) => setAbiertos((a) => ({ ...a, ...cerrados, [k]: !a[k] }))

  const pendientes: Record<OwnChannel, number> = { gta: state.gtaPending, curio: state.curioPending, roblox: state.robloxPending }
  const vyro: Item[] = [
    { id: 'today', label: 'Hoy', icon: CalendarCheck, count: state.todayLeft },
    { id: 'campaigns', label: 'Campañas', icon: FolderKanban, count: c.campaigns },
    { id: 'all', label: 'Todos los clips', icon: Clapperboard, count: c.clips },
    { id: 'pending', label: 'Pendientes', icon: Clock, count: c.pending },
    { id: 'control', label: 'Control de vídeos', icon: ShieldCheck, count: state.videosAlert || undefined, alert: state.videosAlert > 0 },
    { id: 'published', label: 'Publicados', icon: CircleCheck, count: c.published },
    { id: 'stats', label: 'Estadísticas de clips', icon: ChartColumn },
    { id: 'channels', label: 'Canales de clips', icon: Tv, count: state.youtubeChannels.length + state.socialConnected.length || undefined },
    { id: 'vyro', label: 'Campañas nuevas', icon: Radar, count: state.vyroNew || undefined, alert: state.vyroNew > 0 }
  ]
  const otros: Item[] = [
    { id: 'city', label: 'Vídeos de la ciudad', icon: Building, count: state.cityPending || undefined },
    { id: 'long', label: 'Vídeos largos', icon: Film, count: state.longPending || undefined },
    { id: 'music', label: 'Vídeos de música', icon: Music, count: state.musicPending || undefined },
    { id: 'extras', label: 'Fuera de campaña', icon: Sparkles, count: state.extrasCount || undefined },
    { id: 'personal', label: 'Canales personales', icon: UserRound, count: state.personalChannels.length || undefined }
  ]

  const boton = ({ id, label, icon: Icono, count, alert, test }: Item, nivel = 1) => (
    <button key={id} className={`${section === id ? 'on' : ''} n${nivel}`} data-test={test ?? `nav-${id}`} onClick={() => props.onSection(id)}>
      <Icono size={15} strokeWidth={1.9} />
      <span className="lbl">{label}</span>
      {count != null && <span className={`n ${alert ? 'alert' : ''}`}>{count}</span>}
    </button>
  )
  const grupo = (k: string, titulo: string, Icono: LucideIcon, extra?: React.ReactNode) => (
    <button className={`grp ${abiertos[k] ? 'open' : ''}`} data-test={`grp-${k}`} aria-expanded={!!abiertos[k]} onClick={() => alternar(k)}>
      {abiertos[k] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <Icono size={15} strokeWidth={1.9} />
      <span className="lbl">{titulo}</span>
      {extra}
    </button>
  )

  const biblioteca = state.libraries.filter((l) => l.enabled)
  const rutas = biblioteca.length ? biblioteca.map((l) => l.path) : state.configuredRoots
  const noDisponible = biblioteca.some((l) => !l.available)
  const clase = sync.phase === 'error' ? 'bad' : sync.phase === 'done' && sync.problems ? 'warn' : sync.phase === 'done' ? 'ok' : 'muted'
  const punto = sync.phase === 'running' ? 'run' : sync.phase === 'error' || noDisponible ? 'bad' : sync.phase === 'done' && sync.problems ? 'warn' : sync.phase === 'done' ? 'ok' : ''

  return (
    <aside className="side glass">
      <div className="brand"><span className="logo"><LayoutGrid size={14} strokeWidth={2.4} /></span>CONTENT OS</div>
      <nav className="nav">
        {boton({ id: 'home', label: 'Inicio', icon: House }, 0)}

        <div className="nav-label">Mis canales</div>
        {CANALES.map((ch) => (
          <div key={ch.id} className={`subgrp ${ch.color} ${abiertos[ch.id] ? 'open' : ''}`}>
            <button className={`grp ch ${abiertos[ch.id] ? 'open' : ''}`} data-test={`grp-${ch.id}`} aria-expanded={!!abiertos[ch.id]} onClick={() => alternarCanal(ch.id)}>
              {abiertos[ch.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className={`chdot ${ch.color}`}><ch.icon size={12} strokeWidth={2.2} /></span>
              <span className="lbl">{ch.nombre}</span>
              {pendientes[ch.id] > 0 && <span className="n" title="Vídeos sin subir a ninguna red">{pendientes[ch.id]}</span>}
            </button>
            {abiertos[ch.id] && (
              <>
                {boton({ id: ch.id, label: 'Vídeos', icon: Video, count: state.ownVideos[ch.id] || undefined, test: `nav-${ch.id}` }, 2)}
                {boton({ id: `${ch.id}-stats`, label: 'Estadísticas', icon: ChartColumn, test: `nav-${ch.id}-stats` }, 2)}
                {boton({ id: `${ch.id}-accounts`, label: 'Cuentas', icon: Users, test: `nav-${ch.id}-accounts` }, 2)}
                {ch.id === 'curio' && boton({ id: 'curio-queue', label: 'Cola de Metricool', icon: ListOrdered, test: 'nav-curio-queue' }, 2)}
                {ch.id === 'curio' && boton({ id: 'curio-fabrica', label: 'Fábrica', icon: Factory, test: 'nav-curio-fabrica' }, 2)}
              </>
            )}
          </div>
        ))}

        <div className="nav-sep" />
        {grupo('otros', 'Otros proyectos', Folders)}
        {abiertos.otros && <div className="subitems">{otros.map((i) => boton(i))}</div>}

        {props.showVyro && (
          <>
            {grupo('vyro', 'Vyro', Radar, (
              <>
                {state.vyroNew > 0 && <span className="n pill" data-test="vyro-badge" title={`${state.vyroNew} campañas nuevas`}>{state.vyroNew}</span>}
                {state.vyroToSend > 0 && <span className="n pill warn" data-test="vyro-send-badge" title="Vídeos ya públicos que falta enviar a Vyro (están en «Hoy»)">{state.vyroToSend}</span>}
              </>
            ))}
            {abiertos.vyro && <div className="subitems">{vyro.map((i) => boton(i))}</div>}
          </>
        )}

        <div className="nav-sep" />
        {boton({ id: 'settings', label: 'Ajustes', icon: Settings, test: 'nav-settings' }, 0)}
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
