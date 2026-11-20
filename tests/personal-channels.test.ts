/** «Canales personales»: canales del usuario ajenos a los clips. Solo se miran sus cifras, día a día. */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dailyStats, getChannelDashboards } from '../src/core/channel-dashboard'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getPlan } from '../src/core/plan'
import { MIGRATIONS, SCHEMA_VERSION } from '../src/core/schema'
import { getStats } from '../src/core/stats'
import { localDay } from '../src/core/stats-series'
import type { FetchLike } from '../src/core/youtube'
import { addChannel, listChannels, moveChannelToClips, removeChannel, syncChannels, syncChannelStats } from '../src/core/youtube-channels'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

type Row = Record<string, any>
const CLIPS = 'UC' + 'c'.repeat(22)
const MIO = 'UC' + 'p'.repeat(22)
const el = (dia: number, hora: number, min = 0) => new Date(2026, 9, dia, hora, min).toISOString()
const AHORA = new Date(2026, 9, 14, 12, 0)

interface Falso { title: string; publishedAt: string; views: number }
interface CanalFalso { handle: string; subs: number; views: number; videos: Record<string, Falso> }

/** YouTube de mentira con dos canales: uno de clips y uno personal. */
function youtubeFalso(canales: Record<string, CanalFalso>) {
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url)
    const recurso = u.pathname.split('/').pop()!
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    if (recurso === 'channels') {
      if (u.searchParams.get('part') === 'statistics') {
        return ok({ items: u.searchParams.get('id')!.split(',').filter((id) => canales[id]).map((id) => ({
          id, statistics: { subscriberCount: String(canales[id].subs), viewCount: String(canales[id].views), videoCount: String(Object.keys(canales[id].videos).length) }
        })) })
      }
      const id = Object.keys(canales).find((k) => canales[k].handle === u.searchParams.get('forHandle') || k === u.searchParams.get('id'))
      return ok({ items: id ? [{ id, snippet: { title: canales[id].handle, customUrl: canales[id].handle }, contentDetails: { relatedPlaylists: { uploads: 'UU' + id } } }] : [] })
    }
    if (recurso === 'playlistItems') {
      const id = u.searchParams.get('playlistId')!.slice(2)
      return ok({ items: Object.keys(canales[id].videos).map((v) => ({ contentDetails: { videoId: v } })) })
    }
    const todos = Object.assign({}, ...Object.entries(canales).map(([id, c]) => Object.fromEntries(Object.entries(c.videos).map(([v, d]) => [v, { ...d, canal: id }]))))
    return ok({ items: u.searchParams.get('id')!.split(',').filter((v) => todos[v]).map((v) => ({
      id: v, snippet: { channelId: todos[v].canal, title: todos[v].title, description: '', publishedAt: todos[v].publishedAt }, contentDetails: { duration: 'PT31S' },
      statistics: { viewCount: String(todos[v].views), likeCount: '3', commentCount: '0' }
    })) })
  }
  return { fetchImpl, canales }
}

describe('día a día de un canal', () => {
  const m = (t: string, totalViews: number | null, subscribers: number | null = 100, videoCount: number | null = 5) => ({ t, totalViews, subscribers, videoCount })

  it('se queda con la última medición de cada día y resta con el día medido anterior', () => {
    const dias = dailyStats([m(el(10, 9), 1000), m(el(10, 22), 1040, 101), m(el(11, 8), 1100, 101), m(el(11, 23, 30), 1190, 104)], [el(11, 15), el(11, 18), el(3, 10), null])
    expect(dias).toEqual([
      { day: localDay(el(10, 9)), totalViews: 1040, subscribers: 101, videoCount: 5, viewsGain: null, subscribersGain: null, daysSincePrevious: null, uploads: 0 },
      { day: localDay(el(11, 8)), totalViews: 1190, subscribers: 104, videoCount: 5, viewsGain: 150, subscribersGain: 3, daysSincePrevious: 1, uploads: 2 }
    ])
  })

  it('un día sin medir no se inventa: la diferencia siguiente dice cuántos días abarca', () => {
    const dias = dailyStats([m(el(10, 12), 1000), m(el(13, 12), 1600)], [])
    expect(dias.map((d) => [d.day.slice(-2), d.viewsGain, d.daysSincePrevious])).toEqual([['10', null, null], ['13', 600, 3]])
  })

  it('sin mediciones no hay días; una cifra que falta no se resta ni se toma por cero', () => {
    expect(dailyStats([], [el(10, 9)])).toEqual([])
    const dias = dailyStats([m(el(10, 12), 1000, null), m(el(11, 12), null, 50), m(el(12, 12), 1300, 60)], [])
    expect(dias.map((d) => [d.viewsGain, d.subscribersGain])).toEqual([[null, null], [null, null], [null, 10]])
  })

  it('el orden de llegada de las mediciones no importa', () => {
    const a = [m(el(10, 9), 1000), m(el(11, 9), 1100), m(el(12, 9), 1150)]
    expect(dailyStats([a[2], a[0], a[1]], [])).toEqual(dailyStats(a, []))
  })
})

describe('canal personal', () => {
  let base: string
  let root: string
  let db: DB
  let yt: ReturnType<typeof youtubeFalso>

  beforeEach(() => {
    base = tmpDir('cos_personal_')
    root = path.join(base, 'CAMPAIGNS')
    fs.mkdirSync(root, { recursive: true })
    db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
    const camp = new CampaignFixture(root, 'PODCAST', 'podcast', 'Podcast')
    camp.addClip({ n: 1, clipId: 'clp_1', title: 'He taught him to read and write', score: 93 })
    syncLibraries(db, { roots: [root] })
    yt = youtubeFalso({
      [CLIPS]: { handle: '@misclips', subs: 40, views: 9000, videos: { ccccccccccc: { title: 'Otro vídeo del canal de clips', publishedAt: el(12, 10), views: 500 } } },
      [MIO]: { handle: '@micanal', subs: 1200, views: 250000, videos: {
        // mismo título que un clip: en un canal personal NO debe emparejarse
        ppppppppppp: { title: 'He taught him to read and write', publishedAt: el(12, 18), views: 3000 },
        qqqqqqqqqqq: { title: 'Mi viaje a Japón', publishedAt: el(2, 9), views: 80000 }
      } }
    })
  })
  afterEach(() => {
    db.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('se guarda aparte: sus vídeos no se emparejan con clips ni cuentan en las estadísticas de campañas', async () => {
    await addChannel(db, '@misclips', 'k', yt.fetchImpl)
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, undefined, 'personal')
    const r = await syncChannels(db, 'k', yt.fetchImpl, { now: () => el(13, 12) })
    expect(r).toMatchObject({ channels: 2, videos: 3, linkedNow: 0, unmatched: 1, measured: 0 })   // el «sin emparejar» es el del canal de clips

    expect(listChannels(db, 'clips').map((c) => [c.handle, c.kind])).toEqual([['@misclips', 'clips']])
    expect(listChannels(db, 'personal').map((c) => [c.handle, c.kind, c.videos, c.linked])).toEqual([['@micanal', 'personal', 2, 0]])
    expect(listChannels(db)).toHaveLength(2)

    // nada del canal personal toca publicaciones, mediciones de clips ni el plan
    expect((db.prepare('SELECT COUNT(*) AS n FROM publications').get() as Row).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get() as Row).n).toBe(0)
    const stats = getStats(db)
    expect(stats.unmatched.map((v) => v.videoId)).toEqual(['ccccccccccc'])
    expect(stats.totals).toMatchObject({ views: 0, published: 0 })
    expect(getPlan(db, AHORA).accounts).toEqual([])

    // pero sus cifras sí se guardan
    expect((db.prepare("SELECT COUNT(*) AS n FROM youtube_video_snapshots WHERE video_id IN ('ppppppppppp', 'qqqqqqqqqqq')").get() as Row).n).toBe(2)
  })

  it('pasarlo a Canales conserva su historial y empareja sus vídeos de campaña; los demás quedan para decidir', async () => {
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, undefined, 'personal')
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => el(13, 12) })
    const antes = (db.prepare('SELECT COUNT(*) AS n FROM youtube_video_snapshots').get() as Row).n
    moveChannelToClips(db, MIO)
    expect(listChannels(db, 'personal')).toEqual([])
    expect(listChannels(db, 'clips').map((c) => [c.handle, c.videos])).toEqual([['@micanal', 2]])
    expect((db.prepare('SELECT COUNT(*) AS n FROM youtube_video_snapshots').get() as Row).n).toBe(antes)
    const r = await syncChannels(db, 'k', yt.fetchImpl, { now: () => el(14, 12) })
    expect(r).toMatchObject({ linkedNow: 1, unmatched: 1 })
    expect(db.prepare("SELECT clip_id, account FROM publications WHERE platform = 'youtube'").all()).toEqual([{ clip_id: 'clp_1', account: '@micanal' }])
    expect(() => moveChannelToClips(db, 'UC' + 'x'.repeat(22))).toThrow('no está')
  })

  it('si el título no casa, lo une con lo marcado como subido en ese canal a la misma hora (sin duplicar)', async () => {
    await addChannel(db, '@misclips', 'k', yt.fetchImpl)
    // «Marcar subido» en «Hoy» a las 10:20; el vídeo sale a las 10:00 con otro título
    db.prepare("INSERT INTO publications (clip_id, platform, account, status, published_at, created_at, updated_at) VALUES ('clp_1', 'youtube', '@misclips', 'published', ?, 't', 't')").run(el(12, 10, 20))
    const r = await syncChannels(db, 'k', yt.fetchImpl, { now: () => el(13, 12) })
    expect(r.linkedNow).toBe(1)
    expect(db.prepare("SELECT clip_id, url FROM publications WHERE platform = 'youtube'").all()).toEqual([{ clip_id: 'clp_1', url: 'https://www.youtube.com/shorts/ccccccccccc' }])
  })

  it('cada apartado enseña solo sus canales, con los vídeos del más reciente al más antiguo', async () => {
    await addChannel(db, '@misclips', 'k', yt.fetchImpl)
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, undefined, 'personal')
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => el(13, 12) })
    await syncChannelStats(db, 'k', yt.fetchImpl, () => el(13, 12))
    expect(getChannelDashboards(db, AHORA).map((c) => c.handle)).toEqual(['@misclips'])
    const [p] = getChannelDashboards(db, AHORA, 'personal')
    expect(p).toMatchObject({ kind: 'personal', handle: '@micanal', subscribers: 1200, totalViews: 250000, videoCount: 2 })
    expect(p.videos.map((v) => [v.title, v.views, v.clipId, v.campaignName])).toEqual([
      ['He taught him to read and write', 3000, null, null], ['Mi viaje a Japón', 80000, null, null]
    ])
  })

  it('día a día: una fila por día medido, con las visitas ganadas y los vídeos subidos ese día', async () => {
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, undefined, 'personal')
    for (const [dia, hora, visitas, subs] of [[11, 10, 250000, 1200], [12, 9, 251500, 1210], [12, 21, 252200, 1210], [14, 10, 256000, 1230]] as const) {
      yt.canales[MIO].views = visitas
      yt.canales[MIO].subs = subs
      await syncChannels(db, 'k', yt.fetchImpl, { now: () => el(dia, hora) })
      await syncChannelStats(db, 'k', yt.fetchImpl, () => el(dia, hora))
    }
    const [p] = getChannelDashboards(db, AHORA, 'personal')
    expect(p.daily.map((d) => [d.day.slice(-2), d.totalViews, d.viewsGain, d.subscribersGain, d.daysSincePrevious, d.uploads])).toEqual([
      ['11', 250000, null, null, null, 0],
      ['12', 252200, 2200, 10, 1, 1],       // la última medición del día, y el vídeo subido el 12
      ['14', 256000, 3800, 20, 2, 0]        // el 13 no se abrió la aplicación: la diferencia abarca dos días
    ])
  })

  it('un canal es de clips o personal, no las dos cosas', async () => {
    await addChannel(db, '@misclips', 'k', yt.fetchImpl)
    await expect(addChannel(db, '@misclips', 'k', yt.fetchImpl, undefined, 'personal')).rejects.toThrow(/ya está en «Canales»/)
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, undefined, 'personal')
    await expect(addChannel(db, '@micanal', 'k', yt.fetchImpl)).rejects.toThrow(/ya está en «Canales personales»/)
    expect(listChannels(db).map((c) => c.kind)).toEqual(['clips', 'personal'])
    // volver a añadirlo en su sitio no lo duplica ni le cambia el tipo
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, undefined, 'personal')
    expect(listChannels(db, 'personal')).toHaveLength(1)
  })

  it('quitarlo borra sus cifras y no toca nada más; verlo no escribe nada', async () => {
    await addChannel(db, '@misclips', 'k', yt.fetchImpl)
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, undefined, 'personal')
    await syncChannels(db, 'k', yt.fetchImpl, { now: () => el(13, 12) })
    await syncChannelStats(db, 'k', yt.fetchImpl, () => el(13, 12))
    const antes = fingerprint(root)
    const cambios = db.prepare('SELECT total_changes() AS n').get()
    getChannelDashboards(db, AHORA, 'personal')
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(cambios)

    removeChannel(db, MIO)
    expect(getChannelDashboards(db, AHORA, 'personal')).toEqual([])
    expect(getChannelDashboards(db, AHORA)).toHaveLength(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM youtube_videos').get() as Row).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM youtube_channel_snapshots').get() as Row).n).toBe(1)
    expect(fingerprint(root)).toEqual(antes)
  })

  it('al migrar de la versión 9, los canales que ya había siguen siendo de clips', () => {
    const ruta = path.join(base, 'v9', 'content-os.db')
    fs.mkdirSync(path.dirname(ruta))
    const v9 = new Database(ruta)
    for (const mig of MIGRATIONS.slice(0, 9)) v9.exec(mig)
    v9.pragma('user_version = 9')
    v9.exec(`INSERT INTO youtube_channels (channel_id, handle, uploads_playlist, added_at, subscribers) VALUES ('${CLIPS}', '@misclips', 'UU', 't', 40)`)
    v9.close()
    const nueva = openDatabase(ruta, { backupDir: path.join(base, 'copias') })
    expect([SCHEMA_VERSION, nueva.pragma('user_version', { simple: true })]).toEqual([18, 18])
    expect(listChannels(nueva).map((c) => [c.handle, c.kind])).toEqual([['@misclips', 'clips']])
    expect(listChannels(nueva, 'personal')).toEqual([])
    expect(fs.readdirSync(path.join(base, 'copias'))[0]).toMatch(/^content-os_v9_.*\.db$/)
    nueva.close()
  })
})
