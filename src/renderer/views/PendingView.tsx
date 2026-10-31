import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { CampaignView, ClipView } from '../../core/api'
import { filterClips, sortClips, type ClipSort } from '../../core/format'
import { ClipCard } from '../components/ClipCard'
import { ClipTable } from '../components/ClipTable'
import { Empty } from '../components/Common'
import { CampaignChips, useVista, ViewToggle } from '../components/Library'
import { PageHeader } from '../components/PageHeader'

/** Lo que se recuerda mientras la aplicación está abierta, para volver de un clip al mismo sitio. */
const recuerdo: { campaña: string; orden: ClipSort; scroll: number } = { campaña: '', orden: 'score', scroll: 0 }

/**
 * Pendientes: clips sin publicar de campañas abiertas, en cuadrícula de tarjetas (o en lista).
 * Solo lee; lo único que se puede hacer aquí es buscar, filtrar, ordenar y abrir un clip.
 */
export function PendingView(props: { campaigns: CampaignView[]; search: string; refresh: number; onSearch: (search: string) => void; onOpen: (clipId: string) => void }) {
  const [clips, setClips] = useState<ClipView[] | null>(null)
  const [vista, elegirVista] = useVista('cos.pendientes.vista')
  const [campaña, setCampaña] = useState(recuerdo.campaña)
  const [orden, setOrden] = useState<ClipSort>(recuerdo.orden)

  useEffect(() => {
    let vivo = true
    void window.contentOS.listClips(null).then((l) => vivo && setClips(l))
    return () => {
      vivo = false
    }
  }, [props.refresh])

  const info = useMemo(() => new Map(props.campaigns.map((c) => [c.campaignId, c])), [props.campaigns])
  const pendientes = useMemo(() => (clips ? filterClips(clips, 'pending') : []), [clips])
  // campañas con algo pendiente: primero las que acaban antes
  const grupos = useMemo(() => {
    const n = new Map<string, number>()
    for (const k of pendientes) n.set(k.campaignId, (n.get(k.campaignId) ?? 0) + 1)
    return [...n].map(([id, total]) => ({ id, total, nombre: info.get(id)?.displayName ?? id, dias: info.get(id)?.daysLeft ?? null }))
      .sort((a, b) => (a.dias ?? 9999) - (b.dias ?? 9999) || a.nombre.localeCompare(b.nombre))
  }, [pendientes, info])
  const elegida = grupos.some((g) => g.id === campaña) ? campaña : ''
  const visibles = useMemo(
    () => sortClips(filterClips(elegida ? pendientes.filter((k) => k.campaignId === elegida) : pendientes, 'all', props.search), orden),
    [pendientes, elegida, props.search, orden]
  )

  // al volver de un clip, la pantalla queda donde estaba
  useLayoutEffect(() => {
    if (clips && recuerdo.scroll > 0) document.querySelector('.main')?.scrollTo(0, recuerdo.scroll)
  }, [clips === null])

  const elegirCampaña = (id: string) => {
    recuerdo.campaña = id
    recuerdo.scroll = 0
    setCampaña(id)
  }
  const elegirOrden = (o: ClipSort) => {
    recuerdo.orden = o
    setOrden(o)
  }
  const abrir = (clipId: string) => {
    recuerdo.scroll = document.querySelector('.main')?.scrollTop ?? 0
    props.onOpen(clipId)
  }
  const filtrando = !!elegida || !!props.search.trim()

  return (
    <>
      <PageHeader title="Pendientes" titleTest="list-title" meta={
        <span data-test="list-count">{clips === null ? 'Cargando…' : filtrando ? `${visibles.length} de ${pendientes.length} sin publicar` : `${pendientes.length} sin publicar`}</span>
      }>
        <input className="search hsearch" data-test="search" placeholder="Buscar por título" value={props.search} onChange={(e) => props.onSearch(e.target.value)} />
        <select className="sel" data-test="pending-sort" value={orden} onChange={(e) => elegirOrden(e.target.value as ClipSort)} title="Ordenar">
          <option value="score">Mejor puntuación</option>
          <option value="date">Más recientes</option>
          <option value="name">Nombre (A–Z)</option>
        </select>
        <ViewToggle vista={vista} onChange={elegirVista} />
      </PageHeader>

      {pendientes.length > 0 && (
        <div className="lib-tools">
          <CampaignChips test="pending" grupos={grupos} total={pendientes.length} elegida={elegida} onChange={elegirCampaña} />
        </div>
      )}

      {clips === null ? (
        <div className="grid-clips" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <div key={i} className="ccard skeleton" style={{ aspectRatio: '9 / 19' }} />)}</div>
      ) : pendientes.length === 0 ? (
        <Empty title="No queda nada pendiente" test="empty-pending"><p>Todos los clips de las campañas abiertas están publicados.</p></Empty>
      ) : visibles.length === 0 ? (
        <Empty title="Ningún clip coincide" test="empty-search">
          <button className="btn" onClick={() => { props.onSearch(''); elegirCampaña('') }}>Quitar filtros</button>
        </Empty>
      ) : vista === 'grid' ? (
        <div className="grid-clips" data-test="clip-grid">
          {visibles.map((k) => <ClipCard key={k.clipId} clip={k} daysLeft={info.get(k.campaignId)?.daysLeft ?? null} onOpen={abrir} />)}
        </div>
      ) : (
        <ClipTable clips={visibles} onOpen={abrir} showCampaign />
      )}
    </>
  )
}
