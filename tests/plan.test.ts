/** Plan de «Hoy»: reparto de clips entre canales con tope diario. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCampaignStatus, setCampaignTerms } from '../src/core/campaigns'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getPlan, listAccounts, removeAccount, saveAccount, setCampaignAccounts } from '../src/core/plan'
import { NO_ADVICE, parseCampaignAdvice, parseChannelsAdvice } from '../src/core/advice'
import { getStats } from '../src/core/stats'
import { deletePublication, savePublication } from '../src/core/publications'
import { getClip } from '../src/core/queries'
import { CampaignFixture, fingerprint, tmpDir } from './fixtures/builder'

let base: string
let root: string
let db: DB
const HOY = new Date(2026, 9, 8, 15, 0)
const a = (h: number, dia = 8) => new Date(2026, 9, dia, h, 0).toISOString()
const plan = () => getPlan(db, HOY)
const reparto = () => Object.fromEntries(plan().accounts.map((c) => [`${c.account.platform}:${c.account.name}`, c.suggestions.map((s) => s.clip.clipId)]))

beforeEach(() => {
  base = tmpDir('cos_plan_')
  root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const p = new CampaignFixture(root, 'PODCAST', 'podcast', 'Podcast')
  ;[95, 90, 85, 80, 75, 70].forEach((score, i) => p.addClip({ n: i + 1, clipId: `clp_p${i + 1}`, score }))
  const s = new CampaignFixture(root, 'SHARK', 'shark', 'Shark')
  ;[99, 60].forEach((score, i) => s.addClip({ n: i + 1, clipId: `clp_s${i + 1}`, score }))
  syncLibraries(db, { roots: [root] })
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('plan de hoy', () => {
  it('sin canales no propone nada, pero cuenta lo pendiente', () => {
    const p = plan()
    expect(p).toMatchObject({ date: '2026-10-08', accounts: [], left: 0, warnings: [] })
    expect(p.platforms.map((x) => [x.platform, x.pending, x.capacity, x.daysOfContent])).toEqual([['youtube', 8, 0, null], ['instagram', 8, 0, null], ['tiktok', 8, 0, null]])
  })

  it('reparte por rondas los mejores clips, uno por canal y plataforma', () => {
    saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 2 })
    saveAccount(db, { platform: 'youtube', name: '@dos', dailyLimit: 3 })
    saveAccount(db, { platform: 'tiktok', name: '@tk', dailyLimit: 1 })
    // orden de calidad: s1 99, p1 95, p2 90, p3 85, p4 80 …
    // alterna campañas: el 2.º de @dos es de Shark porque su 1.º fue de Podcast
    expect(reparto()).toEqual({ 'youtube:@uno': ['clp_s1', 'clp_p2'], 'youtube:@dos': ['clp_p1', 'clp_s2', 'clp_p3'], 'tiktok:@tk': ['clp_s1'] })
    const p = plan()
    expect(p.left).toBe(6)
    expect(p.platforms[0]).toMatchObject({ platform: 'youtube', pending: 8, capacity: 5, daysOfContent: 2 })
  })

  it('las campañas con plazo van primero, la que acaba antes delante', () => {
    saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 3 })
    setCampaignStatus(db, { campaignId: 'podcast', endsAt: '2026-10-19' })
    // con plazo pero sin urgencia: delante, alternando con la otra campaña
    expect(reparto()['youtube:@uno']).toEqual(['clp_p1', 'clp_s1', 'clp_p2'])
    expect(plan().accounts[0].suggestions[0].daysLeft).toBe(12)
    setCampaignStatus(db, { campaignId: 'shark', endsAt: '2026-10-09' })
    expect(reparto()['youtube:@uno']).toEqual(['clp_s1', 'clp_s2', 'clp_p1'])
  })

  it('«solo_canales» del campaign.json: la campaña va solo a esos canales y a ninguna otra plataforma', () => {
    saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 3 })
    saveAccount(db, { platform: 'youtube', name: '@Shortsdemo', dailyLimit: 3 })
    saveAccount(db, { platform: 'tiktok', name: 'robloxclipstop', dailyLimit: 3 })
    saveAccount(db, { platform: 'instagram', name: '@democlips', dailyLimit: 3 })
    const solo = parseCampaignAdvice({ solo_canales: [{ plataforma: 'youtube', cuenta: '@shortsdemo' }, { plataforma: 'tiktok', cuenta: '@robloxclipstop' }] })
    // los canales de Roblox son «dedicado» en canales.json: solo reciben lo que los nombra
    const canales = parseChannelsAdvice({ canales: { 'youtube:@Shortsdemo': { dedicado: true }, 'tiktok:robloxclipstop': { dedicado: true } } })
    const r = Object.fromEntries(getPlan(db, HOY, { ...NO_ADVICE, ...canales, campaigns: new Map([['shark', solo]]) }).accounts
      .map((c) => [`${c.account.platform}:${c.account.name}`, c.suggestions.map((s) => s.clip.clipId)]))
    expect(r['youtube:@Shortsdemo']).toEqual(['clp_s1', 'clp_s2'])
    expect(r['youtube:@uno']).toEqual(['clp_p1', 'clp_p2', 'clp_p3'])
    expect(r['tiktok:robloxclipstop']).toEqual(['clp_s1', 'clp_s2'])
    expect(r['instagram:@democlips']).toEqual(['clp_p1', 'clp_p2', 'clp_p3'])
  })

  it('«solo_canales» no vuelve exclusivo un canal normal: sigue recibiendo las demás campañas', () => {
    saveAccount(db, { platform: 'youtube', name: '@clipsparatodos', dailyLimit: 3 })
    saveAccount(db, { platform: 'youtube', name: '@Shortsdemo', dailyLimit: 3 })
    // MW4 (aquí «shark») va solo a @clipsparatodos en YouTube; el podcast no tiene norma
    const solo = parseCampaignAdvice({ solo_canales: [{ plataforma: 'youtube', cuenta: '@clipsparatodos' }] })
    const canales = parseChannelsAdvice({ canales: { 'youtube:@Shortsdemo': { dedicado: true } } })
    const r = Object.fromEntries(getPlan(db, HOY, { ...NO_ADVICE, ...canales, campaigns: new Map([['shark', solo]]) }).accounts
      .map((c) => [`${c.account.platform}:${c.account.name}`, c.suggestions.map((s) => s.clip.clipId)]))
    expect(r['youtube:@clipsparatodos']).toEqual(['clp_s1', 'clp_p1', 'clp_s2'])
    expect(r['youtube:@Shortsdemo']).toEqual([])
  })

  it('el tope de canales.json se aplica hasta que cambias el del canal en la app; entonces manda el tuyo', () => {
    const id = saveAccount(db, { platform: 'youtube', name: '@Shortsdemo', dailyLimit: 3 })
    const unoAlDia = { ...NO_ADVICE, platforms: new Map([['youtube' as const, 1]]) }
    const propuestas = () => getPlan(db, HOY, unoAlDia).accounts[0].suggestions.length
    expect(propuestas()).toBe(1)
    expect(listAccounts(db)[0].limitSetByUser).toBe(false)
    saveAccount(db, { id, dailyLimit: 2 })
    expect(listAccounts(db)[0].limitSetByUser).toBe(true)
    expect(propuestas()).toBe(2)
    // pausarlo o reactivarlo no cuenta como cambiar el tope
    saveAccount(db, { id: saveAccount(db, { platform: 'youtube', name: '@otro', dailyLimit: 3 }), active: true })
    expect(listAccounts(db)[1].limitSetByUser).toBe(false)
  })

  it('no propone dos seguidos de la misma campaña en un canal, salvo que sea urgente o no haya otra', () => {
    saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 3 })
    // orden por calidad: s1 99, p1 95, p2 90… → alterna Shark, Podcast, Shark
    expect(reparto()['youtube:@uno']).toEqual(['clp_s1', 'clp_p1', 'clp_s2'])
    // el último vídeo subido a ese canal cuenta: tras uno de Shark, empieza por Podcast
    savePublication(db, { clipId: 'clp_s1', platform: 'youtube', account: '@uno', publishedAt: a(9, 7) })
    expect(reparto()['youtube:@uno']).toEqual(['clp_p1', 'clp_s2', 'clp_p2'])
    // campaña urgente (le quedan 3 días o menos): no se alterna, va todo lo suyo primero
    setCampaignStatus(db, { campaignId: 'podcast', endsAt: '2026-10-10' })
    expect(reparto()['youtube:@uno']).toEqual(['clp_p1', 'clp_p2', 'clp_p3'])
    // si solo queda una campaña, se repite
    setCampaignStatus(db, { campaignId: 'podcast', endsAt: null, closed: true })
    expect(reparto()['youtube:@uno']).toEqual(['clp_s2'])
  })

  it('sin urgencia manda lo que mejor paga, aunque acabe un día más tarde; lo urgente sigue delante', () => {
    saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 3 })
    // Kevin Langue (2 $, 30-oct) frente a Ground Stop (1,05 $, 29-oct)
    setCampaignStatus(db, { campaignId: 'podcast', endsAt: '2026-10-19' })
    setCampaignStatus(db, { campaignId: 'shark', endsAt: '2026-10-20' })
    setCampaignTerms(db, { campaignId: 'podcast', payRate: 1.05, minViews: null, maxPayout: null })
    setCampaignTerms(db, { campaignId: 'shark', payRate: 2, minViews: null, maxPayout: null })
    // la que mejor paga primero, alternando con la otra
    expect(reparto()['youtube:@uno']).toEqual(['clp_s1', 'clp_p1', 'clp_s2'])
    // a 3 días del final, la que acaba antes pasa delante aunque pague menos
    setCampaignStatus(db, { campaignId: 'podcast', endsAt: '2026-10-10' })
    expect(reparto()['youtube:@uno']).toEqual(['clp_p1', 'clp_p2', 'clp_p3'])
  })

  it('marcar uno como subido no mueve lo propuesto a los otros canales', () => {
    saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 2 })
    saveAccount(db, { platform: 'youtube', name: '@dos', dailyLimit: 2 })
    expect(reparto()).toEqual({ 'youtube:@uno': ['clp_s1', 'clp_p2'], 'youtube:@dos': ['clp_p1', 'clp_s2'] })
    const id = savePublication(db, { clipId: 'clp_s1', platform: 'youtube', account: '@uno', publishedAt: a(10) })
    expect(reparto()).toEqual({ 'youtube:@uno': ['clp_p2'], 'youtube:@dos': ['clp_p1', 'clp_s2'] })
    const uno = plan().accounts[0]
    expect(uno.doneToday).toMatchObject([{ clipId: 'clp_s1', title: 'Clip 1', locked: false, publicationId: id }])
    // deshacer lo devuelve
    deletePublication(db, id)
    expect(reparto()['youtube:@uno']).toEqual(['clp_s1', 'clp_p2'])
  })

  it('el tope diario cuenta solo lo publicado hoy y no distingue mayúsculas en el nombre', () => {
    saveAccount(db, { platform: 'youtube', name: '@Uno', dailyLimit: 2 })
    savePublication(db, { clipId: 'clp_p6', platform: 'youtube', account: '@uno', publishedAt: a(22, 7) }) // ayer
    expect(plan().accounts[0].doneToday).toHaveLength(0)
    expect(reparto()['youtube:@Uno']).toHaveLength(2)
    savePublication(db, { clipId: 'clp_s1', platform: 'youtube', account: '@UNO', publishedAt: a(9) })
    savePublication(db, { clipId: 'clp_p1', platform: 'youtube', account: '@uno', publishedAt: a(11) })
    expect(plan().accounts[0]).toMatchObject({ suggestions: [], doneToday: [{ clipId: 'clp_s1' }, { clipId: 'clp_p1' }] })
    expect(listAccounts(db)).toHaveLength(1)
    expect(listAccounts(db)[0].published).toBe(3)
  })

  it('no propone clips ya subidos a esa plataforma, de campañas cerradas ni sin archivo', () => {
    saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 20 })
    saveAccount(db, { platform: 'instagram', name: '@ig', dailyLimit: 20 })
    savePublication(db, { clipId: 'clp_p1', platform: 'youtube', publishedAt: a(1, 1) }) // sin cuenta: en cualquier canal cuenta como subido
    setCampaignStatus(db, { campaignId: 'shark', closed: true })
    db.prepare("UPDATE clips SET file_state = 'missing' WHERE clip_id = 'clp_p2'").run()
    const r = reparto()
    expect(r['youtube:@uno']).toEqual(['clp_p3', 'clp_p4', 'clp_p5', 'clp_p6'])
    expect(r['instagram:@ig']).toEqual(['clp_p1', 'clp_p3', 'clp_p4', 'clp_p5', 'clp_p6'])
  })

  it('avisa cuando una campaña con plazo no cabe al ritmo actual', () => {
    saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 2 })
    setCampaignStatus(db, { campaignId: 'podcast', endsAt: '2026-10-09' }) // hoy y mañana: 4 huecos para 6 clips
    expect(plan().warnings).toEqual([{ campaignId: 'podcast', campaignName: 'Podcast', platform: 'youtube', pending: 6, daysLeft: 2, wontFit: 2 }])
    saveAccount(db, { id: listAccounts(db)[0].id, dailyLimit: 3 })
    expect(plan().warnings).toEqual([])
  })

  it('un canal usado al marcar una publicación entra solo; en pausa o quitado sale del plan sin perder publicaciones', () => {
    savePublication(db, { clipId: 'clp_p1', platform: 'tiktok', account: '@nuevo', publishedAt: a(9) })
    expect(listAccounts(db)).toMatchObject([{ platform: 'tiktok', name: '@nuevo', dailyLimit: 3, active: true, published: 1 }])
    expect(getClip(db, 'clp_p2')!.knownAccounts.tiktok).toEqual(['@nuevo'])
    expect(reparto()['tiktok:@nuevo']).toHaveLength(2)
    const id = listAccounts(db)[0].id
    saveAccount(db, { id, active: false })
    expect(plan()).toMatchObject({ accounts: [], left: 0 })
    expect(plan().allAccounts).toHaveLength(1)
    removeAccount(db, id)
    expect(listAccounts(db)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM publications').get() as { n: number }).n).toBe(1)
  })

  it('campañas asignadas a un canal: ese canal solo recibe las suyas y las demás van a los canales libres', () => {
    const dedicado = saveAccount(db, { platform: 'youtube', name: '@podcast', dailyLimit: 2 })
    const libre = saveAccount(db, { platform: 'youtube', name: '@libre', dailyLimit: 2 })
    saveAccount(db, { platform: 'tiktok', name: '@tk', dailyLimit: 2 })
    // sin asignar nada: reparto normal por rondas (s1 99, p1 95, p2 90, p3 85)
    expect(reparto()).toMatchObject({ 'youtube:@podcast': ['clp_s1', 'clp_p2'], 'youtube:@libre': ['clp_p1', 'clp_s2'] })
    setCampaignAccounts(db, 'podcast', [dedicado])
    expect(listAccounts(db).map((a) => [a.name, a.campaignIds])).toEqual([['@podcast', ['podcast']], ['@libre', []], ['@tk', []]])
    // @podcast solo recibe Podcast; Shark (sin asignar) va al canal libre; TikTok no cambia
    expect(reparto()).toEqual({ 'youtube:@podcast': ['clp_p1', 'clp_p2'], 'youtube:@libre': ['clp_s1', 'clp_s2'], 'tiktok:@tk': ['clp_s1', 'clp_p1'] })
    // una campaña puede ir a dos canales
    setCampaignAccounts(db, 'podcast', [dedicado, libre])
    expect(reparto()).toMatchObject({ 'youtube:@podcast': ['clp_p1', 'clp_p3'], 'youtube:@libre': ['clp_p2', 'clp_p4'] })
    // quitar la asignación lo deja como al principio; quitar el canal limpia sus asignaciones
    setCampaignAccounts(db, 'podcast', [])
    expect(reparto()['youtube:@podcast']).toEqual(['clp_s1', 'clp_p2'])
    setCampaignAccounts(db, 'shark', [dedicado])
    removeAccount(db, dedicado)
    expect(reparto()['youtube:@libre']).toEqual(['clp_s1', 'clp_p1'])
    expect(() => setCampaignAccounts(db, 'nada', [libre])).toThrow(/no existe/)
    expect(() => setCampaignAccounts(db, 'podcast', [9999])).toThrow(/no existe/)
  })

  it('el aviso de plazo cuenta solo con los canales de la campaña', () => {
    const a = saveAccount(db, { platform: 'youtube', name: '@uno', dailyLimit: 1 })
    saveAccount(db, { platform: 'youtube', name: '@dos', dailyLimit: 5 })
    setCampaignStatus(db, { campaignId: 'podcast', endsAt: '2026-10-09' }) // 2 días, 6 clips
    expect(plan().warnings).toEqual([]) // entre los dos canales caben
    setCampaignAccounts(db, 'podcast', [a]) // solo @uno: 2 huecos
    expect(plan().warnings).toEqual([{ campaignId: 'podcast', campaignName: 'Podcast', platform: 'youtube', pending: 6, daysLeft: 2, wontFit: 4 }])
  })

  it('estadísticas por canal', () => {
    const p1 = savePublication(db, { clipId: 'clp_p1', platform: 'youtube', account: '@uno' })
    const p2 = savePublication(db, { clipId: 'clp_p2', platform: 'youtube', account: '@UNO' })
    savePublication(db, { clipId: 'clp_p3', platform: 'youtube', account: '@dos' })
    const medir = (id: number, views: number) => db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, origin) VALUES (?, '2026-10-08T10:00:00.000Z', ?, 'prueba')").run(id, views)
    medir(p1, 1000)
    medir(p2, 3000)
    expect(getStats(db).accounts).toMatchObject([
      { platform: 'youtube', account: expect.stringMatching(/^@uno$/i), published: 2, measured: 2, views: 4000, average: 2000, bestTitle: 'Clip 2', bestViews: 3000 },
      { platform: 'youtube', account: '@dos', published: 1, measured: 0, views: 0, average: null }
    ])
  })

  it('valida los canales y no escribe nada en CAMPAIGNS', () => {
    const antes = fingerprint(root)
    saveAccount(db, { platform: 'youtube', name: ' @uno ' })
    expect(listAccounts(db)[0]).toMatchObject({ name: '@uno', dailyLimit: 3 })
    expect(() => saveAccount(db, { platform: 'youtube', name: '@UNO' })).toThrow(/ya está/)
    expect(() => saveAccount(db, { platform: 'youtube', name: '' })).toThrow(/nombre/)
    expect(() => saveAccount(db, { platform: 'facebook' as never, name: 'x' })).toThrow(/Plataforma/)
    expect(() => saveAccount(db, { platform: 'youtube', name: 'x', dailyLimit: 0 })).toThrow(/entre 1 y 20/)
    expect(() => saveAccount(db, { id: 999, dailyLimit: 2 })).toThrow(/no existe/)
    plan()
    expect(fingerprint(root)).toEqual(antes)
  })

  it('una base antigua con publicaciones recibe sus canales al migrar', () => {
    const ruta = path.join(base, 'vieja', 'content-os.db')
    fs.mkdirSync(path.dirname(ruta))
    db.close()
    fs.copyFileSync(path.join(base, 'ContentOS', 'content-os.db'), ruta)
    const vieja = openDatabase(ruta)
    vieja.exec('DROP TABLE own_post_stats; DROP TABLE own_posts; DROP TABLE own_accounts; ALTER TABLE social_videos DROP COLUMN removed_at; DROP TABLE social_video_snapshots; DROP TABLE social_videos; DROP TABLE social_account_snapshots; DROP TABLE social_accounts; ALTER TABLE publications DROP COLUMN vyro_sent_manual; DROP TABLE vyro_submissions; ALTER TABLE publications DROP COLUMN vyro_sent_at; DROP TABLE calendar_tasks; DROP TABLE youtube_channel_snapshots; DROP TABLE youtube_video_snapshots; ALTER TABLE youtube_channels DROP COLUMN subscribers; ALTER TABLE youtube_channels DROP COLUMN total_views; ALTER TABLE youtube_channels DROP COLUMN video_count; ALTER TABLE youtube_channels DROP COLUMN stats_at; ALTER TABLE youtube_channels DROP COLUMN kind; DROP TABLE campaign_accounts; DROP TABLE accounts; DROP TABLE vyro_orders; DROP TABLE vyro_campaigns; DROP TABLE settings; ALTER TABLE campaigns DROP COLUMN pay_rate; ALTER TABLE campaigns DROP COLUMN min_views; ALTER TABLE campaigns DROP COLUMN max_payout; ALTER TABLE campaigns DROP COLUMN publish_checklist; PRAGMA user_version = 3')
    vieja.prepare("INSERT INTO publications (clip_id, platform, account, created_at, updated_at) VALUES ('clp_p1', 'youtube', '@viejo', 'x', 'x'), ('clp_p2', 'youtube', '@viejo', 'x', 'x'), ('clp_p3', 'tiktok', '', 'x', 'x')").run()
    vieja.close()
    db = openDatabase(ruta)
    expect(listAccounts(db).map((c) => [c.platform, c.name, c.published])).toEqual([['youtube', '@viejo', 2]])
  })
})
