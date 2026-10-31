/** TikTok: leer las cifras públicas de un vídeo y apuntarlo en su clip a partir de la URL. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSnapshots } from '../src/core/analytics'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { listAccounts } from '../src/core/plan'
import { savePublication } from '../src/core/publications'
import { getClip } from '../src/core/queries'
import { getStats } from '../src/core/stats'
import { addTikTokVideo, fetchTikTokVideo, matchTikTokToClip, parseTikTokPage, parseTikTokUrl, refreshTikTokStats, TikTokError } from '../src/core/tiktok'
import type { TextFetch } from '../src/core/vyro'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

const PAGINA = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiktok-video.html'), 'utf8')
const URL1 = 'https://www.tiktok.com/@democlipss/video/7111111111111111111'
const CAPTION = 'Ketone-IQ really started like THIS 💀 $2 million for 5%. The Sharks were out.'

let base: string
let root: string
let db: DB
let camp: CampaignFixture

/** Página de un vídeo con las cifras que se quieran. */
const pagina = (cambios: { id?: string; views?: number; likes?: number; desc?: string; dur?: number; status?: number } = {}) =>
  PAGINA.replace(/"playCount":"1"/, `"playCount":"${cambios.views ?? 1}"`).replace(/"diggCount":"0"/, `"diggCount":"${cambios.likes ?? 0}"`)
    .replace(/7111111111111111111/g, cambios.id ?? '7111111111111111111').replace(/"duration":29/, `"duration":${cambios.dur ?? 29}`)
    .replace(/"statusCode":0/, `"statusCode":${cambios.status ?? 0}`)
    .replace(/"desc":"[^"]*"/, `"desc":${JSON.stringify(cambios.desc ?? CAPTION + ' #fyp #mrbeast')}`)
const sirve = (html: string | (() => string), vistas: string[] = []): TextFetch => async (url) => {
  vistas.push(url)
  return { ok: true, status: 200, text: async () => (typeof html === 'string' ? html : html()) }
}

beforeEach(() => {
  base = tmpDir('cos_tiktok_')
  root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  camp = new CampaignFixture(root, 'KIQ', 'kiq', 'Ketone-IQ - Cinematic edits')
  camp.addClip({ n: 1, clipId: 'clp_k1', title: 'They asked Shark Tank for $2 million' })
  camp.addClip({ n: 2, clipId: 'clp_k2', title: 'Shark Tank absolutely COOKED these nerds' })
  camp.addClip({ n: 3, clipId: 'clp_k3', title: 'Flying very close to the sun' })
  camp.patchMeta(1, { caption: CAPTION, hashtags: [], duration: 29.0 })
  camp.patchMeta(2, { caption: 'The nerds were onto something 👀', hashtags: [], duration: 19.77 })
  camp.patchMeta(3, { caption: 'The nerds were onto something 👀', hashtags: [], duration: 21.27 })
  syncLibraries(db, { roots: [root] })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('TikTok', () => {
  it('reconoce la URL de un vídeo y nada más', () => {
    expect(parseTikTokUrl(URL1 + '?is_from_webapp=1&sender_device=pc')).toEqual({ author: 'democlipss', videoId: '7111111111111111111', url: URL1 })
    expect(parseTikTokUrl('  http://tiktok.com/@a.b_c/video/1234567  ')).toMatchObject({ author: 'a.b_c', videoId: '1234567' })
    for (const mala of ['https://www.tiktok.com/@democlipss', 'https://vm.tiktok.com/ZMabc/', 'https://www.youtube.com/shorts/abc', 'https://evil.com/?https://www.tiktok.com/@a/video/1234567', '', null]) {
      expect(parseTikTokUrl(mala)).toBeNull()
    }
  })

  it('lee las cifras de la página real guardada', () => {
    expect(parseTikTokPage(PAGINA)).toEqual({
      videoId: '7111111111111111111', author: 'democlipss', url: URL1, description: CAPTION + ' #fyp #mrbeast',
      createdAt: new Date(1791499501 * 1000).toISOString(), durationSeconds: 29, views: 1, likes: 0, comments: 0, shares: 0, saves: 0
    })
  })

  it('distingue bloqueo, vídeo inexistente y fallo de red; solo pide la URL del vídeo y sin credenciales', async () => {
    expect(() => parseTikTokPage('<html>Verify to continue</html>')).toThrow(/no ha dejado leer/)
    expect(() => parseTikTokPage(pagina({ status: 10204 }))).toThrow(/privado, se borró/)
    const vistas: string[] = []
    const cabeceras: Record<string, string>[] = []
    await fetchTikTokVideo(URL1 + '?x=1', async (url, init) => {
      vistas.push(url)
      cabeceras.push(init.headers)
      return { ok: true, status: 200, text: async () => PAGINA }
    })
    expect(vistas).toEqual([URL1])
    expect(Object.keys(cabeceras[0]).map((h) => h.toLowerCase()).sort()).toEqual(['accept', 'accept-language', 'user-agent'])
    await expect(fetchTikTokVideo('https://example.com/x', sirve(PAGINA))).rejects.toMatchObject({ code: 'url' })
    await expect(fetchTikTokVideo(URL1, async () => ({ ok: false, status: 403, text: async () => '' }))).rejects.toMatchObject({ code: 'blocked' })
    await expect(fetchTikTokVideo(URL1, async () => { throw new Error('sin red') })).rejects.toMatchObject({ code: 'network' })
    await expect(fetchTikTokVideo(URL1, sirve(pagina({ id: '111111111' })))).rejects.toBeInstanceOf(TikTokError) // devolvió otro vídeo
  })

  it('empareja por descripción y duración; con la misma descripción decide la duración, y si no está claro no adivina', () => {
    const clips = [{ clipId: 'a', caption: CAPTION, duration: 29 }, { clipId: 'b', caption: 'The nerds were onto something 👀', duration: 19.77 }, { clipId: 'c', caption: 'The nerds were onto something 👀', duration: 21.27 }]
    expect(matchTikTokToClip({ description: CAPTION + ' #fyp', durationSeconds: 29 }, clips)).toBe('a')
    expect(matchTikTokToClip({ description: 'The nerds were onto something 👀', durationSeconds: 21 }, clips)).toBe('c')
    expect(matchTikTokToClip({ description: 'The nerds were onto something 👀', durationSeconds: 19 }, clips)).toBe('b')
    expect(matchTikTokToClip({ description: 'The nerds were onto something 👀', durationSeconds: null }, clips)).toBeNull()
    expect(matchTikTokToClip({ description: CAPTION, durationSeconds: 45 }, clips)).toBeNull() // otra duración: no es ese clip
    expect(matchTikTokToClip({ description: 'algo mío', durationSeconds: 29 }, clips)).toBeNull()
  })

  it('pegar la URL deja la publicación hecha: clip, cuenta, fecha, cifras y aviso de hashtags ajenos', async () => {
    const antes = fingerprint(root)
    const r = await addTikTokVideo(db, URL1 + '?lang=es', sirve(pagina({ views: 812, likes: 40 })), () => '2026-10-09T10:00:00.000Z')
    expect(r).toEqual({ clipId: 'clp_k1', title: 'They asked Shark Tank for $2 million', account: '@democlipss', views: 812, existed: false, extraHashtags: ['#fyp', '#mrbeast'] })
    const pub = getClip(db, 'clp_k1')!.publications[0]
    expect(pub).toMatchObject({ platform: 'tiktok', account: '@democlipss', url: URL1, publishedAt: new Date(1791499501 * 1000).toISOString(), captionUsed: CAPTION + ' #fyp #mrbeast' })
    expect(pub.latest).toMatchObject({ views: 812, likes: 40, comments: 0, origin: 'tiktok_page' })
    expect(listAccounts(db)).toMatchObject([{ platform: 'tiktok', name: '@democlipss' }]) // el canal entra solo en el plan
    expect(getStats(db).videos[0]).toMatchObject({ clipId: 'clp_k1', platform: 'tiktok', views: 812 })
    // otra vez la misma URL: no duplica, añade medición
    const r2 = await addTikTokVideo(db, URL1, sirve(pagina({ views: 900 })), () => '2026-10-09T11:00:00.000Z')
    expect(r2).toMatchObject({ existed: true, views: 900 })
    expect(getClip(db, 'clp_k1')!.publications).toHaveLength(1)
    expect(listSnapshots(db, pub.id).map((s) => s.views)).toEqual([812, 900])
    expect(fingerprint(root)).toEqual(antes)
  })

  it('si ya lo marcaste subido sin URL, se la pone a esa publicación; y si no sabe de qué clip es, lo dice', async () => {
    const id = savePublication(db, { clipId: 'clp_k1', platform: 'tiktok', account: '@Democlipss' })
    const r = await addTikTokVideo(db, URL1, sirve(pagina({ views: 5, desc: CAPTION })))
    expect(r).toMatchObject({ existed: true, extraHashtags: [] })
    expect(getClip(db, 'clp_k1')!.publications).toMatchObject([{ id, url: URL1 }])
    await expect(addTikTokVideo(db, 'https://www.tiktok.com/@democlipss/video/7000000000000000001', sirve(pagina({ id: '7000000000000000001', desc: 'otra cosa' }))))
      .rejects.toMatchObject({ code: 'no_match' })
  })

  it('actualizar: mide las que tienen URL, respeta el intervalo y para si TikTok bloquea', async () => {
    const t0 = '2026-10-09T10:00:00.000Z'
    await addTikTokVideo(db, URL1, sirve(pagina({ views: 100 })), () => t0)
    savePublication(db, { clipId: 'clp_k2', platform: 'tiktok', account: '@democlipss' }) // sin URL
    savePublication(db, { clipId: 'clp_k3', platform: 'youtube', account: '@yt', url: 'https://www.youtube.com/shorts/abcdefghijk' })
    const vistas: string[] = []
    // medido hace 10 minutos: no se vuelve a pedir
    expect(await refreshTikTokStats(db, sirve(pagina({ views: 150 }), vistas), { now: () => '2026-10-09T10:10:00.000Z', pauseMs: 0 }))
      .toEqual({ publications: 2, measured: 0, skippedRecent: 1, withoutUrl: 1, failed: 0, error: null })
    expect(vistas).toEqual([])
    // pasada media hora, sí
    expect(await refreshTikTokStats(db, sirve(pagina({ views: 150 }), vistas), { now: () => '2026-10-09T10:40:00.000Z', pauseMs: 0 })).toMatchObject({ measured: 1 })
    expect(vistas).toEqual([URL1])
    expect(getClip(db, 'clp_k1')!.publications[0].latest).toMatchObject({ views: 150 })
    // bloqueo: se apunta el error, no se guarda nada y lo anterior sigue ahí
    const bloqueada = await refreshTikTokStats(db, sirve('<html>captcha</html>'), { force: true, pauseMs: 0 })
    expect(bloqueada).toMatchObject({ measured: 0, failed: 1 })
    expect(bloqueada.error).toMatch(/no ha dejado leer/)
    expect(getClip(db, 'clp_k1')!.publications[0].latest).toMatchObject({ views: 150 })
  })
})
