import { useState } from 'react'
import type { AppState, SocialPlatform } from '../../core/api'
import { ChannelsView } from './ChannelsView'
import { SocialChannelsView } from './SocialChannelsView'

type Plataforma = 'youtube' | SocialPlatform
const PESTANAS: { id: Plataforma; texto: string }[] = [
  { id: 'youtube', texto: 'YouTube' },
  { id: 'tiktok', texto: 'TikTok' },
  { id: 'instagram', texto: 'Instagram' }
]
const GUARDADA = 'cos.canales.plataforma'

/** «Canales» separado por plataforma: YouTube (como siempre), TikTok e Instagram. */
export function CanalesView(props: { state: AppState; refresh: number; onOpen: (clipId: string) => void; onYouTube: () => void; onChanged: () => void }) {
  const [plat, setPlat] = useState<Plataforma>(() => {
    try {
      const v = localStorage.getItem(GUARDADA)
      return v === 'tiktok' || v === 'instagram' ? v : 'youtube'
    } catch {
      return 'youtube'
    }
  })
  const elegir = (p: Plataforma) => {
    setPlat(p)
    try {
      localStorage.setItem(GUARDADA, p)
    } catch {
      /* sin almacenamiento: solo no se recuerda */
    }
  }
  const cuantas = (p: Plataforma) => (p === 'youtube' ? props.state.youtubeChannels.length : props.state.socialConnected.filter((c) => c.platform === p).length)
  return (
    <>
      <div className="plat-tabs" role="tablist" data-test="platform-tabs">
        {PESTANAS.map((t) => (
          <button key={t.id} role="tab" aria-selected={plat === t.id} className={`plat-tab ${t.id} ${plat === t.id ? 'on' : ''}`} data-test={`platform-${t.id}`} onClick={() => elegir(t.id)}>
            <i className="dot" />{t.texto}<span className="n">{cuantas(t.id)}</span>
          </button>
        ))}
      </div>
      {plat === 'youtube'
        ? <ChannelsView state={props.state} refresh={props.refresh} onOpen={props.onOpen} onYouTube={props.onYouTube} onChanged={props.onChanged} />
        : <SocialChannelsView key={plat} platform={plat} state={props.state} refresh={props.refresh} onOpen={props.onOpen} onChanged={props.onChanged} />}
    </>
  )
}
