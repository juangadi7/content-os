/** Visitas ganadas por día: solo entre mediciones reales y sin contar como subida lo que se mide por primera vez. */
import { describe, expect, it } from 'vitest'
import { dailyGains, gainBetween, type SeriesPoint } from '../src/core/stats-series'

const p = (publicationId: number, day: string, hour: number, views: number): SeriesPoint => ({ publicationId, t: new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString(), views })

describe('visitas ganadas por día', () => {
  it('compara cada día con el anterior medido y ordena los vídeos por lo que ganaron', () => {
    const g = dailyGains([
      p(1, '2026-10-01', 10, 100), p(2, '2026-10-01', 10, 50),
      p(1, '2026-10-02', 9, 130), p(1, '2026-10-02', 21, 160), p(2, '2026-10-02', 21, 55),
      p(3, '2026-10-02', 21, 900) // primera medición: no es una subida
    ])
    expect(g).toEqual([{ day: '2026-10-02', fromDay: '2026-10-01', span: 1, gain: 65, videos: 2, top: [{ publicationId: 1, gain: 60 }, { publicationId: 2, gain: 5 }] }])
  })

  it('si la aplicación estuvo cerrada, la ganancia cubre varios días y lo dice', () => {
    const g = dailyGains([p(1, '2026-10-01', 10, 100), p(1, '2026-10-04', 10, 400), p(1, '2026-10-05', 10, 450)])
    expect(g.map((x) => [x.day, x.span, x.gain])).toEqual([['2026-10-04', 3, 300], ['2026-10-05', 1, 50]])
    expect(gainBetween(g, '2026-10-05', '2026-10-05')).toBe(50)
    expect(gainBetween(g, '2026-10-01', '2026-10-31')).toBe(350)
  })

  it('con un solo día, o filtrando vídeos que no están, no hay nada que comparar', () => {
    expect(dailyGains([p(1, '2026-10-01', 10, 100)])).toEqual([])
    expect(dailyGains([p(1, '2026-10-01', 10, 100), p(1, '2026-10-02', 10, 120)], new Set([9]))).toEqual([])
  })
})
