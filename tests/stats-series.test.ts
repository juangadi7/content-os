/** Evolución temporal: solo mediciones reales, sin inventar ni interpolar. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { deletePublication, savePublication } from '../src/core/publications'
import { comparableDelta, dailyTotals, getStatsSeries, localDay, seriesByPublication, type SeriesPoint } from '../src/core/stats-series'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

let base: string
let root: string
let db: DB
const at = (dia: number, hora: number, min = 0) => new Date(2026, 9, dia, hora, min).toISOString()
const medir = (pub: number, t: string, views: number | null) =>
  db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, origin) VALUES (?, ?, ?, 'prueba')").run(pub, t, views)

beforeEach(() => {
  base = tmpDir('cos_series_')
  root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const c = new CampaignFixture(root, 'DEMO', 'demo', 'Demo')
  ;[1, 2, 3].forEach((n) => c.addClip({ n, clipId: `clp_${n}` }))
  syncLibraries(db, { roots: [root] })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('evolución de las mediciones', () => {
  it('sin mediciones no hay nada que dibujar', () => {
    expect(getStatsSeries(db)).toEqual([])
    expect(dailyTotals([])).toEqual([])
    expect(comparableDelta([])).toBeNull()
  })

  it('devuelve mediciones reales: como mucho una por vídeo y hora, la última, e ignora las que no traen visitas', () => {
    const a = savePublication(db, { clipId: 'clp_1', platform: 'youtube', account: '@c' })
    medir(a, at(8, 10, 0), 100)
    medir(a, at(8, 10, 15), 130)
    medir(a, at(8, 10, 45), 180) // misma hora: se queda esta
    medir(a, at(8, 11, 5), 200)
    medir(a, at(8, 12, 0), null) // medición sin cifra: no es un cero
    const s = getStatsSeries(db)
    expect(s.map((p) => p.views)).toEqual([180, 200])
    expect(s[0]).toEqual({ publicationId: a, t: at(8, 10, 45), views: 180 })
    // una publicación quitada deja de contar
    const b = savePublication(db, { clipId: 'clp_2', platform: 'youtube', account: '@c' })
    deletePublication(db, b)
    expect(new Set(getStatsSeries(db).map((p) => p.publicationId))).toEqual(new Set([a]))
  })

  it('total por día = última medición conocida de cada vídeo; solo existen los días con mediciones', () => {
    const p: SeriesPoint[] = [
      { publicationId: 1, t: at(5, 12), views: 100 },
      { publicationId: 1, t: at(5, 20), views: 400 },
      { publicationId: 1, t: at(6, 9), views: 900 },
      { publicationId: 2, t: at(6, 10), views: 50 }, // se mide por primera vez el día 6
      // el día 7 no se abrió la aplicación: no hay punto
      { publicationId: 2, t: at(8, 23), views: 80 }
    ]
    expect(dailyTotals(p)).toEqual([
      { day: '2026-10-05', views: 400, videos: 1, gapBefore: false },
      { day: '2026-10-06', views: 950, videos: 2, gapBefore: false },
      { day: '2026-10-08', views: 980, videos: 2, gapBefore: true } // el vídeo 1 conserva su última cifra (900)
    ])
    expect(dailyTotals(p, new Set([2]))).toEqual([
      { day: '2026-10-06', views: 50, videos: 1, gapBefore: false },
      { day: '2026-10-08', views: 80, videos: 1, gapBefore: true }
    ])
    expect(localDay(at(8, 23))).toBe('2026-10-08')
    expect(seriesByPublication(p).get(1)!.map((x) => x.views)).toEqual([100, 400, 900])
  })

  it('la variación solo cuenta vídeos medidos en los dos días, y no existe con un solo día', () => {
    const unDia: SeriesPoint[] = [{ publicationId: 1, t: at(8, 10), views: 100 }, { publicationId: 1, t: at(8, 18), views: 300 }]
    expect(comparableDelta(unDia)).toBeNull()
    const p: SeriesPoint[] = [
      { publicationId: 1, t: at(7, 12), views: 1000 },
      { publicationId: 1, t: at(8, 12), views: 1400 },
      { publicationId: 2, t: at(8, 13), views: 5000 } // nuevo el día 8: sus 5.000 no son «subida»
    ]
    expect(comparableDelta(p)).toEqual({ fromDay: '2026-10-07', toDay: '2026-10-08', delta: 400, videos: 1 })
    // un vídeo que no se volvió a medir el segundo día aporta cero, no negativo
    expect(comparableDelta([...p, { publicationId: 3, t: at(7, 9), views: 70 }])).toEqual({ fromDay: '2026-10-07', toDay: '2026-10-08', delta: 400, videos: 2 })
  })

  it('leer la evolución no escribe nada', () => {
    const a = savePublication(db, { clipId: 'clp_1', platform: 'youtube', account: '@c' })
    medir(a, at(8, 10), 100)
    const antes = fingerprint(root)
    const filas = (db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get() as { n: number }).n
    getStatsSeries(db)
    expect((db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get() as { n: number }).n).toBe(filas)
    expect(fingerprint(root)).toEqual(antes)
  })
})
