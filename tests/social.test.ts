/** TikTok e Instagram por API oficial: leer, emparejar con el clip, medir, ver repetidos. Sin red. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { savePublication } from '../src/core/publications'
import {
  fetchInstagramAccount, fetchTikTokAccount, getSocialDashboards, linkSocialVideo, matchSocialToClip,
  noteSocialFollowers, saveSocialAccount, unlinkSocialVideo, type SocialFetch
} from '../src/core/social'
import { CampaignFixture, tmpDir } from './fixtures/builder'

type Row = Record<string, any>
const CAP_A = 'A man is drowning and the masquerade ferry is boarding. Stewie and Brian do the math.'
const CAP_B = "Kieran Culkin's Satan has had enough and hands the job to Stewie and Brian."
const CAP_C = 'Stewie and Brian wake up somewhere strange, next to a man with a very specific last memory.'
const MANDATORY = ' Stream the Family Guy Halloween Special on Hulu #FamilyGuy #HuluPartner'

interface FakeTT { id: string; desc: string; t?: number; dur?: number; views?: number; likes?: number }

/** TikTok de mentira: user/info y video/list paginado de 2 en 2. */
function fakeTikTok(videos: FakeTT[]) {
  const calls: string[] = []
  const f: SocialFetch = async (url, init) => {
    calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`)
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    if (url.includes('/user/info/')) return ok({ data: { user: { display_name: 'Democlipss', follower_count: 7, likes_count: 655, video_count: videos.length } }, error: { code: 'ok' } })
    const cursor = JSON.parse(init.body ?? '{}').cursor ?? 0
    const pagina = videos.slice(cursor, cursor + 2)
    return ok({
      data: {
        videos: pagina.map((v) => ({ id: v.id, video_description: v.desc, create_time: v.t ?? 1793265987, duration: v.dur ?? 15, view_count: v.views ?? 100, like_count: v.likes ?? 5, comment_count: 0, share_count: 1, share_url: `https://www.tiktok.com/@democlipss/video/${v.id}?utm_source=x` })),
        cursor: cursor + 2, has_more: cursor + 2 < videos.length
      },
      error: { code: 'ok', message: '' }
    })
  }
  return { f, calls }
}

describe('lectura de las API', () => {
  it('TikTok: perfil y todos los vídeos (paginado), con enlace limpio', async () => {
    const tt = fakeTikTok([{ id: '1', desc: 'uno' }, { id: '2', desc: 'dos' }, { id: '3', desc: 'tres', views: 744 }])
    const d = await fetchTikTokAccount('democlipss', 'tok', tt.f)
    expect(d.account).toBe('@democlipss')
    expect(d.followers).toBe(7)
    expect(d.items.map((i) => i.videoId)).toEqual(['1', '2', '3'])
    expect(d.items[2].views).toBe(744)
    expect(d.items[0].url).toBe('https://www.tiktok.com/@democlipss/video/1')
    expect(tt.calls.filter((c) => c.startsWith('POST'))).toHaveLength(2)
  })

  it('TikTok: un error de la API se explica', async () => {
    const f: SocialFetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'access_token_invalid', message: 'The access token is invalid' } }) })
    await expect(fetchTikTokAccount('x', 'tok', f)).rejects.toThrow(/access token is invalid/)
  })

  it('Instagram: encuentra la cuenta aunque Meta no liste la página, y las visitas quedan sin medir', async () => {
    const f: SocialFetch = async (url) => {
      const u = new URL(url)
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
      if (u.pathname.endsWith('/me/accounts')) return ok({ data: [] })
      if (u.pathname.endsWith('/debug_token')) return ok({ data: { granular_scopes: [{ scope: 'pages_show_list', target_ids: ['PAGE1'] }] } })
      if (u.pathname.endsWith('/PAGE1')) return ok({ instagram_business_account: { id: 'IG1' } })
      if (u.pathname.endsWith('/IG1')) return ok({ username: 'democlips', followers_count: 1, media_count: 2 })
      if (u.pathname.endsWith('/IG1/media')) {
        return u.searchParams.get('after')
          ? ok({ data: [{ id: 'm2', caption: 'dos', permalink: 'https://www.instagram.com/reel/B/', timestamp: '2026-10-13T20:11:00+0000', like_count: 1, comments_count: 0 }] })
          : ok({ data: [{ id: 'm1', caption: 'uno', permalink: 'https://www.instagram.com/reel/A/', timestamp: '2026-10-22T16:47:00+0000', like_count: 3, comments_count: 1 }], paging: { next: 'https://graph.facebook.com/v26.0/IG1/media?after=X' } })
      }
      return { ok: false, status: 404, json: async () => ({ error: { message: 'no' } }) }
    }
    const d = await fetchInstagramAccount('EAAtok', f)
    expect(d.account).toBe('@democlips')
    expect(d.items.map((i) => i.videoId)).toEqual(['m1', 'm2'])
    expect(d.items.every((i) => i.views === null)).toBe(true)
    expect(d.items[0].likes).toBe(3)
  })
})

describe('guardar y emparejar', () => {
  let base: string
  let db: DB
  let t = 0
  const now = () => new Date(Date.UTC(2026, 9, 29, 10, 0) + t * 3600_000).toISOString()

  beforeEach(() => {
    t = 0
    base = tmpDir('cos_social_')
    const root = path.join(base, 'CAMPAIGNS')
    fs.mkdirSync(root, { recursive: true })
    db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
    const camp = new CampaignFixture(root, 'FG', 'fg', 'Family Guy')
    camp.addClip({ n: 1, clipId: 'clp_a', title: 'Save him or make the party?' })
    camp.addClip({ n: 2, clipId: 'clp_b', title: 'Satan quits' })
    camp.addClip({ n: 3, clipId: 'clp_c', title: 'The worst answer' })
    syncLibraries(db, { roots: [root], now })
    for (const [id, cap] of [['clp_a', CAP_A], ['clp_b', CAP_B], ['clp_c', CAP_C]]) db.prepare('UPDATE clips SET caption = ?, duration = 15 WHERE clip_id = ?').run(cap, id)
  })
  afterEach(() => {
    db.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  const cuenta = (items: { id: string; desc: string; views?: number | null; t?: string; dur?: number | null }[], platform: 'tiktok' | 'instagram' = 'tiktok') => ({
    platform, account: platform === 'tiktok' ? '@democlipss' : '@democlips', displayName: null, followers: 7, totalLikes: null, videoCount: items.length,
    items: items.map((i) => ({
      videoId: i.id, url: platform === 'tiktok' ? `https://www.tiktok.com/@democlipss/video/${i.id}` : `https://www.instagram.com/reel/${i.id}/`,
      description: i.desc, publishedAt: i.t ?? '2026-10-29T08:26:00.000Z', durationSeconds: i.dur === undefined ? 15 : i.dur,
      views: i.views === undefined ? 744 : i.views, likes: 35, comments: 0, shares: platform === 'tiktok' ? 0 : null
    }))
  })

  it('empareja por descripción (con la frase obligatoria y hashtags), crea la publicación y la mide', () => {
    const r = saveSocialAccount(db, cuenta([{ id: '7020000701', desc: CAP_A + MANDATORY }, { id: '7020000702', desc: 'Un vídeo que no es de ninguna campaña' }]), { now })
    expect(r).toMatchObject({ videos: 2, linkedNow: 1, unmatched: 1, measured: 1 })
    const pub = db.prepare("SELECT * FROM publications WHERE platform = 'tiktok'").get() as Row
    expect(pub).toMatchObject({ clip_id: 'clp_a', account: '@democlipss', status: 'published', url: 'https://www.tiktok.com/@democlipss/video/7020000701' })
    const m = db.prepare('SELECT * FROM analytics_snapshots WHERE publication_id = ?').get(pub.id) as Row
    expect(m).toMatchObject({ views: 744, likes: 35, origin: 'tiktok_api' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE platform = ? AND name = ?').get('tiktok', '@democlipss')).toEqual({ n: 1 })
  })

  it('una publicación marcada a mano (sin enlace) se completa en vez de duplicarse', () => {
    savePublication(db, { clipId: 'clp_b', platform: 'tiktok', account: '@democlipss', publishedAt: '2026-10-29T08:26:00.000Z' }, now)
    saveSocialAccount(db, cuenta([{ id: '7020000703', desc: CAP_B + MANDATORY }]), { now })
    const pubs = db.prepare("SELECT * FROM publications WHERE platform = 'tiktok'").all() as Row[]
    expect(pubs).toHaveLength(1)
    expect(pubs[0].url).toBe('https://www.tiktok.com/@democlipss/video/7020000703')
  })

  it('una URL puesta a mano manda sobre el texto', () => {
    savePublication(db, { clipId: 'clp_c', platform: 'tiktok', account: '@democlipss', url: 'https://www.tiktok.com/@democlipss/video/7020000704' }, now)
    saveSocialAccount(db, cuenta([{ id: '7020000704', desc: 'texto cambiado del todo' }]), { now })
    const v = db.prepare("SELECT * FROM social_videos WHERE video_id = '7020000704'").get() as Row
    expect(v.match_state).toBe('manual')
    expect((db.prepare('SELECT clip_id FROM publications WHERE id = ?').get(v.publication_id) as Row).clip_id).toBe('clp_c')
  })

  it('REGLA Nº1: el mismo clip dos veces queda el primero emparejado y el segundo marcado como repetido', () => {
    saveSocialAccount(db, cuenta([
      { id: '801', desc: CAP_A + MANDATORY, t: '2026-10-20T00:35:00.000Z' },
      { id: '802', desc: CAP_A + MANDATORY, t: '2026-10-21T00:35:00.000Z' }
    ]), { now })
    const [c] = getSocialDashboards(db, new Date(now()))
    const v801 = c.videos.find((v) => v.videoId === '801')!
    const v802 = c.videos.find((v) => v.videoId === '802')!
    expect(v801.clipId).toBe('clp_a')
    expect(v801.repeatOf).toBeNull()
    expect(v802.clipId).toBeNull()
    expect(v802.repeatOf).toBe('801')
  })

  it('un vídeo borrado en la plataforma sale del panel y deja de contar como repetido; si vuelve, reaparece', () => {
    const dos = [{ id: '8100000001', desc: CAP_A, t: '2026-10-20T00:35:00.000Z' }, { id: '8100000002', desc: CAP_A, t: '2026-10-21T00:35:00.000Z' }]
    saveSocialAccount(db, cuenta(dos), { now })
    expect(getSocialDashboards(db)[0].videos.filter((v) => v.repeatOf)).toHaveLength(1)
    t = 1
    saveSocialAccount(db, cuenta([dos[0]]), { now })
    let c = getSocialDashboards(db)[0]
    expect(c.videos.map((v) => v.videoId)).toEqual(['8100000001'])
    expect(c.videos.filter((v) => v.repeatOf)).toHaveLength(0)
    t = 2
    saveSocialAccount(db, cuenta(dos), { now })
    c = getSocialDashboards(db)[0]
    expect(c.videos).toHaveLength(2)
  })

  it('el panel da la ganancia del último día y no repite mediciones demasiado seguidas', () => {
    saveSocialAccount(db, cuenta([{ id: '901', desc: CAP_A, views: 100 }]), { now })
    t = 0.1
    expect(saveSocialAccount(db, cuenta([{ id: '901', desc: CAP_A, views: 110 }]), { now }).measured).toBe(0)
    t = 24
    saveSocialAccount(db, cuenta([{ id: '901', desc: CAP_A, views: 900 }]), { now })
    const [c] = getSocialDashboards(db, new Date(now()))
    expect(c.videos[0].gain).toEqual({ views: 800, hours: 24 })
    expect(c.totalViews).toBe(900)
  })

  it('Instagram: empareja sin duración y guarda likes sin inventar visitas', () => {
    saveSocialAccount(db, cuenta([{ id: 'ABC', desc: CAP_C + MANDATORY, views: null, dur: null }], 'instagram'), { now })
    const pub = db.prepare("SELECT * FROM publications WHERE platform = 'instagram'").get() as Row
    expect(pub.clip_id).toBe('clp_c')
    const m = db.prepare('SELECT * FROM analytics_snapshots WHERE publication_id = ?').get(pub.id) as Row
    expect(m).toMatchObject({ views: null, likes: 35, origin: 'instagram_api' })
    const [c] = getSocialDashboards(db, new Date(now()))
    expect(c.totalViews).toBeNull()
  })

  it('emparejar a mano y deshacer', () => {
    saveSocialAccount(db, cuenta([{ id: '950', desc: 'sin texto reconocible' }]), { now })
    linkSocialVideo(db, 'tiktok', '950', 'clp_b', now)
    let v = db.prepare("SELECT * FROM social_videos WHERE video_id = '950'").get() as Row
    expect(v.match_state).toBe('manual')
    unlinkSocialVideo(db, 'tiktok', '950')
    v = db.prepare("SELECT * FROM social_videos WHERE video_id = '950'").get() as Row
    expect(v).toMatchObject({ publication_id: null, match_state: 'review' })
    // 'review' ya no se vuelve a emparejar solo
    saveSocialAccount(db, cuenta([{ id: '950', desc: CAP_B }]), { now })
    expect((db.prepare("SELECT publication_id FROM social_videos WHERE video_id = '950'").get() as Row).publication_id).toBeNull()
  })

  it('historial de seguidores y su cambio en el panel', () => {
    const d = cuenta([])
    noteSocialFollowers(db, { ...d, followers: 7 }, now)
    saveSocialAccount(db, { ...d, followers: 7 }, { now })
    t = 30
    noteSocialFollowers(db, { ...d, followers: 12 }, now)
    saveSocialAccount(db, { ...d, followers: 12 }, { now })
    const [c] = getSocialDashboards(db, new Date(now()))
    expect(c.followers).toBe(12)
    expect(c.followersChange?.delta).toBe(5)
  })

  it('matchSocialToClip no elige cuando dos clips encajan igual', () => {
    const clips = [{ clipId: 'x', title: null, caption: CAP_A, duration: 15 }, { clipId: 'y', title: null, caption: CAP_A, duration: 15 }]
    expect(matchSocialToClip({ description: CAP_A, durationSeconds: 15 }, clips)).toBeNull()
  })
})
