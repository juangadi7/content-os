import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { CampaignView, ClipView } from '../../core/api'
import { CLIP_STATE_LABEL, CLIP_STATES, clipStateKey, filterLibrary, PLATFORM_LABEL, PLATFORMS, sortClips, type ClipSort, type ClipStateKey, type Platform } from '../../core/format'
import { ClipCard } from '../components/ClipCard'
import { ClipTable } from '../components/ClipTable'
import { Empty } from '../components/Common'
import { CampaignChips, useVista, ViewToggle } from '../components/Library'
import { PageHeader } from '../components/PageHeader'

/** Lo que se recuerda mientras la aplicación está abierta, para volver de un clip al mismo sitio. */
const recuerdo: { campaña: string; plataforma: Platform | ''; estado: ClipStateKey | ''; orden: ClipSort; scroll: number } = { campaña: '', plataforma: '', estado: '', orden: 'score', scroll: 0 }

/**
 * Todos los clips de las campañas activas, uno por clip (esté o no publicado, y en las plataformas que sea).
 * Los de campañas terminadas no salen: siguen en su campaña y en Publicados.
 * Solo lee: buscar, filtrar, ordenar y abrir.
 */
export function AllClipsView(props: { campaigns: CampaignView[]; search: string; refresh: number; onSearch: (search: string) => void; onOpen: (clipId: string) => void }) {
  const [clips, setClips] = useState<ClipView[] | null>(null)
  const [vista, elegirVista] = useVista('cos.todos.vista')
  const [campaña, setCampaña] = useState(recuerdo.campaña)
  const [plataforma, setPlataforma] = useState<Platform | ''>(recuerdo.plataforma)
  const [estado, setEstado] = useState<ClipStateKey | ''>(recuerdo.estado)
  const [orden, setOrden] = useState<ClipSort>(recuerdo.orden)

  useEffect(() => {
    let vivo = true
    void window.contentOS.listClips(null).then((l) => vivo && setClips(l))
    return () => {
      vivo = false
    }
  }, [props.refresh])

  const todos = useMemo(() => (clips ?? []).filter((k) => !k.campaignClosed), [clips])
  const info = useMemo(() => new Map(props.campaigns.map((c) => [c.campaignId, c])), [props.campaigns])
  // campañas: primero las abiertas (la que acaba antes delante), después las cerradas
  const grupos = useMemo(() => {
    const n = new Map<string, { nombre: string; total: number }>()
    for (const k of todos) n.set(k.campaignId, { nombre: k.campaignName, total: (n.get(k.campaignId)?.total ?? 0) + 1 })
    return [...n].map(([id, v]) => ({ id, ...v, dias: info.get(id)?.daysLeft ?? null, cerrada: info.get(id)?.closed ?? false }))
      .sort((a, b) => Number(a.cerrada) - Number(b.cerrada) || (a.dias ?? 9999) - (b.dias ?? 9999) || a.nombre.localeCompare(b.nombre))
  }, [todos, info])
  // solo se ofrecen las plataformas y los estados que existen ahora mismo
  const plataformas = useMemo(() => PLATFORMS.filter((p) => todos.some((k) => k.published.includes(p))), [todos])
  const estados = useMemo(() => CLIP_STATES.map((e) => ({ e, total: todos.filter((k) => clipStateKey(k) === e).length })).filter((x) => x.total > 0), [todos])

  const elegida = grupos.some((g) => g.id === campaña) ? campaña : ''
  const enPlataforma = plataformas.includes(plataforma as Platform) ? plataforma : ''
  const enEstado = estados.some((x) => x.e === estado) ? estado : ''
  const visibles = useMemo(
    () => sortClips(filterLibrary(todos, { campaignId: elegida, platform: enPlataforma, state: enEstado, search: props.search }), orden),
    [todos, elegida, enPlataforma, enEstado, props.search, orden]
  )

  useLayoutEffect(() => {
    if (clips && recuerdo.scroll > 0) document.querySelector('.main')?.scrollTo(0, recuerdo.scroll)
  }, [clips === null])

  const cambiar = <K extends keyof typeof recuerdo>(clave: K, valor: (typeof recuerdo)[K]) => {
    recuerdo[clave] = valor
    recuerdo.scroll = 0
  }
  const abrir = (clipId: string) => {
    recuerdo.scroll = document.querySelector('.main')?.scrollTop ?? 0
    props.onOpen(clipId)
  }
  const quitarFiltros = () => {
    cambiar('campaña', ''); cambiar('plataforma', ''); cambiar('estado', '')
    setCampaña(''); setPlataforma(''); setEstado('')
    props.onSearch('')
  }
  const filtrando = !!elegida || !!enPlataforma || !!enEstado || !!props.search.trim()

  return (
    <>
      <PageHeader title="Todos los clips" titleTest="list-title" meta={
        <span data-test="list-count">{clips === null ? 'Cargando…' : filtrando ? `${visibles.length} de ${todos.length} clips` : `${todos.length} ${todos.length === 1 ? 'clip' : 'clips'}`}</span>
      }>
        {todos.length > 0 && (
          <>
            <input className="search hsearch narrow" data-test="search" placeholder="Buscar por título" value={props.search} onChange={(e) => props.onSearch(e.target.value)} />
            {estados.length > 1 && (
              <select className="sel" data-test="all-state" value={enEstado} onChange={(e) => { cambiar('estado', e.target.value as ClipStateKey | ''); setEstado(e.target.value as ClipStateKey | '') }} title="Estado">
                <option value="">Estado: todos</option>
                {estados.map(({ e, total }) => <option key={e} value={e}>{CLIP_STATE_LABEL[e]} ({total})</option>)}
              </select>
            )}
            {plataformas.length > 0 && (
              <select className="sel" data-test="all-platform" value={enPlataforma} onChange={(e) => { cambiar('plataforma', e.target.value as Platform | ''); setPlataforma(e.target.value as Platform | '') }} title="Publicados en…">
                <option value="">Plataforma: todas</option>
                {plataformas.map((p) => <option key={p} value={p}>En {PLATFORM_LABEL[p]}</option>)}
              </select>
            )}
            <select className="sel" data-test="all-sort" value={orden} onChange={(e) => { recuerdo.orden = e.target.value as ClipSort; setOrden(e.target.value as ClipSort) }} title="Ordenar">
              <option value="score">Mejor puntuación</option>
              <option value="date">Más recientes</option>
              <option value="name">Nombre (A–Z)</option>
            </select>
            <ViewToggle vista={vista} onChange={elegirVista} />
          </>
        )}
      </PageHeader>

      {grupos.length > 1 && (
        <div className="lib-tools">
          <CampaignChips test="all" grupos={grupos} total={todos.length} elegida={elegida} onChange={(id) => { cambiar('campaña', id); setCampaña(id) }} />
        </div>
      )}

      {clips === null ? (
        <div className="grid-clips" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <div key={i} className="ccard skeleton" style={{ aspectRatio: '9 / 19' }} />)}</div>
      ) : todos.length === 0 ? (
        <Empty title="Todavía no hay clips" test="empty-no-clips"><p>Cuando el generador termine una campaña, sincroniza para verla aquí.</p></Empty>
      ) : visibles.length === 0 ? (
        <Empty title="Ningún clip coincide" test="empty-search">
          <button className="btn" onClick={quitarFiltros}>Quitar filtros</button>
        </Empty>
      ) : vista === 'grid' ? (
        <div className="grid-clips" data-test="clip-grid">
          {visibles.map((k) => <ClipCard key={k.clipId} clip={k} daysLeft={k.published.length === 0 ? info.get(k.campaignId)?.daysLeft ?? null : null} onOpen={abrir} />)}
        </div>
      ) : (
        <ClipTable clips={visibles} onOpen={abrir} showCampaign />
      )}
    </>
  )
}
