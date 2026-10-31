/** YouTube: lectura de URL, llamada a la API (simulada, sin red) y mediciones guardadas. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { latestSnapshot, listSnapshots, refreshYouTubeStats } from '../src/core/analytics'
import { openDatabase, type DB } from '../src/core/db'
import { formatCount } from '../src/core/format'
import { syncLibraries } from '../src/core/importer'
import { savePublication } from '../src/core/publications'
import { getClip, listPublished } from '../src/core/queries'
import { fetchVideoStats, parseYouTubeVideoId, YouTubeApiError, type FetchLike } from '../src/core/youtube'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

type Row = Record<string, any>
const ID1 = 'dQw4w9WgXcQ'
const ID2 = 'jNQXAC9IVRw'
const ID3 = 'aaaaaaaaaaa'

/** YouTube de mentira: devuelve las cifras que se le den y apunta cada petición. */
function fakeYouTube(stats: Record<string, { viewCount?: string; likeCount?: string; commentCount?: string }>) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const ids = new URL(url).searchParams.get('id')!.split(',')
    return { ok: true, status: 200, json: async () => ({ items: ids.filter((i) => stats[i]).map((i) => ({ id: i, statistics: stats[i] })) }) }
  }
  return { fetchImpl, calls, stats }
}
const fallo = (status: number, body: unknown): FetchLike => async () => ({ ok: false, status, json: async () => body })

describe('URL de YouTube', () => {
  it('reconoce Shorts, watch, youtu.be, embed y live', () => {
    expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${ID1}`)).toBe(ID1)
    expect(parseYouTubeVideoId(`https://youtube.com/shorts/${ID1}?feature=share`)).toBe(ID1)
    expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${ID1}&t=12s`)).toBe(ID1)
    expect(parseYouTubeVideoId(`https://m.youtube.com/watch?v=${ID1}`)).toBe(ID1)
    expect(parseYouTubeVideoId(`https://youtu.be/${ID1}?si=abc`)).toBe(ID1)
    expect(parseYouTubeVideoId(`https://www.youtube.com/embed/${ID1}`)).toBe(ID1)
    expect(parseYouTubeVideoId(`https://www.youtube.com/live/${ID1}`)).toBe(ID1)
    expect(parseYouTubeVideoId(`  https://youtu.be/${ID1}  `)).toBe(ID1)
  })

  it('rechaza lo que no es un vídeo de YouTube', () => {
    for (const u of [null, '', 'no es una url', 'https://www.tiktok.com/@x/video/123', 'https://www.youtube.com/@canal', 'https://www.youtube.com/shorts/corto',
      'https://evil.example/watch?v=' + ID1, 'https://youtube.com.evil.example/shorts/' + ID1, 'https://www.youtube.com/watch?v=demasiado-largo-para-ser-id']) {
      expect(parseYouTubeVideoId(u)).toBeNull()
    }
  })
})

describe('API de YouTube', () => {
  it('pide las cifras con la clave en una cabecera, nunca en la URL', async () => {
    const yt = fakeYouTube({ [ID1]: { viewCount: '12345', likeCount: '678', commentCount: '9' } })
    const r = await fetchVideoStats([ID1], 'CLAVE-SECRETA', yt.fetchImpl)
    expect(r.get(ID1)).toMatchObject({ views: 12345, likes: 678, comments: 9 })
    expect(yt.calls).toHaveLength(1)
    expect(yt.calls[0].url).not.toContain('CLAVE-SECRETA')
    expect(yt.calls[0].url).toContain('statistics')
    expect(yt.calls[0].headers['X-goog-api-key']).toBe('CLAVE-SECRETA')
  })

  it('likes ocultos o comentarios desactivados quedan en null, no en 0', async () => {
    const yt = fakeYouTube({ [ID1]: { viewCount: '50' } })
    expect((await fetchVideoStats([ID1], 'k', yt.fetchImpl)).get(ID1)).toMatchObject({ views: 50, likes: null, comments: null })
  })

  it('un vídeo privado o borrado simplemente no aparece', async () => {
    const yt = fakeYouTube({ [ID1]: { viewCount: '1' } })
    const r = await fetchVideoStats([ID1, ID2], 'k', yt.fetchImpl)
    expect([...r.keys()]).toEqual([ID1])
  })

  it('agrupa de 50 en 50 y no repite identificadores', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => 'v' + String(i).padStart(10, '0'))
    const yt = fakeYouTube(Object.fromEntries(ids.map((i) => [i, { viewCount: '1' }])))
    const r = await fetchVideoStats([...ids, ...ids, 'no-valido'], 'k', yt.fetchImpl)
    expect(r.size).toBe(120)
    expect(yt.calls).toHaveLength(3)
  })

  it('traduce los errores de la API a mensajes claros', async () => {
    const codigo = async (f: FetchLike) => fetchVideoStats([ID1], 'k', f).then(() => 'sin error', (e) => (e as YouTubeApiError).code)
    expect(await codigo(fallo(400, { error: { message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }] } }))).toBe('key_invalid')
    expect(await codigo(fallo(403, { error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } }))).toBe('quota')
    expect(await codigo(fallo(403, { error: { message: 'YouTube Data API v3 has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }))).toBe('api_disabled')
    expect(await codigo(fallo(500, { error: { message: 'Backend Error', errors: [{ reason: 'backendError' }] } }))).toBe('api')
    expect(await codigo(async () => { throw new Error('getaddrinfo ENOTFOUND') })).toBe('network')
  })
})

describe('mediciones', () => {
  let base: string
  let root: string
  let db: DB
  let tick = 0
  let minuto = 0
  const now = () => new Date(Date.UTC(2026, 5, 1, 12, minuto, tick++)).toISOString()
  const pub = (clipId: string, platform: 'youtube' | 'tiktok', url?: string) => savePublication(db, { clipId, platform, url }, now)

  beforeEach(() => {
    tick = 0
    minuto = 0
    base = tmpDir('cos_yt_')
    root = path.join(base, 'CAMPAIGNS')
    fs.mkdirSync(root, { recursive: true })
    db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
    const camp = new CampaignFixture(root, 'DEMO', 'demo', 'Demo')
    camp.addClip({ n: 1, clipId: 'clp_a', title: 'Primero' })
    camp.addClip({ n: 2, clipId: 'clp_b', title: 'Segundo' })
    camp.addClip({ n: 3, clipId: 'clp_c', title: 'Tercero' })
    syncLibraries(db, { roots: [root], now })
  })
  afterEach(() => {
    db.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('guarda una medición por cada publicación de YouTube con URL', async () => {
    const a = pub('clp_a', 'youtube', `https://www.youtube.com/shorts/${ID1}`)
    const b = pub('clp_b', 'youtube', `https://youtu.be/${ID2}`)
    pub('clp_c', 'youtube') // sin URL
    pub('clp_c', 'tiktok', 'https://www.tiktok.com/@x/video/1') // otra plataforma: no se toca
    const yt = fakeYouTube({ [ID1]: { viewCount: '1000', likeCount: '50', commentCount: '3' }, [ID2]: { viewCount: '20' } })

    const r = await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now })
    expect(r).toEqual({ publications: 3, measured: 2, skippedRecent: 0, withoutUrl: 1, notFound: 0 })
    expect(yt.calls).toHaveLength(1)
    expect(latestSnapshot(db, a)).toMatchObject({ views: 1000, likes: 50, comments: 3, origin: 'youtube_api' })
    expect(latestSnapshot(db, b)).toMatchObject({ views: 20, likes: null, comments: null })
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get()).toEqual({ n: 2 })
    expect(JSON.parse((db.prepare('SELECT raw_json FROM analytics_snapshots WHERE publication_id = ?').get(a) as Row).raw_json)).toEqual({ viewCount: '1000', likeCount: '50', commentCount: '3' })
  })

  it('cada medición es una fila nueva: no se pisa la anterior', async () => {
    const a = pub('clp_a', 'youtube', `https://www.youtube.com/shorts/${ID1}`)
    const yt = fakeYouTube({ [ID1]: { viewCount: '100' } })
    await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now })
    minuto = 45
    yt.stats[ID1] = { viewCount: '900', likeCount: '12' }
    await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now })
    expect(listSnapshots(db, a).map((s) => s.views)).toEqual([100, 900])
    expect(latestSnapshot(db, a)).toMatchObject({ views: 900, likes: 12 })
  })

  it('no vuelve a preguntar por un vídeo medido hace menos de 30 minutos, salvo que se fuerce', async () => {
    pub('clp_a', 'youtube', `https://www.youtube.com/shorts/${ID1}`)
    const yt = fakeYouTube({ [ID1]: { viewCount: '100' } })
    await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now })
    minuto = 10
    expect(await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now })).toMatchObject({ measured: 0, skippedRecent: 1 })
    expect(yt.calls).toHaveLength(1) // ni siquiera se llama a YouTube
    expect(await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now, force: true })).toMatchObject({ measured: 1, skippedRecent: 0 })
    minuto = 50
    expect(await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now })).toMatchObject({ measured: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get()).toEqual({ n: 3 })
  })

  it('un vídeo que YouTube no encuentra no genera medición', async () => {
    const a = pub('clp_a', 'youtube', `https://www.youtube.com/shorts/${ID3}`)
    const r = await refreshYouTubeStats(db, 'k', fakeYouTube({}).fetchImpl, { now })
    expect(r).toMatchObject({ measured: 0, notFound: 1 })
    expect(latestSnapshot(db, a)).toBeNull()
  })

  it('si la API falla no se guarda nada a medias', async () => {
    pub('clp_a', 'youtube', `https://www.youtube.com/shorts/${ID1}`)
    await expect(refreshYouTubeStats(db, 'k', fallo(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }), { now })).rejects.toThrow(/cuota/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get()).toEqual({ n: 0 })
  })

  it('sin publicaciones de YouTube no se llama a la API', async () => {
    pub('clp_a', 'tiktok', 'https://www.tiktok.com/@x/video/1')
    const yt = fakeYouTube({})
    expect(await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now })).toEqual({ publications: 0, measured: 0, skippedRecent: 0, withoutUrl: 0, notFound: 0 })
    expect(yt.calls).toHaveLength(0)
  })

  it('las cifras llegan a la interfaz y no alteran score, QA ni el orden', async () => {
    pub('clp_b', 'youtube', `https://www.youtube.com/shorts/${ID1}`)
    const antes = getClip(db, 'clp_b')!
    expect(antes.publications[0].latest).toBeNull()
    await refreshYouTubeStats(db, 'k', fakeYouTube({ [ID1]: { viewCount: '1234567', likeCount: '4321', commentCount: '12' } }).fetchImpl, { now })
    const despues = getClip(db, 'clp_b')!
    expect(despues.publications[0].latest).toMatchObject({ views: 1234567, likes: 4321, comments: 12 })
    expect([despues.score, despues.qaScore, despues.position, despues.prediction]).toEqual([antes.score, antes.qaScore, antes.position, antes.prediction])
    expect(listPublished(db)[0].publication.latest!.views).toBe(1234567)
    expect(db.prepare('SELECT COUNT(*) AS n FROM prediction_snapshots').get()).toEqual({ n: 0 })
    expect(formatCount(1234567)).toBe('1.234.567')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(null)).toBe('—')
  })

  it('medir no escribe nada en CAMPAIGNS', async () => {
    pub('clp_a', 'youtube', `https://www.youtube.com/shorts/${ID1}`)
    const antes = fingerprint(root)
    await refreshYouTubeStats(db, 'k', fakeYouTube({ [ID1]: { viewCount: '5' } }).fetchImpl, { now })
    expect(fingerprint(root)).toEqual(antes)
  })
})
