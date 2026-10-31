/** Control de vídeos: estado en Vyro de cada vídeo, comparado con los envíos reales (no con lo marcado). */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getVideoControl, setControlIgnored } from '../src/core/video-control'
import { markVyroCampaignRead, setVyroSent } from '../src/core/vyro-pending'
import { parseSubmissions, saveSubmissions } from '../src/core/vyro-submissions'
import { CampaignFixture, tmpDir } from './fixtures/builder'

const AHORA = new Date(2026, 9, 17, 12, 0)
const VYRO = 'vyro_drama'
let base: string
let db: DB
const hace = (h: number) => new Date(AHORA.getTime() - h * 3600_000).toISOString()
const pub = (clip: string, platform: string, url: string | null, cuando: string) =>
  Number(db.prepare("INSERT INTO publications (clip_id, platform, account, status, url, published_at, created_at, updated_at) VALUES (?, ?, '@Shortsdemo', 'published', ?, ?, 't', 't')")
    .run(clip, platform, url, cuando).lastInsertRowid)
const envio = (id: string, videoId: string, extra: Record<string, unknown> = {}) => ({
  id, campaignId: VYRO, platform: 'youtube', videoId, videoUrl: `https://www.youtube.com/watch?v=${videoId}`, platformUsername: 'shortsdemo',
  status: { id: 'pending' }, submissionDate: hace(1), metrics: { totalViews: 800 }, earnings: { totalEarnings: 0 }, error: null, ...extra,
})
const estado = (key: string) => getVideoControl(db, AHORA).videos.find((v) => v.key === key)!

beforeEach(() => {
  base = tmpDir('cos_control_')
  const root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const c = new CampaignFixture(root, 'DRAMA', 'drama', 'Total Drama')
  for (let n = 1; n <= 5; n++) c.addClip({ n, clipId: `clp_${n}`, score: 90 - n, content: `clip ${n}` })
  syncLibraries(db, { roots: [root] })
  db.prepare("UPDATE campaigns SET ends_at = '2026-10-29'").run()
  db.prepare(`INSERT INTO vyro_campaigns (vyro_id, slug, name, first_seen_at, last_seen_at, campaign_id, link_state) VALUES (?, 's', 'Total Drama', 't', 't', 'drama', 'auto')`).run(VYRO)
  db.prepare(`INSERT INTO youtube_channels (channel_id, handle, title, uploads_playlist, added_at, kind) VALUES ('UCxxxxxxxxxxxxxxxxxxxxxx', '@Shortsdemo', 'Shortty', 'UU', 't', 'clips')`).run()
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

it('cada vídeo con su estado: en Vyro, falta (urgente si ya tiene visitas), marcado a mano sin estar, programado', () => {
  const enVyro = pub('clp_1', 'youtube', 'https://youtu.be/AAAAAAAAAAA', hace(3))
  const falta = pub('clp_2', 'youtube', 'https://youtu.be/BBBBBBBBBBB', hace(5))
  const aMano = pub('clp_3', 'youtube', 'https://youtu.be/CCCCCCCCCCC', hace(6))
  const prog = pub('clp_4', 'youtube', null, new Date(AHORA.getTime() + 5 * 3600_000).toISOString())
  db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, origin) VALUES (?, ?, 2300, 'youtube_api')").run(falta, hace(1))
  setVyroSent(db, aMano, true, AHORA)
  saveSubmissions(db, parseSubmissions(JSON.stringify({ data: [envio('s1', 'AAAAAAAAAAA', { status: { id: 'active' }, earnings: { totalEarnings: 4.2 } })] })).items, AHORA)

  // sin leer Vyro para esa campaña no se afirma que falte
  expect(estado(`p${falta}`).vyro.state).toBe('unchecked')
  markVyroCampaignRead(db, VYRO, AHORA)
  const c = getVideoControl(db, AHORA)
  const de = (k: string) => c.videos.find((v) => v.key === k)!
  expect(de(`p${enVyro}`).vyro).toMatchObject({ state: 'in_vyro', status: 'active', views: 800, earned: 4.2 })
  expect(de(`p${falta}`)).toMatchObject({ vyro: { state: 'missing' }, urgent: true, views: 2300, url: 'https://youtu.be/BBBBBBBBBBB' })
  expect(de(`p${aMano}`).vyro.state).toBe('manual')
  expect(de(`p${prog}`)).toMatchObject({ scheduled: true, vyro: { state: 'scheduled' } })
  // lo urgente y lo que falta, arriba
  expect(c.videos[0].key).toBe(`p${falta}`)
  expect(c.counts).toMatchObject({ missing: 1, manual: 1, scheduled: 1, in_vyro: 1 })
})

it('los vídeos reales del canal también salen aunque la app no sepa de qué clip son; y los envíos que solo conoce Vyro', () => {
  const v = (id: string, title: string) => db.prepare(`INSERT INTO youtube_videos (video_id, channel_id, title, published_at, views, first_seen_at, last_seen_at) VALUES (?, 'UCxxxxxxxxxxxxxxxxxxxxxx', ?, ?, 900, 't', 't')`).run(id, title, hace(10))
  v('DDDDDDDDDDD', 'Título cambiado a mano')
  v('EEEEEEEEEEE', 'Otro vídeo')
  saveSubmissions(db, parseSubmissions(JSON.stringify({ data: [envio('s2', 'DDDDDDDDDDD'), envio('s3', 'FFFFFFFFFFF')] })).items, AHORA)
  expect(estado('yDDDDDDDDDDD')).toMatchObject({ vyro: { state: 'in_vyro' }, thumb: { kind: 'youtube', videoId: 'DDDDDDDDDDD' }, title: 'Título cambiado a mano' })
  expect(estado('yEEEEEEEEEEE').vyro.state).toBe('no_campaign')
  expect(estado('vs3')).toMatchObject({ vyro: { state: 'in_vyro' }, videoId: 'FFFFFFFFFFF' })
})

it('sin el id del vídeo (marcado sin enlace o con enlace corto) lo busca en Vyro por cuenta y hora, y le guarda el enlace', () => {
  const sinEnlace = Number(db.prepare("INSERT INTO publications (clip_id, platform, account, status, url, published_at, created_at, updated_at) VALUES ('clp_1', 'tiktok', '@democlipss', 'published', NULL, ?, 't', 't')").run(hace(4)).lastInsertRowid)
  const corto = Number(db.prepare("INSERT INTO publications (clip_id, platform, account, status, url, published_at, created_at, updated_at) VALUES ('clp_2', 'tiktok', '@democlipss', 'published', 'https://vm.tiktok.com/ZMabc123/', ?, 't', 't')").run(hace(30)).lastInsertRowid)
  markVyroCampaignRead(db, VYRO, AHORA)
  const tk = (id: string, video: string, cuando: string) => ({ ...envio(id, video), platform: 'tiktok', platformUsername: 'democlipss', videoUrl: `https://www.tiktok.com/@democlipss/video/${video}`, submissionDate: cuando })
  saveSubmissions(db, parseSubmissions(JSON.stringify({ data: [tk('t1', '7561111111111111111', hace(3.5)), tk('t2', '7562222222222222222', hace(29))] })).items, AHORA)
  // emparejados por cuenta y hora: el envío apunta a su publicación y la publicación guarda el enlace de Vyro
  const pubDe = (id: string) => (db.prepare('SELECT publication_id FROM vyro_submissions WHERE vyro_clip_id = ?').get(id) as { publication_id: number }).publication_id
  expect([pubDe('t1'), pubDe('t2')]).toEqual([sinEnlace, corto])
  expect((db.prepare('SELECT url FROM publications WHERE id = ?').get(sinEnlace) as { url: string }).url).toBe('https://www.tiktok.com/@democlipss/video/7561111111111111111')
  // TikTok no sale en «Control de vídeos» (lo pidió el usuario)
  expect(getVideoControl(db, AHORA).videos.some((v) => v.platform === 'tiktok')).toBe(false)
})

it('nunca dice «falta» si no está seguro: sin enlace, sin leer Vyro o publicado después de la última lectura', () => {
  const sinEnlace = pub('clp_1', 'instagram', null, hace(4))
  const despues = pub('clp_2', 'youtube', 'https://youtu.be/GGGGGGGGGGG', hace(1))
  markVyroCampaignRead(db, VYRO, new Date(AHORA.getTime() - 2 * 3600_000)) // leído hace 2 h
  const a = estado(`p${sinEnlace}`)
  expect(a.vyro.state).toBe('unchecked')
  expect(a.vyro.reason).toContain('enlace')
  const b = estado(`p${despues}`)
  expect(b.vyro.state).toBe('unchecked')
  expect(b.vyro.reason).toContain('Recién publicado')
  // tras una lectura nueva en la que no aparece, sí falta
  markVyroCampaignRead(db, VYRO, AHORA)
  expect(estado(`p${despues}`).vyro.state).toBe('missing')
})

it('una lectura de Vyro a los pocos minutos de publicar no basta para decir que falta (se suele enviar justo después)', () => {
  const recien = pub('clp_5', 'youtube', 'https://youtu.be/HHHHHHHHHHH', hace(0.5))
  markVyroCampaignRead(db, VYRO, new Date(AHORA.getTime() - 25 * 60_000)) // leído 5 min después de publicar
  expect(estado(`p${recien}`).vyro.state).toBe('unchecked')
  markVyroCampaignRead(db, VYRO, AHORA) // 30 min después: ya sí
  expect(estado(`p${recien}`).vyro.state).toBe('missing')
})

it('«Ignorar» lo saca de «Atención»; si empieza a coger visitas con la campaña abierta, vuelve a avisar', () => {
  const cero = pub('clp_1', 'youtube', 'https://youtu.be/JJJJJJJJJJJ', hace(30))
  markVyroCampaignRead(db, VYRO, AHORA)
  expect(estado(`p${cero}`).vyro.state).toBe('missing')
  setControlIgnored(db, `p${cero}`, true, AHORA)
  expect(estado(`p${cero}`).vyro.state).toBe('ignored')
  expect(getVideoControl(db, AHORA).counts).toMatchObject({ missing: 0, ignored: 1 })
  // empieza a coger visitas: vuelve a «falta» con el aviso
  db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, origin) VALUES (?, ?, 1200, 'youtube_api')").run(cero, hace(1))
  const v = estado(`p${cero}`)
  expect(v.vyro.state).toBe('missing')
  expect(v.vyro.reason).toContain('Lo ignoraste')
  setControlIgnored(db, `p${cero}`, false)
  expect(estado(`p${cero}`).vyro.reason).toBeNull()
  expect(() => setControlIgnored(db, '../x', true)).toThrow('no válido')
})

it('«marcado a mano» solo si lo marcaste tú; lo de una campaña cerrada va a gris, fuera de «Atención»', () => {
  const auto = pub('clp_1', 'youtube', 'https://youtu.be/KKKKKKKKKKK', hace(20))
  // como lo dejó la instalación del recordatorio, y luego YouTube cambió la hora: NO es «a mano»
  db.prepare("UPDATE publications SET vyro_sent_at = ?, published_at = ? WHERE id = ?").run(hace(25), hace(20), auto)
  const tuyo = pub('clp_2', 'youtube', 'https://youtu.be/LLLLLLLLLLL', hace(20))
  setVyroSent(db, tuyo, true, AHORA)
  markVyroCampaignRead(db, VYRO, AHORA)
  expect(estado(`p${auto}`).vyro.state).toBe('missing')
  expect(estado(`p${tuyo}`).vyro.state).toBe('manual')
  // la campaña cierra: ya no se puede enviar
  db.prepare("UPDATE campaigns SET closed = 1").run()
  const c = getVideoControl(db, AHORA)
  expect(c.videos.find((v) => v.key === `p${auto}`)!.vyro).toMatchObject({ state: 'expired' })
  expect(c.counts).toMatchObject({ missing: 0, manual: 0, expired: 2 })
})

it('REGLA Nº1: un clip en dos canales de YouTube sale «Duplicado» (lo primero, no se puede ignorar); el plan no lo vuelve a proponer', async () => {
  const { getPlan, saveAccount } = await import('../src/core/plan')
  db.prepare("UPDATE clips SET title = 'She could not hear the question and answered anyway' WHERE clip_id = 'clp_1'").run()
  db.prepare("UPDATE clips SET title = 'Last place in the skydive challenge' WHERE clip_id = 'clp_2'").run()
  const titulo = (db.prepare("SELECT title FROM clips WHERE clip_id = 'clp_1'").get() as { title: string }).title
  const enA = pub('clp_1', 'youtube', 'https://youtu.be/MMMMMMMMMMM', hace(10))
  // el mismo clip subido en otro canal con el título del clip y un añadido: la app no lo emparejó
  db.prepare(`INSERT INTO youtube_channels (channel_id, handle, title, uploads_playlist, added_at, kind) VALUES ('UCyyyyyyyyyyyyyyyyyyyyyy', '@clipsparatodos', 'Clips', 'UU', 't', 'clips')`).run()
  db.prepare(`INSERT INTO youtube_videos (video_id, channel_id, title, published_at, first_seen_at, last_seen_at) VALUES ('NNNNNNNNNNN', 'UCyyyyyyyyyyyyyyyyyyyyyy', ?, ?, 't', 't')`).run(titulo + ' 😱 #shorts', hace(5))
  setControlIgnored(db, `p${enA}`, true, AHORA)
  const c = getVideoControl(db, AHORA)
  expect(c.videos[0]).toMatchObject({ key: `p${enA}`, vyro: { state: 'duplicate' }, urgent: true })
  expect(c.videos[0].vyro.reason).toContain('@clipsparatodos')
  expect(c.counts.duplicate).toBe(1)
  // otro clip, solo subido (sin emparejar) en ese otro canal: «Hoy» no lo propone para YouTube
  const t2 = (db.prepare("SELECT title FROM clips WHERE clip_id = 'clp_2'").get() as { title: string }).title
  db.prepare(`INSERT INTO youtube_videos (video_id, channel_id, title, published_at, first_seen_at, last_seen_at) VALUES ('OOOOOOOOOOO', 'UCyyyyyyyyyyyyyyyyyyyyyy', ?, ?, 't', 't')`).run(t2, hace(3))
  saveAccount(db, { platform: 'youtube', name: '@democlips', dailyLimit: 5 })
  const propuestos = getPlan(db, AHORA).accounts.flatMap((a) => a.suggestions.map((s) => s.clip.clipId))
  expect(propuestos).not.toContain('clp_1')
  expect(propuestos).not.toContain('clp_2')
})

it('marcado como subido en YouTube que no aparece en ningún canal tras 24 h: «No está en tu canal»', () => {
  const marcado = pub('clp_3', 'youtube', null, hace(48))
  db.prepare("UPDATE youtube_channels SET last_scan_at = ?").run(hace(1))
  expect(estado(`p${marcado}`)).toMatchObject({ vyro: { state: 'not_found' } })
  // si el canal aún no se ha revisado después, no se afirma
  db.prepare("UPDATE youtube_channels SET last_scan_at = ?").run(hace(47))
  expect(estado(`p${marcado}`).vyro.state).not.toBe('not_found')
})
