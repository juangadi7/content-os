import type { ReactNode } from 'react'

/** Cabecera de pantalla: a la izquierda qué estás viendo, a la derecha lo que puedes hacer. */
export function PageHeader(props: { title: string; meta?: ReactNode; children?: ReactNode; titleTest?: string }) {
  return (
    <header className="phead">
      <div className="ptitle">
        <h1 data-test={props.titleTest}>{props.title}</h1>
        {props.meta != null && <div className="pmeta">{props.meta}</div>}
      </div>
      <span className="sp" />
      {props.children && <div className="pactions">{props.children}</div>}
    </header>
  )
}
