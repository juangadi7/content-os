import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { PublishedRow } from '../../core/api'
import { formatCount, groupPublished, PLATFORM_LABEL, PLATFORMS, relativeTime, scoreLabel, sortPublished, type Platform, type PublishedSort } from '../../core/format'
import { ClipCard } from '../components/ClipCard'
import { Empty, Thumb } from '../components/Common'
import { CampaignChips, useVista, ViewToggle } from '../components/Library'
import { PageHeader } from '../components/PageHeader'

const fechaHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '—')
const dia = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : null)

/** Lo que se recuerda mientras la aplicación está abierta, para volver de un clip al mismo sitio. */
const recuerdo: { campaña: string; plataforma: Platform | ''; orden: PublishedSort; busqueda: string; scroll: number } = { campaña: '', plataforma: '', orden: 'recent', busqueda: '', scroll: 0 }

/**
 * Publicados. En cuadrícula, una tarjeta por CLIP con las plataformas donde está; en lista, una fila
 * por PUBLICACIÓN con su cuenta, fecha, URL y cifras. Los datos son los mismos: solo cambia cómo se agrupan.
 */
export function PublishedView({ refresh, onOpen }: { refresh: number; onOpen: (clipId: string) => void }) {
  const [rows, setRows] = useState<PublishedRow[] | null>(null)
  const [vista, elegirVista] = useVista('cos.publicados.vista')
  const [campaña, setCampaña] = useState(recuerdo.campaña)
  const [plataforma, setPlataforma] = useState<Platform | ''>(recuerdo.plataforma)
  const [orden, setOrden] = useState<PublishedSort>(recuerdo.orden)
  const [busqueda, setBusqueda] = useState(recuerdo.busqueda)

  useEffect(() => {
    let vivo = true
    void window.contentOS.listPublished().then((r) => vivo && setRows(r))
    return () => {
      vivo = false
    }
  }, [refresh])

  const todos = useMemo(() => groupPublished(rows ?? []), [rows])
  const plataformas = useMemo(() => PLATFORMS.filter((p) => (rows ?? []).some((r) => r.publication.platform === p)), [rows])
  const grupos = useMemo(() => {
    const n = new Map<string, { nombre: string; total: number }>()
    for (const g of todos) n.set(g.clip.campaignId, { nombre: g.clip.campaignName, total: (n.get(g.clip.campaignId)?.total ?? 0) + 1 })
    return [...n].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre))
  }, [todos])
  const elegida = grupos.some((g) => g.id === campaña) ? campaña : ''
  const enPlataforma = plataformas.includes(plataforma as Platform) ? plataforma : ''
  const q = busqueda.trim().toLowerCase()
  // filtros: se aplican igual a las tarjetas (por clip) y a las filas (por publicación)
  const pasaClip = (k: PublishedRow['clip']) => (!elegida || k.campaignId === elegida) && (!q || (k.title ?? k.filename ?? '').toLowerCase().includes(q))
  const visibles = useMemo(
    () => sortPublished(todos.filter((g) => pasaClip(g.clip) && (!enPlataforma || g.publications.some((p) => p.platform === enPlataforma))), orden),
    [todos, elegida, enPlataforma, q, orden]
  )
  const filas = useMemo(() => {
    const puesto = new Map(visibles.map((g, i) => [g.clip.clipId, i]))
    return (rows ?? []).filter((r) => puesto.has(r.clip.clipId) && (!enPlataforma || r.publication.platform === enPlataforma))
      .sort((a, b) => (orden === 'recent' ? 0 : puesto.get(a.clip.clipId)! - puesto.get(b.clip.clipId)!))
  }, [rows, visibles, enPlataforma, orden])

  useLayoutEffect(() => {
    if (rows && recuerdo.scroll > 0) document.querySelector('.main')?.scrollTo(0, recuerdo.scroll)
  }, [rows === null])

  const abrir = (clipId: string) => {
    recuerdo.scroll = document.querySelector('.main')?.scrollTop ?? 0
    onOpen(clipId)
  }
  const cambiar = <K extends keyof typeof recuerdo>(clave: K, valor: (typeof recuerdo)[K]) => {
    recuerdo[clave] = valor
    recuerdo.scroll = 0
  }
  const filtrando = !!elegida || !!enPlataforma || !!q
  const nPubs = rows?.length ?? 0

  return (
    <>
      <PageHeader title="Publicados" meta={
        <span data-test="published-count">
          {rows === null ? 'Cargando…' : nPubs === 0 ? 'Sin publicaciones' : `${filtrando ? `${visibles.length} de ${todos.length}` : todos.length} ${todos.length === 1 ? 'clip' : 'clips'} · ${nPubs} ${nPubs === 1 ? 'publicación' : 'publicaciones'}`}
        </span>
      }>
        {nPubs > 0 && (
          <>
            <input className="search hsearch" data-test="published-search" placeholder="Buscar por título" value={busqueda} onChange={(e) => { cambiar('busqueda', e.target.value); setBusqueda(e.target.value) }} />
            {plataformas.length > 1 && (
              <select className="sel" data-test="published-platform" value={enPlataforma} onChange={(e) => { cambiar('plataforma', e.target.value as Platform | ''); setPlataforma(e.target.value as Platform | '') }} title="Plataforma">
                <option value="">Todas las plataformas</option>
                {plataformas.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
              </select>
            )}
            <select className="sel" data-test="published-sort" value={orden} onChange={(e) => { cambiar('orden', e.target.value as PublishedSort); setOrden(e.target.value as PublishedSort) }} title="Ordenar">
              <option value="recent">Más recientes</option>
              <option value="views">Más visitas</option>
              <option value="score">Mejor puntuación</option>
              <option value="name">Nombre (A–Z)</option>
            </select>
            <ViewToggle vista={vista} onChange={elegirVista} />
          </>
        )}
      </PageHeader>

      {grupos.length > 1 && (
        <div className="lib-tools">
          <CampaignChips test="published" grupos={grupos} total={todos.length} elegida={elegida} onChange={(id) => { cambiar('campaña', id); setCampaña(id) }} />
        </div>
      )}

      {rows === null ? (
        <div className="grid-clips" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="ccard skeleton" style={{ aspectRatio: '9 / 19' }} />)}</div>
      ) : nPubs === 0 ? (
        <Empty title="Todavía no hay publicaciones" test="empty-no-publications">
          <p>Cuando subas un clip, ábrelo aquí y pulsa «Marcar publicado».</p>
        </Empty>
      ) : visibles.length === 0 ? (
        <Empty title="Ningún clip coincide" test="empty-search">
          <button className="btn" onClick={() => { cambiar('campaña', ''); cambiar('plataforma', ''); cambiar('busqueda', ''); setCampaña(''); setPlataforma(''); setBusqueda('') }}>Quitar filtros</button>
        </Empty>
      ) : vista === 'grid' ? (
        <div className="grid-clips" data-test="published-grid">
          {visibles.map((g) => (
            <ClipCard key={g.clip.clipId} clip={g.clip} test="published-row" onOpen={abrir} meta={
              <>
                {dia(g.lastPublishedAt) ?? 'Sin fecha'}
                {' · '}
                {g.views != null ? <><b>{formatCount(g.views)}</b> {g.views === 1 ? 'visita' : 'visitas'}</> : 'sin medir'}
                {g.publications.length > 1 && ` · ${g.publications.length} publicaciones`}
              </>
            } />
          ))}
        </div>
      ) : (
        <div className="rows" data-test="published-rows">
          <div className="row hdr cols-pub">
            <span />
            <span>Clip</span>
            <span>Campaña</span>
            <span>Plataforma</span>
            <span>Fecha</span>
            <span>URL</span>
            <span className="num">Visitas</span>
            <span className="num">Likes</span>
            <span className="num">Score</span>
          </div>
          {filas.map(({ publication: p, clip: k }) => (
            <div key={p.id} className="row cols-pub" role="button" tabIndex={0} data-test="published-row" data-clip={k.clipId}
              onClick={() => abrir(k.clipId)} onKeyDown={(e) => e.key === 'Enter' && abrir(k.clipId)}>
              <Thumb clip={k} />
              <span className="ell">{k.title ?? k.filename ?? k.clipId}</span>
              <span className="ell muted">{k.campaignName}</span>
              <span className="ell">{PLATFORM_LABEL[p.platform]}{p.account ? <span className="muted"> · {p.account}</span> : null}</span>
              <span className="muted">{fechaHora(p.publishedAt)}</span>
              <span className="ell">
                {p.url ? <a className="ext" href={p.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{p.url}</a> : <span className="faint">—</span>}
              </span>
              <span className={`num ${p.latest ? '' : 'faint'}`} data-test="pub-views" title={p.latest ? `Medido ${relativeTime(p.latest.measuredAt)}` : 'Sin medir'}>{formatCount(p.latest?.views)}</span>
              <span className="num muted">{formatCount(p.latest?.likes)}</span>
              <span className={`num ${k.score == null ? 'faint' : ''}`}>{scoreLabel(k.score)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
