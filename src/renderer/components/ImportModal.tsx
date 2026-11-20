import { FolderOpen, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import type { ImportResult, OwnChannel, PickedVideo } from '../../core/api'
import { CANALES } from './Sidebar'

const mensaje = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const mb = (n: number) => `${Math.max(1, Math.round(n / 1_048_576))} MB`
const tituloDe = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()

interface Fila extends PickedVideo {
  channel: OwnChannel
  title: string
}

/**
 * «Añadir vídeos»: arrastra MP4 (o elige archivos o una carpeta), elige el canal de cada uno y su título.
 * La app los mete en la carpeta del canal; el archivo original no se mueve.
 */
export function ImportModal(props: { initial?: PickedVideo[]; channel?: OwnChannel; onClose: () => void; onImported: (channel: OwnChannel) => void }) {
  const canal0 = props.channel ?? 'gta'
  const aFilas = (vs: PickedVideo[], canal: OwnChannel): Fila[] => vs.map((v) => ({ ...v, channel: canal, title: tituloDe(v.name) }))
  const [filas, setFilas] = useState<Fila[]>(() => aFilas(props.initial ?? [], canal0))
  const [encima, setEncima] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<ImportResult | null>(null)

  const añadir = (vs: PickedVideo[]) => {
    setHecho(null)
    setFilas((f) => [...f, ...aFilas(vs.filter((v) => !f.some((x) => x.path === v.path)), f.at(-1)?.channel ?? canal0)])
  }
  const elegir = async (modo: 'files' | 'folder') => {
    try {
      añadir(await window.contentOS.pickVideos(modo))
    } catch (e) {
      setError(mensaje(e))
    }
  }
  const soltar = async (e: React.DragEvent) => {
    e.preventDefault()
    setEncima(false)
    const rutas = Array.from(e.dataTransfer.files).map((f) => window.contentOS.pathForFile(f)).filter(Boolean)
    const vs = await window.contentOS.listVideoFiles(rutas)
    if (!vs.length) setError('No hay vídeos MP4 en lo que has soltado.')
    else {
      setError(null)
      añadir(vs)
    }
  }
  const cambiar = (i: number, cambio: Partial<Fila>) => setFilas((f) => f.map((x, j) => (j === i ? { ...x, ...cambio } : x)))

  const importar = async () => {
    setBusy(true)
    setError(null)
    const res: ImportResult = { created: [], skipped: [] }
    try {
      for (const c of CANALES.map((x) => x.id)) {
        const suyas = filas.filter((f) => f.channel === c)
        if (!suyas.length) continue
        const r = await window.contentOS.importVideos(c, suyas.map((f) => ({ path: f.path, title: f.title })))
        res.created.push(...r.created)
        res.skipped.push(...r.skipped)
      }
      setHecho(res)
      setFilas([])
      const ultimo = filas.at(-1)?.channel
      if (res.created.length && ultimo) props.onImported(ultimo)
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal glass importm" data-test="import-modal">
        <h2><Upload size={18} /> Añadir vídeos</h2>
        <div className={`drop ${encima ? 'over' : ''}`} data-test="import-drop"
          onDragOver={(e) => { e.preventDefault(); setEncima(true) }} onDragLeave={() => setEncima(false)} onDrop={(e) => void soltar(e)}>
          <span>Arrastra aquí los MP4</span>
          <span className="faint small">o</span>
          <div className="drop-btns">
            <button className="btn small" data-test="import-pick-files" onClick={() => void elegir('files')}><Upload size={13} />Elegir vídeos</button>
            <button className="btn small" data-test="import-pick-folder" onClick={() => void elegir('folder')}><FolderOpen size={13} />Elegir carpeta</button>
          </div>
        </div>

        {filas.length > 0 && (
          <div className="ifilas" data-test="import-rows">
            {filas.map((f, i) => (
              <div key={f.path} className="ifila">
                <span className="ell small" title={f.path}>{f.name}<span className="faint"> · {mb(f.sizeBytes)}</span></span>
                <select value={f.channel} onChange={(e) => cambiar(i, { channel: e.target.value as OwnChannel })} data-test="import-channel">
                  {CANALES.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
                <input value={f.title} placeholder="Título" onChange={(e) => cambiar(i, { title: e.target.value })} data-test="import-title" />
                <button className="btn small ghost" title="Quitar de la lista" onClick={() => setFilas((x) => x.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {hecho && (
          <div className="small" data-test="import-result">
            {hecho.created.length > 0 && <p className="ok">Añadidos {hecho.created.length} {hecho.created.length === 1 ? 'vídeo' : 'vídeos'}. El original sigue donde estaba.</p>}
            {hecho.skipped.map((s) => <p key={s.path} className="warn">{s.path.split(/[\\/]/).pop()}: {s.reason}</p>)}
          </div>
        )}
        {error && <p className="bad small" data-test="import-error">{error}</p>}
        <p className="faint small">Cada vídeo va a su propia carpeta dentro del canal, con su título. No se copia dos veces: si está en el mismo disco, se enlaza.</p>
        <div className="foot">
          <span className="sp" />
          <button className="btn ghost" onClick={props.onClose}>{hecho ? 'Cerrar' : 'Cancelar'}</button>
          <button className="btn primary" data-test="import-go" disabled={busy || filas.length === 0 || filas.some((f) => !f.title.trim())} onClick={() => void importar()}>
            {busy ? 'Añadiendo…' : `Añadir ${filas.length || ''} ${filas.length === 1 ? 'vídeo' : 'vídeos'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
