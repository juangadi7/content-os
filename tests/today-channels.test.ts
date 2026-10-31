/** «Hoy»: a qué canal de YouTube seguido corresponde cada canal del plan (para su imagen) y de dónde se baja esa imagen. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCampaignStatus } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getPlan, listAccounts, saveAccount, setCampaignAccounts } from '../src/core/plan'
import { fetchChannelAvatars, isAvatarUrl, isChannelId, type FetchLike } from '../src/core/youtube'
import { CampaignFixture, tmpDir } from './fixtures/builder'

const A = 'UC' + 'a'.repeat(22)
const B = 'UC' + 'b'.repeat(22)
const P = 'UC' + 'p'.repeat(22)
const HOY = new Date(2026, 9, 14, 13, 0)

let base: string
let db: DB
const canal = (id: string, handle: string | null, title: string | null, kind = 'clips') =>
  db.prepare('INSERT INTO youtube_channels (channel_id, handle, title, uploads_playlist, added_at, kind) VALUES (?, ?, ?, ?, ?, ?)').run(id, handle, title, 'UU', 't' + id, kind)
const delPlan = () => Object.fromEntries(getPlan(db, HOY).accounts.map((a) => [`${a.account.platform}:${a.account.name}`, a.channelId]))

beforeEach(() => {
  base = tmpDir('cos_today_')
  const root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  new CampaignFixture(root, 'PODCAST', 'podcast', 'Podcast').addClip({ n: 1, clipId: 'clp_1', score: 90 })
  syncLibraries(db, { roots: [root] })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('canal del plan y canal de YouTube seguido', () => {
  it('se reconocen por el nombre, con o sin @ y sin distinguir mayúsculas', () => {
    canal(A, '@democlips', 'Democlips')
    canal(B, '@toomanyclips10', 'Too Many Clips')
    saveAccount(db, { platform: 'youtube', name: '@Democlips', dailyLimit: 1 })
    saveAccount(db, { platform: 'youtube', name: 'Toomanyclips10', dailyLimit: 1 })     // escrito sin @, como lo tiene el usuario
    saveAccount(db, { platform: 'youtube', name: 'too many clips', dailyLimit: 1 })     // por el título del canal
    saveAccount(db, { platform: 'youtube', name: '@otrocanal', dailyLimit: 1 })
    expect(delPlan()).toEqual({ 'youtube:@Democlips': A, 'youtube:Toomanyclips10': B, 'youtube:too many clips': B, 'youtube:@otrocanal': null })
  })

  it('solo YouTube: un canal de TikTok con el mismo nombre no hereda la imagen', () => {
    canal(A, '@democlips', 'Democlips')
    saveAccount(db, { platform: 'tiktok', name: '@democlips', dailyLimit: 1 })
    saveAccount(db, { platform: 'instagram', name: '@democlips', dailyLimit: 1 })
    expect(delPlan()).toEqual({ 'tiktok:@democlips': null, 'instagram:@democlips': null })
  })

  it('un canal personal no presta su imagen a un canal del plan', () => {
    canal(P, '@micanal', 'Mi canal', 'personal')
    saveAccount(db, { platform: 'youtube', name: '@micanal', dailyLimit: 1 })
    expect(delPlan()).toEqual({ 'youtube:@micanal': null })
  })

  it('sin canales seguidos el plan funciona igual', () => {
    saveAccount(db, { platform: 'youtube', name: '@yt', dailyLimit: 1 })
    const [a] = getPlan(db, HOY).accounts
    expect(a.channelId).toBeNull()
    expect(a.suggestions.map((s) => s.clip.clipId)).toEqual(['clp_1'])
  })
})

describe('canal sin clip: por qué', () => {
  it('si lo que queda va a otro canal por las asignaciones, lo dice con la campaña y el canal', () => {
    saveAccount(db, { platform: 'youtube', name: '@democlips', dailyLimit: 1 })
    saveAccount(db, { platform: 'youtube', name: '@clipsparatodos', dailyLimit: 2 })
    const juan = listAccounts(db).find((a) => a.name === '@democlips')!
    setCampaignAccounts(db, 'podcast', [juan.id])
    const plan = getPlan(db, HOY)
    const nuevo = plan.accounts.find((a) => a.account.name === '@clipsparatodos')!
    expect(nuevo.suggestions).toEqual([])
    expect(nuevo.elsewhere).toEqual([{ campaignId: 'podcast', campaignName: 'Podcast', clips: 1, owners: ['@democlips'] }])
    // el canal al que va no tiene nada «en otra parte»
    expect(plan.accounts.find((a) => a.account.name === '@democlips')!.elsewhere).toEqual([])
  })

  it('un canal asignado a una campaña que ya cerró vuelve a recibir las campañas sin asignar', () => {
    // el caso real: Don't Lie To Me asignada solo a @clipsparatodos, y cerrada
    const root = path.join(base, 'CAMPAIGNS')
    new CampaignFixture(root, 'VIEJA', 'vieja', 'Vieja').addClip({ n: 1, clipId: 'clp_viejo', score: 99, content: 'vieja' })
    syncLibraries(db, { roots: [root] })
    saveAccount(db, { platform: 'youtube', name: '@clipsparatodos', dailyLimit: 2 })
    const bueno = listAccounts(db).find((a) => a.name === '@clipsparatodos')!
    setCampaignAccounts(db, 'vieja', [bueno.id])
    const de = (n: string) => getPlan(db, HOY).accounts.find((a) => a.account.name === n)!
    // mientras está abierta, el canal solo recibe su campaña
    expect(de('@clipsparatodos').suggestions.map((s) => s.clip.clipId)).toEqual(['clp_viejo'])
    setCampaignStatus(db, { campaignId: 'vieja', closed: true })
    // cerrada, ya no lo ata: recibe del resto (el podcast sin asignar)
    expect(de('@clipsparatodos').suggestions.map((s) => s.clip.clipId)).toEqual(['clp_1'])
  })

  it('sin asignaciones, nada que explicar', () => {
    saveAccount(db, { platform: 'youtube', name: '@a', dailyLimit: 1 })
    saveAccount(db, { platform: 'youtube', name: '@b', dailyLimit: 1 })
    expect(getPlan(db, HOY).accounts.map((a) => a.elsewhere)).toEqual([[], []])
  })
})

describe('regla de Vyro: un vídeo, una vez por plataforma', () => {
  const subido = (clipId: string, account: string) =>
    db.prepare("INSERT INTO publications (clip_id, platform, account, status, published_at, created_at, updated_at) VALUES (?, 'youtube', ?, 'published', ?, 't', 't')")
      .run(clipId, account, new Date(HOY.getTime() - 30 * 3600_000).toISOString())
  const de = (nombre: string) => getPlan(db, HOY).accounts.find((a) => a.account.name === nombre)!

  it('un clip subido en un canal de YouTube no se propone en otro canal de YouTube, pero sí en TikTok', () => {
    saveAccount(db, { platform: 'youtube', name: '@democlips', dailyLimit: 1 })
    saveAccount(db, { platform: 'youtube', name: '@clipsparatodos', dailyLimit: 2 })
    saveAccount(db, { platform: 'tiktok', name: '@democlipss', dailyLimit: 1 })
    subido('clp_1', '@democlips')
    expect(de('@clipsparatodos').suggestions).toEqual([])
    expect(de('@democlips').suggestions).toEqual([])
    expect(de('@democlipss').suggestions.map((s) => s.clip.clipId)).toEqual(['clp_1'])
  })
})

describe('imagen del canal', () => {
  it('pide la dirección a YouTube y se queda con una por canal', async () => {
    const pedidas: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      const u = new URL(url)
      pedidas.push(`${u.pathname.split('/').pop()}?part=${u.searchParams.get('part')}&id=${u.searchParams.get('id')}`)
      return { ok: true, status: 200, json: async () => ({ items: [
        { id: A, snippet: { thumbnails: { default: { url: 'https://yt3.ggpht.com/a-88' }, medium: { url: 'https://yt3.ggpht.com/a-240' } } } },
        { id: B, snippet: { thumbnails: { default: { url: 'https://yt3.ggpht.com/b-88' } } } },
        { id: P, snippet: {} },
        { snippet: { thumbnails: { default: { url: 'https://yt3.ggpht.com/sin-id' } } } }
      ] }) }
    }
    const urls = await fetchChannelAvatars([A, B, P, A], 'k', fetchImpl)
    expect([...urls]).toEqual([[A, 'https://yt3.ggpht.com/a-240'], [B, 'https://yt3.ggpht.com/b-88']])
    expect(pedidas).toEqual([`channels?part=snippet&id=${A},${B},${P}`])     // una sola petición, sin repetir canales
  })

  it('solo se descarga de los servidores de avatares de Google, por https', () => {
    for (const buena of ['https://yt3.ggpht.com/abc=s240', 'https://yt3.googleusercontent.com/abc', 'https://lh3.googleusercontent.com/x']) expect(isAvatarUrl(buena)).toBe(true)
    for (const mala of ['http://yt3.ggpht.com/abc', 'https://evil.test/ggpht.com/x', 'https://ggpht.com.evil.test/x', 'file:///C:/x.jpg', 'https://notggpht.com/x', 'no es una url', '']) expect(isAvatarUrl(mala)).toBe(false)
  })

  it('el nombre del archivo guardado es un identificador de canal válido, nada más', () => {
    expect(isChannelId(A)).toBe(true)
    for (const malo of ['UCcorto', '../' + A, A + '/x', 'XX' + 'a'.repeat(22), A + 'a', null, 7]) expect(isChannelId(malo)).toBe(false)
  })
})
