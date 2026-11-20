/** Canales propios (GTA 6, Curiosidades, Roblox): cuentas, subidas por red, cifras (API y a mano), mejor hora y «Añadir vídeos». */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { listLongVideos } from '../src/core/long-videos'
import { addOwnAccount, addOwnStats, autoLinkOwn, getOwnChannelStats, listOwnAccounts, matureViews, normalizeAccount, setOwnPost } from '../src/core/own-channels'
import { importOwnVideos, listVideoFiles, nextNumber, titleFromFile } from '../src/core/own-import'
import { tmpDir } from './fixtures/builder'

let base: string
let db: DB

beforeEach(() => {
  base = tmpDir('cos_own_')
  db = openDatabase(':memory:')
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

const VIDEOS = [
  { id: '38 · Mapa', title: 'Si has estado en Miami, ya conoces medio GTA 6', description: 'El mapa de GTA 6 copia Miami calle a calle 🗺️ Mira la comparación.' },
  { id: '39 · Lucía', title: 'Desde 2001, en GTA siempre habías sido un hombre. Hasta ahora', description: null }
]

describe('cuentas', () => {
  it('se guardan con @ y aceptan el enlace del perfil', () => {
    expect(normalizeAccount('tiktok', 'https://www.tiktok.com/@noticiasdemo')).toBe('@noticiasdemo')
    expect(normalizeAccount('youtube', 'canalgta')).toBe('@canalgta')
    expect(normalizeAccount('youtube', 'UC1234567890123456789012')).toBe('UC1234567890123456789012')
    expect(normalizeAccount('instagram', 'con espacios')).toBeNull()
    expect(() => addOwnAccount(db, 'gta', 'tiktok', '')).toThrow()
    addOwnAccount(db, 'gta', 'tiktok', 'noticiasdemo')
    addOwnAccount(db, 'gta', 'tiktok', '@NoticiasDemo') // la misma, no se repite
    const cuentas = listOwnAccounts(db, 'gta')
    expect(cuentas.map((c) => [c.platform, c.account, c.source])).toEqual([['tiktok', '@noticiasdemo', 'manual']])
    expect(cuentas[0].note).toMatch(/a mano/)
    // si la cuenta está conectada con la API, sus cifras llegan solas
    expect(listOwnAccounts(db, 'gta', [{ platform: 'tiktok', account: '@noticiasdemo' }])[0].source).toBe('api')
  })
})

describe('subidas y cifras a mano', () => {
  it('marcar con enlace guarda el id del vídeo; las cifras a mano se suman y la retención va aparte', () => {
    addOwnAccount(db, 'gta', 'tiktok', '@noticiasdemo')
    setOwnPost(db, { channel: 'gta', video: VIDEOS[0].id, platform: 'tiktok', uploaded: true, url: 'https://www.tiktok.com/@noticiasdemo/video/7300000000000000001' }, '2026-11-19T09:00:00.000Z')
    const post = db.prepare('SELECT * FROM own_posts').get() as Record<string, unknown>
    expect([post.account, post.ext_id, post.source]).toEqual(['@noticiasdemo', '7300000000000000001', 'manual'])

    expect(() => addOwnStats(db, { channel: 'gta', video: VIDEOS[0].id, platform: 'tiktok', retention: '140' })).toThrow(/porcentaje/)
    addOwnStats(db, { channel: 'gta', video: VIDEOS[0].id, platform: 'tiktok', views: '12.400', likes: '830', comments: '', retention: '72,5' }, '2026-11-21T09:00:00.000Z')
    addOwnStats(db, { channel: 'gta', video: VIDEOS[0].id, platform: 'youtube', views: '600' }, '2026-11-21T10:00:00.000Z')
    const s = getOwnChannelStats(db, 'gta', VIDEOS)
    const v = s.videos.find((x) => x.id === VIDEOS[0].id)!
    expect([v.views, v.likes, v.retention, v.shares]).toEqual([13000, 830, 72.5, null])
    const tt = v.posts.find((p) => p.platform === 'tiktok')!
    expect(tt.origin).toEqual({ views: 'manual', likes: 'manual', retention: 'manual' })
    expect(s.sources.tiktok.retention).toEqual(['manual'])
    // el vídeo sin subir no tiene cifras (null, no cero)
    expect(s.videos.find((x) => x.id === VIDEOS[1].id)!.views).toBeNull()
    // desmarcar quita la subida y sus cifras
    setOwnPost(db, { channel: 'gta', video: VIDEOS[0].id, platform: 'youtube', uploaded: false })
    expect(getOwnChannelStats(db, 'gta', VIDEOS).videos[0].views).toBe(12400)
  })
})

describe('emparejar con lo que dan las API', () => {
  it('YouTube y TikTok: una sola coincidencia clara se empareja y trae sus mediciones', () => {
    addOwnAccount(db, 'gta', 'youtube', '@canalgta')
    addOwnAccount(db, 'gta', 'tiktok', '@noticiasdemo')
    db.prepare("INSERT INTO youtube_channels (channel_id, handle, title, uploads_playlist, added_at, kind, subscribers, stats_at) VALUES ('UCgta', '@canalgta', 'GTA', 'UUgta', 'x', 'personal', 150, '2026-11-21T00:00:00Z')").run()
    db.prepare("INSERT INTO youtube_videos (video_id, channel_id, title, published_at, first_seen_at, last_seen_at) VALUES ('yt000000001', 'UCgta', 'Si has estado en Miami, ya conoces medio GTA 6 #gta6', '2026-11-19T13:00:00Z', 'x', 'x'), ('yt000000002', 'UCgta', 'Otro vídeo cualquiera', '2026-11-18T13:00:00Z', 'x', 'x')").run()
    db.prepare("INSERT INTO youtube_video_snapshots (video_id, measured_at, views, likes, comments) VALUES ('yt000000001', '2026-11-20T13:00:00Z', 400, 20, 3), ('yt000000001', '2026-11-21T13:00:00Z', 900, 41, 5)").run()
    db.prepare("INSERT INTO social_videos (platform, video_id, account, url, description, published_at, first_seen_at, last_seen_at) VALUES ('tiktok', '7311', '@noticiasdemo', 'https://www.tiktok.com/@noticiasdemo/video/7311', 'El mapa de GTA 6 copia Miami calle a calle 🗺️ Mira la comparación. #gta6', '2026-11-19T09:00:00Z', 'x', 'x')").run()
    db.prepare("INSERT INTO social_video_snapshots (platform, video_id, measured_at, views, likes, comments, shares) VALUES ('tiktok', '7311', '2026-11-21T09:00:00Z', 5000, 300, 12, 40)").run()

    expect(autoLinkOwn(db, 'gta', VIDEOS)).toBe(2)
    expect(autoLinkOwn(db, 'gta', VIDEOS)).toBe(0)
    const s = getOwnChannelStats(db, 'gta', VIDEOS)
    const v = s.videos[0]
    expect(v.posts.map((p) => [p.platform, p.source, p.latest.views]).sort()).toEqual([['tiktok', 'api', 5000], ['youtube', 'api', 900]])
    expect(v.shares).toBe(40)
    expect(s.sources.youtube.views).toEqual(['api'])
    // evolución: días medidos, sumando la última medición de cada red
    expect(s.daily.map((d) => [d.day, d.total])).toEqual([['2026-11-20', 400], ['2026-11-21', 5900]])
    expect(s.followers.find((f) => f.platform === 'youtube')!.series.at(-1)!.value).toBe(150)
    // y la lista de vídeos ya lo ve como subido
    const dir = path.join(base, 'VIDEOS_GTA6', VIDEOS[0].id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'v.mp4'), Buffer.alloc(10))
    expect(listLongVideos(db, path.join(base, 'VIDEOS_GTA6'), 'gta').videos[0].uploads).toMatchObject({ youtube: '2026-11-19T13:00:00Z', tiktok: '2026-11-19T09:00:00Z' })
  })

  it('si un vídeo de la red encaja con dos carpetas, no se empareja', () => {
    addOwnAccount(db, 'curio', 'youtube', '@curio')
    db.prepare("INSERT INTO youtube_channels (channel_id, handle, uploads_playlist, added_at, kind) VALUES ('UCc', '@curio', 'UUc', 'x', 'personal')").run()
    db.prepare("INSERT INTO youtube_videos (video_id, channel_id, title, first_seen_at, last_seen_at) VALUES ('ytc00000001', 'UCc', 'Toda la humanidad cabría', 'x', 'x')").run()
    const dos = [{ id: 'a', title: 'Toda la humanidad cabría', description: null }, { id: 'b', title: 'Toda la humanidad cabría', description: null }]
    expect(autoLinkOwn(db, 'curio', dos)).toBe(0)
  })
})

describe('mejor hora', () => {
  it('usa la medición más cercana a las 48 h (entre 24 y 96 h) y agrupa por franjas de 3 horas', () => {
    expect(matureViews('2026-11-01T10:00:00Z', [{ t: '2026-11-01T20:00:00Z', views: 5 }, { t: '2026-11-03T08:00:00Z', views: 100 }, { t: '2026-11-03T11:00:00Z', views: 120 }])).toBe(120)
    expect(matureViews('2026-11-01T10:00:00Z', [{ t: '2026-11-01T20:00:00Z', views: 5 }])).toBeNull()
    for (const [i, v] of [100, 300, 200].entries()) {
      const id = `v${i}`
      const hora = new Date(2026, 10, 1 + i, 13, 0).toISOString()
      setOwnPost(db, { channel: 'curio', video: id, platform: 'instagram', uploaded: true }, hora)
      addOwnStats(db, { channel: 'curio', video: id, platform: 'instagram', views: v }, new Date(Date.parse(hora) + 47 * 3600_000).toISOString())
    }
    const s = getOwnChannelStats(db, 'curio', [0, 1, 2].map((i) => ({ id: `v${i}`, title: `V${i}`, description: null })))
    expect(s.bestHours.find((h) => h.from === 12)).toEqual({ from: 12, videos: 3, median: 200 })
    expect(s.bestHours.find((h) => h.from === 0)).toEqual({ from: 0, videos: 0, median: null })
  })
})

describe('«Añadir vídeos»', () => {
  it('enlaza o copia el MP4 a su carpeta numerada con video.json, sin tocar el original ni repetirlo', () => {
    const canal = path.join(base, 'VIDEOS_ROBLOX')
    fs.mkdirSync(path.join(canal, '013 · Charco'), { recursive: true })
    expect(nextNumber(canal)).toBe('014')
    expect(nextNumber(path.join(base, 'no-existe'))).toBe('01')
    const origen = path.join(base, 'Descargas', 'historia_nueva-v2.mp4')
    fs.mkdirSync(path.dirname(origen))
    fs.writeFileSync(origen, Buffer.alloc(1234))
    fs.writeFileSync(path.join(base, 'Descargas', 'nota.txt'), 'x')
    expect(titleFromFile(origen)).toBe('historia nueva v2')
    expect(listVideoFiles([path.join(base, 'Descargas')]).map((v) => [v.name, v.sizeBytes])).toEqual([['historia_nueva-v2.mp4', 1234]])

    const r = importOwnVideos(canal, 'roblox', [{ path: origen, title: 'Su Gato: lo SALVÓ?' }, { path: path.join(base, 'Descargas', 'nota.txt') }])
    expect(r.created.map((c) => c.id)).toEqual(['014 · Su Gato lo SALVÓ'])
    expect(r.skipped[0].reason).toMatch(/MP4/)
    const dir = path.join(canal, '014 · Su Gato lo SALVÓ')
    expect(fs.statSync(path.join(dir, 'historia_nueva-v2.mp4')).size).toBe(1234)
    expect(fs.existsSync(origen)).toBe(true)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'video.json'), 'utf8'))
    expect([meta.channel, meta.titles, meta.file]).toEqual(['Historias Roblox', ['Su Gato: lo SALVÓ?'], 'historia_nueva-v2.mp4'])
    // la app lo ve en el canal
    expect(listLongVideos(db, canal, 'roblox').videos.map((v) => v.titles[0]?.text)).toContain('Su Gato: lo SALVÓ?')
    // otra vez el mismo archivo: no se duplica
    expect(importOwnVideos(canal, 'roblox', [{ path: origen }]).skipped[0].reason).toMatch(/Ya estaba/)
  })
})
