/** Canales de YouTube: descubrir vídeos, emparejarlos con su clip sin pegar URLs, y estadísticas. */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { refreshYouTubeStats } from '../src/core/analytics'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { deletePublication, savePublication } from '../src/core/publications'
import { getClip, listClips } from '../src/core/queries'
import { MIGRATIONS, SCHEMA_VERSION } from '../src/core/schema'
import { getStats } from '../src/core/stats'
import { parseChannelRef, parseIsoDuration, type FetchLike } from '../src/core/youtube'
import { addChannel, ignoreVideo, linkVideo, listChannels, matchVideoToClip, normalizeText, removeChannel, syncChannels, unlinkVideo } from '../src/core/youtube-channels'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

type Row = Record<string, any>
const CH = 'UC' + 'a'.repeat(22)
const vid = (n: number) => 'vid' + String(n).padStart(8, '0')

interface FakeVideo { title: string; description?: string; publishedAt?: string; duration?: string; views?: number; likes?: number; comments?: number }

/** YouTube de mentira con un canal, su lista de subidas y sus vídeos. */
function fakeYouTube(videos: Record<string, FakeVideo>) {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url)
    const recurso = u.pathname.split('/').pop()!
    calls.push(recurso)
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    if (recurso === 'channels') {
      const bueno = u.searchParams.get('forHandle') === '@micanal' || u.searchParams.get('id') === CH
      return ok({ items: bueno ? [{ id: CH, snippet: { title: 'Mi Canal', customUrl: '@micanal' }, contentDetails: { relatedPlaylists: { uploads: 'UUsubidas' } } }] : [] })
    }
    if (recurso === 'playlistItems') {
      const ids = Object.keys(videos)
      const desde = Number(u.searchParams.get('pageToken') ?? 0)
      const pagina = ids.slice(desde, desde + 50)
      return ok({ items: pagina.map((id) => ({ contentDetails: { videoId: id } })), nextPageToken: desde + 50 < ids.length ? String(desde + 50) : undefined })
    }
    const ids = u.searchParams.get('id')!.split(',')
    return ok({
      items: ids.filter((i) => videos[i]).map((i) => ({
        id: i,
        snippet: { channelId: CH, title: videos[i].title, description: videos[i].description ?? '', publishedAt: videos[i].publishedAt ?? '2026-05-20T10:00:00Z' },
        contentDetails: { duration: videos[i].duration ?? 'PT31S' },
        statistics: { viewCount: String(videos[i].views ?? 100), likeCount: String(videos[i].likes ?? 5), commentCount: String(videos[i].comments ?? 1) }
      }))
    })
  }
  return { fetchImpl, calls, videos }
}

describe('utilidades', () => {
  it('reconoce el canal por @nombre, URL o identificador', () => {
    expect(parseChannelRef('@MiCanal')).toEqual({ handle: '@MiCanal' })
    expect(parseChannelRef('micanal')).toEqual({ handle: '@micanal' })
    expect(parseChannelRef('https://www.youtube.com/@mi.canal/shorts')).toEqual({ handle: '@mi.canal' })
    expect(parseChannelRef(`https://youtube.com/channel/${CH}`)).toEqual({ channelId: CH })
    expect(parseChannelRef(CH)).toEqual({ channelId: CH })
    for (const malo of ['', 'https://vimeo.com/@x', 'https://www.youtube.com/watch?v=abc', 'dos palabras', 'https://youtube.com.evil.test/@x']) expect(parseChannelRef(malo)).toBeNull()
  })

  it('duraciones y textos comparables', () => {
    expect(parseIsoDuration('PT33S')).toBe(33)
    expect(parseIsoDuration('PT1M5S')).toBe(65)
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723)
    expect(parseIsoDuration('raro')).toBeNull()
    expect(normalizeText("'We crashed the baby' 😅 #SharkTank #ABCPartner")).toBe('we crashed the baby')
    expect(normalizeText('$250,000 for 0% equity!')).toBe('250 000 for 0 equity')
  })
})

describe('emparejar un vídeo con su clip', () => {
  const clips = [
    { clipId: 'a', title: 'He taught him to read and write', caption: "He couldn't read or write English. One question at the cash register changed that.", duration: 36.4 },
    { clipId: 'b', title: 'The final meal after 202 days', caption: '3,882 calories left. 202 days after walking in to buy food, the final meal', duration: 29.2 },
    { clipId: 'c', title: 'Deal', caption: 'corta', duration: 30 }
  ]
  const v = (title: string, description = '', durationSeconds: number | null = 36) => ({ title, description, durationSeconds })

  it('mismo título, con o sin hashtags y emojis', () => {
    expect(matchVideoToClip(v('He taught him to read and write'), clips)).toMatchObject({ clipId: 'a' })
    expect(matchVideoToClip(v('HE TAUGHT HIM TO READ AND WRITE ❤️ #mrbeast #shorts'), clips)).toMatchObject({ clipId: 'a' })
    expect(matchVideoToClip(v('He taught him to read and write | MrBeast'), clips)).toMatchObject({ clipId: 'a' })
  })

  it('por la descripción cuando el título es otro', () => {
    expect(matchVideoToClip(v('No vas a creer esto', "He couldn't read or write English. One question at the cash register changed that. #mrbeast"), clips)).toMatchObject({ clipId: 'a', reason: 'misma descripción y misma duración' })
  })

  it('la duración tiene que cuadrar', () => {
    expect(matchVideoToClip(v('He taught him to read and write', '', 58), clips)).toBeNull()
    expect(matchVideoToClip(v('He taught him to read and write', '', 38), clips)).toMatchObject({ clipId: 'a' })
    expect(matchVideoToClip(v('He taught him to read and write', '', null), clips)).toMatchObject({ clipId: 'a', reason: 'mismo título' })
  })

  it('ante la duda no empareja', () => {
    expect(matchVideoToClip(v('Un vídeo cualquiera de mi canal'), clips)).toBeNull()
    expect(matchVideoToClip(v('Deal', '', 30), clips)).toBeNull() // título demasiado corto para fiarse
    const gemelos = [clips[0], { ...clips[0], clipId: 'a2' }]
    expect(matchVideoToClip(v('He taught him to read and write'), gemelos)).toBeNull() // dos candidatos
  })
})

describe('canales', () => {
  let base: string
  let root: string
  let db: DB
  let camp: CampaignFixture
  let tick = 0
  let minuto = 0
  const now = () => new Date(Date.UTC(2026, 5, 1, 12, minuto, tick++)).toISOString()
  const pubs = () => db.prepare('SELECT p.*, y.video_id, y.match_state FROM publications p LEFT JOIN youtube_videos y ON y.publication_id = p.id ORDER BY p.id').all() as Row[]

  beforeEach(async () => {
    tick = 0
    minuto = 0
    base = tmpDir('cos_ch_')
    root = path.join(base, 'CAMPAIGNS')
    fs.mkdirSync(root, { recursive: true })
    db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
    camp = new CampaignFixture(root, 'DEMO', 'demo', 'Demo')
    camp.addClip({ n: 1, clipId: 'clp_a', title: 'El primer clip de la campaña', score: 95 })
    camp.addClip({ n: 2, clipId: 'clp_b', title: 'El segundo clip de la campaña', score: 90 })
    camp.addClip({ n: 3, clipId: 'clp_c', title: 'El tercer clip de la campaña', score: 80 })
    syncLibraries(db, { roots: [root], now })
    for (const n of [1, 2, 3]) db.prepare('UPDATE clips SET duration = 31 WHERE clip_id = ?').run('clp_' + 'abc'[n - 1])
  })
  afterEach(() => {
    db.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('añade un canal comprobándolo contra YouTube', async () => {
    const yt = fakeYouTube({})
    const c = await addChannel(db, 'https://www.youtube.com/@micanal', 'k', yt.fetchImpl, now)
    expect(c).toMatchObject({ channelId: CH, handle: '@micanal', title: 'Mi Canal', videos: 0 })
    await addChannel(db, CH, 'k', yt.fetchImpl, now) // otra vez: no duplica
    expect(listChannels(db)).toHaveLength(1)
    await expect(addChannel(db, '@noexiste', 'k', yt.fetchImpl, now)).rejects.toThrow(/no encuentra ese canal/)
    await expect(addChannel(db, 'esto no vale', 'k', yt.fetchImpl, now)).rejects.toThrow(/@nombre/)
  })

  it('descubre los vídeos, empareja los claros, crea la publicación con su URL y guarda la medición', async () => {
    const yt = fakeYouTube({
      [vid(1)]: { title: 'El primer clip de la campaña #shorts', views: 5180, likes: 37, comments: 2, publishedAt: '2026-05-30T08:00:00Z' },
      [vid(2)]: { title: 'Otro título', description: 'El segundo clip de la campaña. #tag', views: 900 },
      [vid(3)]: { title: 'Un vlog mío que no es un clip', duration: 'PT8M', views: 42 }
    })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    const r = await syncChannels(db, 'k', yt.fetchImpl, { now })
    expect(r).toEqual({ channels: 1, videos: 3, linkedNow: 2, unmatched: 1, measured: 2 })

    const p = pubs()
    expect(p).toHaveLength(2)
    expect(p[0]).toMatchObject({ clip_id: 'clp_a', platform: 'youtube', account: '@micanal', url: `https://www.youtube.com/shorts/${vid(1)}`,
      published_at: '2026-05-30T08:00:00Z', status: 'published', match_state: 'auto', title_used: 'El primer clip de la campaña #shorts' })
    expect(p[0].sha256_at_publish).toBe((db.prepare("SELECT file_sha256 FROM clips WHERE clip_id = 'clp_a'").get() as Row).file_sha256)
    expect(p[1]).toMatchObject({ clip_id: 'clp_b', video_id: vid(2) })
    expect(getClip(db, 'clp_a')!.publications[0].latest).toMatchObject({ views: 5180, likes: 37, comments: 2 })
    expect(listClips(db, 'demo').map((k) => [k.clipId, k.published])).toEqual([['clp_a', ['youtube']], ['clp_b', ['youtube']], ['clp_c', []]])
  })

  it('completa una publicación que ya estaba marcada a mano sin URL (no crea otra)', async () => {
    const id = savePublication(db, { clipId: 'clp_a', platform: 'youtube', publishedAt: '2026-05-01T00:00:00Z', notes: 'la subí yo' }, now)
    const yt = fakeYouTube({ [vid(1)]: { title: 'El primer clip de la campaña', publishedAt: '2026-05-30T08:00:00Z' } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    await syncChannels(db, 'k', yt.fetchImpl, { now })
    const p = pubs()
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ id, url: `https://www.youtube.com/shorts/${vid(1)}`, account: '@micanal', notes: 'la subí yo', published_at: '2026-05-30T08:00:00Z', video_id: vid(1) })
  })

  it('respeta una URL puesta a mano: asocia el vídeo a esa publicación', async () => {
    const id = savePublication(db, { clipId: 'clp_c', platform: 'youtube', url: `https://youtu.be/${vid(1)}` }, now)
    const yt = fakeYouTube({ [vid(1)]: { title: 'Título que no se parece a nada', views: 77 } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    const r = await syncChannels(db, 'k', yt.fetchImpl, { now })
    expect(r).toMatchObject({ linkedNow: 0, unmatched: 0, measured: 1 })
    expect(pubs()[0]).toMatchObject({ id, clip_id: 'clp_c', video_id: vid(1), match_state: 'manual' })
    // y medir después por URL no duplica la medición
    await refreshYouTubeStats(db, 'k', yt.fetchImpl, { now })
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get()).toEqual({ n: 1 })
  })

  it('una segunda pasada no duplica nada y mide cada 15 minutos', async () => {
    const yt = fakeYouTube({ [vid(1)]: { title: 'El primer clip de la campaña', views: 100 } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    await syncChannels(db, 'k', yt.fetchImpl, { now })
    minuto = 5
    yt.videos[vid(1)].views = 150
    expect(await syncChannels(db, 'k', yt.fetchImpl, { now })).toMatchObject({ videos: 1, linkedNow: 0, measured: 0 })
    expect(pubs()).toHaveLength(1)
    minuto = 20
    yt.videos[vid(1)].views = 400
    expect(await syncChannels(db, 'k', yt.fetchImpl, { now })).toMatchObject({ measured: 1 })
    expect((db.prepare('SELECT views FROM analytics_snapshots ORDER BY id').all() as Row[]).map((s) => s.views)).toEqual([100, 400])
    expect(await syncChannels(db, 'k', yt.fetchImpl, { now, force: true })).toMatchObject({ measured: 1 })
  })

  it('dos vídeos del canal no se asignan al mismo clip', async () => {
    const yt = fakeYouTube({ [vid(1)]: { title: 'El primer clip de la campaña' }, [vid(2)]: { title: 'El primer clip de la campaña' } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    const r = await syncChannels(db, 'k', yt.fetchImpl, { now })
    expect(r).toMatchObject({ linkedNow: 1, unmatched: 1 })
    expect(pubs()).toHaveLength(1)
  })

  it('emparejar a mano, marcar como ajeno y deshacer un emparejamiento equivocado', async () => {
    const yt = fakeYouTube({
      [vid(1)]: { title: 'Título libre que puse en YouTube', views: 321, likes: 9 },
      [vid(2)]: { title: 'Mi vlog', duration: 'PT5M' },
      [vid(3)]: { title: 'El tercer clip de la campaña', views: 50 }
    })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    await syncChannels(db, 'k', yt.fetchImpl, { now })
    let s = getStats(db)
    expect(s.unmatched.map((u) => u.videoId)).toEqual([vid(1), vid(2)])
    expect(s.clipOptions).toHaveLength(3)

    linkVideo(db, vid(1), 'clp_b', now)
    ignoreVideo(db, vid(2), true)
    s = getStats(db)
    expect(s.unmatched).toEqual([])
    expect(s.ignored).toBe(1)
    expect(s.videos.find((v) => v.clipId === 'clp_b')).toMatchObject({ views: 321, likes: 9, matchState: 'manual', videoId: vid(1) })
    expect(() => linkVideo(db, vid(1), 'clp_c', now)).toThrow(/ya está asociado/)

    // el emparejamiento automático de vid(3) resulta estar mal: se deshace y no vuelve a hacerse solo
    unlinkVideo(db, vid(3))
    expect(db.prepare("SELECT COUNT(*) AS n FROM analytics_snapshots s JOIN publications p ON p.id = s.publication_id WHERE p.clip_id = 'clp_c'").get()).toEqual({ n: 0 })
    minuto = 30
    expect(await syncChannels(db, 'k', yt.fetchImpl, { now })).toMatchObject({ linkedNow: 0, unmatched: 1 })
    expect(getStats(db).unmatched.map((u) => [u.videoId, u.state])).toEqual([[vid(3), 'review']])
  })

  it('quitar una publicación o un canal no deja nada colgando', async () => {
    const yt = fakeYouTube({ [vid(1)]: { title: 'Título libre' } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    await syncChannels(db, 'k', yt.fetchImpl, { now })
    const id = savePublication(db, { clipId: 'clp_a', platform: 'youtube' }, now)
    db.prepare('UPDATE youtube_videos SET publication_id = ? WHERE video_id = ?').run(id, vid(1))
    deletePublication(db, id)
    expect(db.prepare('SELECT publication_id, match_state FROM youtube_videos').get()).toEqual({ publication_id: null, match_state: 'review' })
    // quitar el canal conserva publicaciones y mediciones ya guardadas
    linkVideo(db, vid(1), 'clp_a', now)
    removeChannel(db, CH)
    expect(listChannels(db)).toEqual([])
    expect(pubs()).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get()).toEqual({ n: 1 })
  })

  it('más de 50 vídeos: pagina la lista y agrupa las peticiones', async () => {
    const muchos: Record<string, FakeVideo> = {}
    for (let i = 1; i <= 120; i++) muchos[vid(i)] = { title: `Vídeo suelto número ${i}`, duration: 'PT3M' }
    const yt = fakeYouTube(muchos)
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    yt.calls.length = 0
    expect(await syncChannels(db, 'k', yt.fetchImpl, { now })).toMatchObject({ videos: 120, linkedNow: 0, unmatched: 120 })
    expect(yt.calls.filter((c) => c === 'playlistItems')).toHaveLength(3)
    expect(yt.calls.filter((c) => c === 'videos')).toHaveLength(3)
  })

  it('estadísticas: totales, por campaña, por vídeo, y sin tocar score ni orden', async () => {
    const yt = fakeYouTube({
      [vid(1)]: { title: 'El primer clip de la campaña', views: 1000, likes: 40, comments: 10, publishedAt: '2026-05-30T12:00:00Z' },
      [vid(2)]: { title: 'El segundo clip de la campaña', views: 3000, likes: 60, comments: 0, publishedAt: '2026-05-31T12:00:00Z' }
    })
    savePublication(db, { clipId: 'clp_c', platform: 'tiktok' }, now) // publicado en otra plataforma, sin cifras
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    await syncChannels(db, 'k', yt.fetchImpl, { now })
    minuto = 30
    yt.videos[vid(2)].views = 3500
    await syncChannels(db, 'k', yt.fetchImpl, { now })

    const s = getStats(db, new Date(Date.UTC(2026, 5, 1, 12, 30)))
    expect(s.totals).toMatchObject({ views: 4500, likes: 100, comments: 10, measured: 2, published: 3 })
    expect(s.videos.map((v) => [v.clipId, v.platform, v.views])).toEqual([['clp_b', 'youtube', 3500], ['clp_a', 'youtube', 1000], ['clp_c', 'tiktok', null]])
    const b = s.videos[0]
    expect(b).toMatchObject({ viewsDelta: 500, measurements: 2, matchState: 'auto', score: 90 })
    expect(Math.round(b.viewsPerDay!)).toBe(3429) // 3500 visitas en un día y media hora
    expect(s.videos[1].engagement).toBeCloseTo(0.05)
    expect(s.videos[1].viewsDelta).toBe(0)
    expect(s.campaigns).toEqual([{ campaignId: 'demo', name: 'Demo', clips: 3, published: 3, measured: 2, views: 4500, likes: 100, comments: 10, bestTitle: 'El segundo clip de la campaña', bestViews: 3500, earning: null, belowMin: 0 }])
    // nada de esto cambia el score, el QA ni el orden de calidad
    expect(listClips(db, 'demo').map((k) => [k.clipId, k.score])).toEqual([['clp_a', 95], ['clp_b', 90], ['clp_c', 80]])
    expect(db.prepare('SELECT COUNT(*) AS n FROM prediction_snapshots').get()).toEqual({ n: 0 })
  })

  it('nada de esto escribe en CAMPAIGNS', async () => {
    const antes = fingerprint(root)
    const yt = fakeYouTube({ [vid(1)]: { title: 'El primer clip de la campaña' }, [vid(2)]: { title: 'Otro' } })
    await addChannel(db, '@micanal', 'k', yt.fetchImpl, now)
    await syncChannels(db, 'k', yt.fetchImpl, { now })
    linkVideo(db, vid(2), 'clp_b', now)
    getStats(db)
    expect(fingerprint(root)).toEqual(antes)
  })
})

describe('migración del esquema', () => {
  it('una base de la versión 1 con datos pasa a la 2 sin perder nada y con copia de seguridad', () => {
    const base = tmpDir('cos_mig_')
    const ruta = path.join(base, 'content-os.db')
    const backups = path.join(base, 'backups')
    const v1 = new Database(ruta)
    v1.exec(MIGRATIONS[0])
    v1.pragma('user_version = 1')
    v1.prepare("INSERT INTO library_roots (path, created_at) VALUES ('C:/x', 't')").run()
    v1.prepare("INSERT INTO campaigns (campaign_id, root_id, folder_name, source_path, campaign_json_path, created_at, updated_at, last_sync_at) VALUES ('c', 1, 'C', 'p', 'j', 't', 't', 't')").run()
    v1.prepare("INSERT INTO clips (clip_id, campaign_id, title, first_seen_at, updated_at, last_sync_at) VALUES ('clp_viejo', 'c', 'Clip de antes', 't', 't', 't')").run()
    v1.prepare("INSERT INTO publications (clip_id, platform, url, created_at, updated_at) VALUES ('clp_viejo', 'youtube', 'https://youtu.be/aaaaaaaaaaa', 't', 't')").run()
    v1.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views) VALUES (1, 't', 5180)").run()
    v1.close()

    const db = openDatabase(ruta, { backupDir: backups })
    expect(SCHEMA_VERSION).toBe(16)
    expect(db.pragma("user_version", { simple: true })).toBe(16)
    expect(db.prepare('SELECT title FROM clips').get()).toEqual({ title: 'Clip de antes' })
    expect(db.prepare('SELECT views FROM analytics_snapshots').get()).toEqual({ views: 5180 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM youtube_channels').get()).toEqual({ n: 0 })
    expect(getStats(db).totals).toMatchObject({ views: 5180, measured: 1 })
    db.close()
    const copias = fs.readdirSync(backups)
    expect(copias).toHaveLength(1)
    expect(copias[0]).toMatch(/^content-os_v1_.*\.db$/)
    // abrirla otra vez no vuelve a migrar ni a copiar
    openDatabase(ruta, { backupDir: backups }).close()
    expect(fs.readdirSync(backups)).toHaveLength(1)
    fs.rmSync(base, { recursive: true, force: true })
  })
})
