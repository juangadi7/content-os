import { LayoutGrid, List } from 'lucide-react'
import { useState } from 'react'

/** Piezas que comparten las pantallas de biblioteca (Pendientes, Publicados). */

export type Vista = 'grid' | 'list'

/**
 * Recuerda si una pantalla se ve en cuadrícula o en lista. Es una preferencia de pantalla, no un dato
 * de negocio: se guarda en el almacenamiento del navegador de la app, cada pantalla con su clave.
 */
export function useVista(clave: string): [Vista, (v: Vista) => void] {
  const [vista, setVista] = useState<Vista>(() => {
    try {
      return window.localStorage.getItem(clave) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  return [vista, (v) => {
    setVista(v)
    try {
      window.localStorage.setItem(clave, v)
    } catch {
      /* sin almacenamiento: se queda para esta sesión */
    }
  }]
}

/** Selector cuadrícula / lista. */
export function ViewToggle({ vista, onChange }: { vista: Vista; onChange: (v: Vista) => void }) {
  return (
    <div className="seg" role="group" aria-label="Forma de ver los clips">
      <button className={vista === 'grid' ? 'on' : ''} data-test="view-grid" onClick={() => onChange('grid')} title="Cuadrícula" aria-pressed={vista === 'grid'}><LayoutGrid size={15} /></button>
      <button className={vista === 'list' ? 'on' : ''} data-test="view-list" onClick={() => onChange('list')} title="Lista" aria-pressed={vista === 'list'}><List size={15} /></button>
    </div>
  )
}

/** Fila de chips para filtrar por campaña. `grupos` llega ya ordenado. */
export function CampaignChips(props: { grupos: { id: string; nombre: string; total: number; dias?: number | null }[]; total: number; elegida: string; onChange: (id: string) => void; test: string }) {
  return (
    <div className="lib-chips" data-test={`${props.test}-campaigns`}>
      <button className={`fchip ${props.elegida === '' ? 'on' : ''}`} data-campaign="" onClick={() => props.onChange('')}>Todas<i>{props.total}</i></button>
      {props.grupos.map((g) => (
        <button key={g.id} className={`fchip ${props.elegida === g.id ? 'on' : ''}`} data-test={`${props.test}-campaign`} data-campaign={g.id} onClick={() => props.onChange(g.id)}
          title={g.dias != null ? `Quedan ${g.dias} ${g.dias === 1 ? 'día' : 'días'}` : undefined}>
          <span>{g.nombre}</span><i>{g.total}</i>{g.dias != null && g.dias <= 3 && <b className="dot-w" />}
        </button>
      ))}
    </div>
  )
}
