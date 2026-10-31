/** Panel «Canales»: historial de cada vídeo del canal, cifras del canal y el estudio (cómo va y por qué). */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getChannelDashboards, median, recentGain, studyChannel, type ChannelVideo } from '../src/core/channel-dashboard'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { MIGRATIONS, SCHEMA_VERSION } from '../src/core/schema'
import type { FetchLike } from '../src/core/youtube'
import { addChannel, removeChannel, syncChannels, syncChannelStats } from '../src/core/youtube-channels'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

type Row = Record<string, any>
const CH = 'UC' + 'b'.repeat(22)
const AHORA = new Date(2026, 9, 13, 12, 0) // martes 13 de octubre de 2026, 12:00
const hace = (horas: number) => new Date(AHORA.getTime() - horas * 3600_000).toISOString()
const el = (dia: number, hora: number, min = 0) => new Date(2026, 9, dia, hora, min).toISOString()

let cuenta = 0
const video = (c: Partial<ChannelVideo> & { publishedAt: string; views: number | null }): ChannelVideo => ({
  videoId: 'v' + String(++cuenta).padStart(10, '0'), url: '', title: `Vídeo ${cuenta}`, durationSeconds: 30, likes: null, comments: null, statsAt: null, gain: null, series: [],
  clipId: null, campaignId: null, campaignName: null, score: null, hasThumb: false, thumbVersion: null, ...c
})
const estudiar = (videos: ChannelVideo[]) => studyChannel({ name: '@canal', subscribers: 12, videos }, AHORA)
const titulos = (videos: ChannelVideo[]) => estudiar(videos).findings.map((f) => f.title)

describe('cuentas del panel', () => {
  it('mediana', () => {
    expect([median([]), median([7]), median([1, 9, 3]), median([10, 20, 30, 1000])]).toEqual([null, 7, 3, 25])
  })

  it('visitas del último día: solo entre dos mediciones reales', () => {
    const v = (publishedAt: string, views: number | null, series: [number, number][]) => ({ publishedAt, views, series: series.map(([h, n]) => ({ t: hace(h), views: n })) })
    // subido hace 5 horas: parte de cero
    expect(recentGain(v(hace(5), 40, []), AHORA)).toEqual({ views: 40, hours: 5 })
    // la medición de hace 26 h sirve; la de hace 3 h es demasiado reciente para comparar
    expect(recentGain(v(hace(200), 900, [[100, 300], [26, 700], [3, 880]]), AHORA)).toEqual({ views: 200, hours: 26 })
    // la última medición vieja es de hace 4 días: no se presenta como «último día»
    expect(recentGain(v(hace(200), 900, [[96, 300], [1, 900]]), AHORA)).toBeNull()
    expect(recentGain(v(hace(200), 900, []), AHORA)).toBeNull()
    expect(recentGain(v(hace(200), null, [[26, 700]]), AHORA)).toBeNull()
  })
})

describe('estudiar el canal', () => {
  it('sin vídeos, o con pocos de más de 48 horas, no saca conclusiones', () => {
    expect(estudiar([])).toMatchObject({ level: 'sin_datos', findings: [], best: [], worst: [] })
    const pocos = estudiar([video({ publishedAt: hace(100), views: 800 }), video({ publishedAt: hace(10), views: 3 }), video({ publishedAt: hace(2), views: 0 })])
    expect(pocos.level).toBe('pocos_datos')
    expect(pocos.summary).toContain('Solo 1 vídeo lleva más de 48 horas (800 visitas)')
    expect([pocos.best, pocos.worst]).toEqual([[], []])
    // lo único que dice es que hay vídeos recientes que aún no cuentan
    expect(pocos.findings.map((f) => f.title)).toEqual(['2 vídeos llevan menos de 48 horas'])
    expect(estudiar([video({ publishedAt: hace(3), views: 3 })]).summary).toContain('es pronto para juzgar')
  })

  it('canal frenado: antes tenía visitas y los últimos se quedan casi a cero', () => {
    const vs = [5200, 900, 1400, 640, 3, 0, 4, 2].map((views, i) => video({ publishedAt: hace(400 - i * 30), views }))
    const e = estudiar(vs)
    expect(e.level).toBe('frenado')
    expect(e.summary).toContain('Los últimos 4 vídeos: mediana de 3 visitas. Los 4 anteriores: 1.150. El canal tiene 4 vídeos por encima de 500 visitas')
    expect(e.findings[0]).toMatchObject({ tone: 'bad', title: '4 de 8 vídeos se quedaron por debajo de 10 visitas' })
    expect(e.findings[0].detail).toContain('los últimos 4 seguidos')
    expect(e.findings.map((f) => f.title)).toContain('Un solo vídeo concentra el 64 % de las visitas')
    expect(e.best).toEqual([vs[0].videoId, vs[2].videoId, vs[1].videoId])
    expect(e.worst).toEqual([vs[5].videoId, vs[7].videoId, vs[4].videoId])
    expect(e.steps[0]).toContain('No subas más de un vídeo al día')
  })

  it('un freno que ya dura muchos vídeos sigue siendo un freno (no «se mantiene»)', () => {
    // caso real: buenos al principio, después diez casi a cero con uno suelto que sí salió
    const vs = [1400, 1500, 1300, 5193, 1693, 1426, 1281, 1648, 0, 2, 7, 0, 2560, 1, 1, 0, 0].map((views, i) => video({ publishedAt: hace(900 - i * 30), views }))
    const e = estudiar(vs)
    expect(e.level).toBe('frenado')
    expect(e.summary).toContain('Los últimos 5 vídeos: mediana de 1 visita. Los 12 anteriores: 1.350.')
    // y cuando lo anterior también es flojo pero hubo varios vídeos grandes
    const largo = [900, 5000, 700, 3, 0, 2, 1, 0, 4, 2, 0, 1, 3, 0].map((views, i) => video({ publishedAt: hace(900 - i * 30), views }))
    expect(estudiar(largo)).toMatchObject({ level: 'frenado' })
  })

  it('distingue ir a más, a menos, mantenerse y no haber despegado', () => {
    const serie = (visitas: number[]) => estudiar(visitas.map((views, i) => video({ publishedAt: hace(600 - i * 30), views }))).level
    expect(serie([100, 120, 90, 110, 400, 500, 380, 450])).toBe('sube')
    expect(serie([900, 1100, 800, 1000, 300, 250, 400, 350])).toBe('baja')
    expect(serie([900, 1100, 800, 1000, 950, 870, 1200, 990])).toBe('estable')
    expect(serie([12, 30, 8, 44, 20, 15])).toBe('sin_despegar')
  })

  it('los vídeos de menos de 48 horas no cuentan como malos', () => {
    const base = [900, 1100, 800, 1000, 950, 870].map((views, i) => video({ publishedAt: hace(600 - i * 30), views }))
    const e = estudiar([...base, video({ publishedAt: hace(6), views: 2 }), video({ publishedAt: hace(1), views: 0 })])
    expect(e.level).toBe('estable')
    expect(e.findings.some((f) => f.title.includes('por debajo de 10 visitas'))).toBe(false)
    const maduros = new Set(base.map((v) => v.videoId))
    expect([...e.best, ...e.worst].every((id) => maduros.has(id))).toBe(true)
    expect(e.facts.find((f) => f.label === 'Con más de 48 h')!.value).toBe('6')
  })

  it('compara subir de uno en uno con subir en tandas, y avisa de que es un indicio', () => {
    // tres días de un vídeo y un día de cuatro
    const solos = [800, 950, 700].map((views, i) => video({ publishedAt: el(1 + i, 13), views }))
    const tanda = [40, 12, 90, 25].map((views, i) => video({ publishedAt: el(6, 10 + i), views }))
    const e = estudiar([...solos, ...tanda])
    const h = e.findings.find((f) => f.title === 'Subir varios el mismo día rinde peor')!
    expect(h).toMatchObject({ tone: 'bad', weak: true })
    expect(h.detail).toBe('Subidos solos ese día: mediana de 800 visitas (3 vídeos). En días de 3 o más subidas: mediana de 33 visitas (4 vídeos).')
    expect(e.steps).toContain('Un vídeo al día en este canal, no varios.')
    // si todo se subió en tandas, lo dice en vez de comparar
    expect(titulos(tanda.concat([video({ publishedAt: el(6, 15), views: 60 })]))).toContain('Casi todo se subió en tandas')
  })

  it('dice qué campaña, hora y duración rinden mejor solo si hay muestra y diferencia', () => {
    const vs = [
      ...[2000, 2600, 1800].map((views, i) => video({ publishedAt: el(1 + i, 13), views, campaignName: 'Kevin Langue', durationSeconds: 28, score: 92 })),
      ...[150, 90, 210].map((views, i) => video({ publishedAt: el(4 + i, 2), views, campaignName: 'Banco sin editar', durationSeconds: 45, score: 80 }))
    ]
    const e = estudiar(vs)
    expect(e.findings.map((f) => f.title)).toEqual(expect.arrayContaining([
      'Lo que mejor funciona aquí: Kevin Langue', 'Mejor hora de subida: a mediodía (12–16 h)', 'Duración que mejor rinde: de 20 a 35 s', 'El score acierta en este canal'
    ]))
    expect(e.findings.find((f) => f.title.startsWith('Lo que mejor'))!.detail).toBe('Kevin Langue: mediana de 2.000 visitas (3 vídeos). Banco sin editar: mediana de 150 visitas (3 vídeos).')
    expect(e.findings.every((f) => f.weak || f.tone === 'info')).toBe(true)
    expect(e.steps).toContain('Sube a mediodía (12–16 h).')
    // sin diferencia clara no hay hallazgo
    const parejos = [1000, 1100, 900].map((views, i) => video({ publishedAt: el(1 + i, 13), views, campaignName: 'A' })).concat([950, 1050, 980].map((views, i) => video({ publishedAt: el(4 + i, 2), views, campaignName: 'B' })))
    expect(titulos(parejos).filter((t) => /mejor|rinde/i.test(t))).toEqual([])
  })

  it('likes sobre visitas, solo con vídeos de 100 visitas o más', () => {
    const vs = [[1000, 50], [2000, 40], [500, 60], [80, 40]].map(([views, likes], i) => video({ publishedAt: hace(500 - i * 30), views, likes, title: `T${i}` }))
    const f = estudiar(vs).findings.find((x) => x.title.startsWith('Likes'))!
    expect(f.title).toBe('Likes: 5,0 % de las visitas')
    expect(f.detail).toContain('Mediana de 3 vídeos con 100 visitas o más. El que más gusta: «T2» (12,0 %).')
  })

  it('el texto para copiar lleva el veredicto, los pasos y todos los vídeos, y siempre sale igual', () => {
    const vs = [5200, 900, 1400, 640].map((views, i) => video({ publishedAt: hace(400 - i * 30), views, title: `Clip ${i}`, likes: 9 }))
    const e = estudiar(vs)
    expect(e.text.split('\n')[0]).toBe('ESTUDIO DEL CANAL @canal · 13 de octubre de 2026')
    for (const trozo of [e.headline, 'Siguientes pasos:', 'Vídeos, del más reciente al más antiguo:', '5.200 visitas · 9 likes · 30 s · «Clip 0»']) expect(e.text).toContain(trozo)
    expect(estudiar(vs)).toEqual(e)
    expect(e.limits[0]).toContain('retención')
  })
})

// ------------------------------------------------------------------ con base de datos

interface Falso { title: string; publishedAt: string; views: number; likes?: number }
function youtubeFalso(videos: Record<string, Falso>, canal = { subs: 12, views: 9000, n: 3 }) {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url)
    const recurso = u.pathname.split('/').pop()!
    calls.push(recurso + ':' + u.searchParams.get('part'))
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    if (recurso === 'channels') {
      if (u.searchParams.get('part') === 'statistics') return ok({ items: [{ id: CH, statistics: { subscriberCount: String(canal.subs), viewCount: String(canal.views), videoCount: String(canal.n) } }] })
      return ok({ items: [{ id: CH, snippet: { title: 'Mi Canal', customUrl: '@micanal' }, contentDetails: { relatedPlaylists: { uploads: 'UUsubidas' } } }] })
    }
    if (recurso === 'playlistItems') return ok({ items: Object.keys(videos).map((id) => ({ contentDetails: { videoId: id } })) })
    return ok({
      items: u.searchParams.get('id')!.split(',').filter((i) => videos[i]).map((i) => ({
        id: i, snippet: { channelId: CH, title: videos[i].title, description: '', publishedAt: videos[i].publishedAt }, contentDetails: { duration: 'PT31S' },
        statistics: { viewCount: String(videos[i].views), likeCount: String(videos[i].likes ?? 0), commentCount: '0' }
      }))
    })
  }
  return { fetchImpl, calls, videos, canal }
}

describe('panel del canal', () => {
  let base: string
  let root: string
  let db: DB
  const A = 'aaaaaaaaaaa'
  const B = 'bbbbbbbbbbb'
  const C = 'ccccccccccc'

  beforeEach(() => {
    base = tmpDir('cos_chan_')
    root = path.join(base, 'CAMPAIGNS')
    fs.mkdirSync(root, { recursive: true })
    db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
    const camp = new CampaignFixture(root, 'PODCAST', 'podcast', 'Podcast')
    camp.addClip({ n: 1, clipId: 'clp_1', title: 'He taught him to read and write', score: 93 })
    syncLibraries(db, { roots: [root] })
  })
  afterEach(() => {
    db.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('lista todos los vídeos del canal del más reciente al más antiguo, emparejados o no', async () => {
    const yt = youtubeFalso({
      [A]: { title: 'He taught him to read and write', publishedAt: hace(100), views: 700, likes: 35 },
      [B]: { title: 'Un vídeo que no es un clip', publishedAt: hace(30), views: 40 },
      [C]: { title: 'El más nuevo', publishedAt: hace(2), views: 5 }
    })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl)
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => hace(26) })
    yt.videos[A].views = 900
    yt.videos[B].views = 55
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => hace(0) })
    expect(await syncChannelStats(db, 'k', yt.fetchImpl, () => hace(0))).toBe(1)

    const [p] = getChannelDashboards(db, AHORA)
    expect(p).toMatchObject({ channelId: CH, handle: '@micanal', subscribers: 12, totalViews: 9000, videoCount: 3, subscribersChange: null })
    expect(p.videos.map((v) => v.videoId)).toEqual([C, B, A])
    expect(p.videos[2]).toMatchObject({ clipId: 'clp_1', campaignId: 'podcast', campaignName: 'Podcast', score: 93, views: 900, likes: 35, gain: { views: 200, hours: 26 }, url: `https://www.youtube.com/shorts/${A}` })
    expect(p.videos[2].series.map((s) => s.views)).toEqual([700, 900])
    expect(p.videos[1]).toMatchObject({ clipId: null, campaignName: null, views: 55, gain: { views: 15, hours: 26 } })
    expect(p.videos[0].gain).toEqual({ views: 5, hours: 2 }) // recién subido: parte de cero
    expect(p.totals).toMatchObject({ videos: 3, measured: 3, views: 960, median: 55, gain: 220, gainVideos: 3 })
    expect(p.study.level).toBe('pocos_datos')
  })

  it('guarda una medición cuando cambia la cifra y, si no cambia, como mucho una por hora', async () => {
    const yt = youtubeFalso({ [A]: { title: 'X', publishedAt: hace(100), views: 10 } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl)
    const filas = () => (db.prepare('SELECT views FROM youtube_video_snapshots WHERE video_id = ? ORDER BY id').all(A) as Row[]).map((r) => r.views)
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => hace(5) })
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => hace(4.5) }) // igual y hace media hora: nada
    expect(filas()).toEqual([10])
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => hace(3.9) }) // igual, pero ya pasó una hora
    yt.videos[A].views = 14
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => hace(3.8) }) // cambió: se guarda aunque sea pronto
    expect(filas()).toEqual([10, 10, 14])
  })

  it('suscriptores: guarda la cifra y su variación; quitar el canal lo limpia todo', async () => {
    const yt = youtubeFalso({ [A]: { title: 'X', publishedAt: hace(100), views: 10 } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl)
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => hace(50) })
    await syncChannelStats(db, 'k', yt.fetchImpl, () => hace(50))
    expect(await syncChannelStats(db, 'k', yt.fetchImpl, () => hace(49))).toBe(0) // igual y reciente: no repite
    yt.canal.subs = 19
    await syncChannelStats(db, 'k', yt.fetchImpl, () => hace(1))
    expect(getChannelDashboards(db, AHORA)[0]).toMatchObject({ subscribers: 19, subscribersChange: { delta: 7, since: hace(50) } })
    expect(yt.calls.filter((c) => c === 'channels:statistics')).toHaveLength(3)

    removeChannel(db, CH)
    expect(getChannelDashboards(db, AHORA)).toEqual([])
    for (const t of ['youtube_video_snapshots', 'youtube_channel_snapshots', 'youtube_videos']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row).n).toBe(0)
  })

  it('leer el panel no escribe nada, ni en la base ni en la biblioteca', async () => {
    const yt = youtubeFalso({ [A]: { title: 'He taught him to read and write', publishedAt: hace(100), views: 700 } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl)
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => hace(1) })
    const antes = fingerprint(root)
    const cambios = db.prepare('SELECT total_changes() AS n').get() as Row
    getChannelDashboards(db, AHORA)
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(cambios)
    expect(fingerprint(root)).toEqual(antes)
  })

  it('al migrar de la versión 8, el historial ya medido pasa a los vídeos del canal', () => {
    const ruta = path.join(base, 'v8', 'content-os.db')
    fs.mkdirSync(path.dirname(ruta))
    const v8 = new Database(ruta)
    for (const m of MIGRATIONS.slice(0, 8)) v8.exec(m)
    v8.pragma('user_version = 8')
    v8.exec(`
      INSERT INTO library_roots (path, created_at) VALUES ('C:/x', 't');
      INSERT INTO campaigns (campaign_id, root_id, folder_name, source_path, campaign_json_path, created_at, updated_at, last_sync_at) VALUES ('c', 1, 'C', 'p', 'j', 't', 't', 't');
      INSERT INTO clips (clip_id, campaign_id, title, first_seen_at, updated_at, last_sync_at) VALUES ('k', 'c', 'Clip', 't', 't', 't');
      INSERT INTO publications (clip_id, platform, url, created_at, updated_at) VALUES ('k', 'youtube', 'https://youtu.be/${A}', 't', 't');
      INSERT INTO youtube_channels (channel_id, handle, uploads_playlist, added_at) VALUES ('${CH}', '@micanal', 'UU', 't');
      INSERT INTO youtube_videos (video_id, channel_id, title, publication_id, match_state, views, likes, comments, stats_at, first_seen_at, last_seen_at) VALUES
        ('${A}', '${CH}', 'Emparejado', 1, 'auto', 500, 9, 1, '2026-10-12T10:00:00.000Z', 't', 't'),
        ('${B}', '${CH}', 'Suelto', NULL, 'unmatched', 40, 2, 0, '2026-10-12T10:00:00.000Z', 't', 't');
      INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, origin) VALUES
        (1, '2026-10-10T10:00:00.000Z', 100, 2, 0, 'youtube_api'), (1, '2026-10-12T10:00:00.000Z', 500, 9, 1, 'youtube_api'), (1, '2026-10-11T10:00:00.000Z', 77, 0, 0, 'manual');
    `)
    v8.close()
    const nueva = openDatabase(ruta, { backupDir: path.join(base, 'copias') })
    expect([SCHEMA_VERSION, nueva.pragma('user_version', { simple: true })]).toEqual([16, 16])
    expect(nueva.prepare('SELECT video_id, views FROM youtube_video_snapshots ORDER BY video_id, measured_at').all()).toEqual([
      { video_id: A, views: 100 }, { video_id: A, views: 500 }, { video_id: B, views: 40 }
    ])
    expect(nueva.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get()).toEqual({ n: 3 }) // lo anterior sigue intacto
    expect(getChannelDashboards(nueva, AHORA)[0].videos.map((v) => [v.title, v.views, v.series.length])).toEqual([['Emparejado', 500, 2], ['Suelto', 40, 1]])
    expect(fs.readdirSync(path.join(base, 'copias'))[0]).toMatch(/^content-os_v8_.*\.db$/)
    nueva.close()
  })
})
