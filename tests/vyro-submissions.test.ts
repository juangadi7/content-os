/** Tus envíos en Vyro: leer la respuesta de «My submissions», emparejar por vídeo y resumir por campaña. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/core/db'
import { syncLibraries } from '../src/core/importer'
import { getClip } from '../src/core/queries'
import { listVyroPending, markVyroCampaignRead, setVyroSent } from '../src/core/vyro-pending'
import { campaignsToSync, parseSubmissions, saveSubmissions, statusKind, submissionsSummary, videoIdOf } from '../src/core/vyro-submissions'
import { CampaignFixture, tmpDir } from './fixtures/builder'

const VYRO_CAMP = '6ad1655bc3e2bdb78521e1d3'
const envio = (id: string, videoId: string, status: string, views: number, earned: number, platform = 'youtube') => ({
  id, createdAt: '2026-10-16T10:11:00.000Z', owner: { id: 'u1', name: 'Juan', email: 'oculto' }, campaignId: VYRO_CAMP,
  videoUrl: platform === 'youtube' ? `https://www.youtube.com/watch?v=${videoId}` : `https://www.tiktok.com/@democlipss/video/${videoId}`,
  videoId, platform, platformUsername: 'shortsdemo', status: { id: status, timestamp: '2026-10-16T10:11:00.000Z' },
  submissionDate: '2026-10-16T10:10:50.000Z', metrics: { totalViews: views, totalLikes: 3, totalComments: 0, lastMetricsUpdatedAt: '2026-10-16T12:00:00.000Z' },
  error: null, earnings: { totalEarnings: earned, cpm: 2.5 },
})
const cuerpo = (items: unknown[], next: number | null = null) => JSON.stringify({ data: items, meta: { page: { current: 1, next } } })

let base: string
let db: DB
const AHORA = new Date(2026, 9, 16, 15, 0)
const pub = (clip: string, platform: string, url: string | null) =>
  Number(db.prepare("INSERT INTO publications (clip_id, platform, account, status, url, published_at, created_at, updated_at) VALUES (?, ?, '@Shortsdemo', 'published', ?, ?, 't', 't')")
    .run(clip, platform, url, new Date(2026, 9, 16, 12, 0).toISOString()).lastInsertRowid)

beforeEach(() => {
  base = tmpDir('cos_vyrosub_')
  const root = path.join(base, 'CAMPAIGNS')
  fs.mkdirSync(root, { recursive: true })
  db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
  const c = new CampaignFixture(root, 'DRAMA', 'drama', 'Total Drama')
  for (let n = 1; n <= 3; n++) c.addClip({ n, clipId: `clp_${n}`, score: 90 - n, content: `clip ${n}` })
  syncLibraries(db, { roots: [root] })
  db.prepare(`INSERT INTO vyro_campaigns (vyro_id, slug, name, ends_at, first_seen_at, last_seen_at, campaign_id, link_state)
    VALUES (?, 'total-drama', 'Total Drama Roblox - Streamer Tournament', '2026-10-29T13:00:00.000Z', 't', 't', 'drama', 'auto')`).run(VYRO_CAMP)
})
afterEach(() => {
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('leer la respuesta de Vyro', () => {
  it('se queda con lo que usa la app (sin el correo ni otros datos de la cuenta) y sabe si hay más páginas', () => {
    const r = parseSubmissions(cuerpo([envio('v1', 'G24rGMzlkgI', 'pending', 485, 0)], 2))
    expect(r.nextPage).toBe(2)
    expect(r.items).toEqual([{
      vyroClipId: 'v1', vyroCampaignId: VYRO_CAMP, platform: 'youtube', videoId: 'G24rGMzlkgI', videoUrl: 'https://www.youtube.com/watch?v=G24rGMzlkgI',
      username: 'shortsdemo', status: 'pending', views: 485, likes: 3, comments: 0, earned: 0, cpm: 2.5, error: null,
      submittedAt: '2026-10-16T10:10:50.000Z', metricsAt: '2026-10-16T12:00:00.000Z',
    }])
    expect(JSON.stringify(r.items)).not.toContain('oculto')
    expect(() => parseSubmissions('{"message":"Unauthorized"}')).toThrow('lista de envíos')
  })

  it('id del vídeo según la plataforma', () => {
    expect(videoIdOf('youtube', 'https://youtube.com/shorts/G24rGMzlkgI')).toBe('G24rGMzlkgI')
    expect(videoIdOf('tiktok', 'https://www.tiktok.com/@democlipss/video/7561234567890123456?lang=es')).toBe('7561234567890123456')
    expect(videoIdOf('instagram', 'https://www.instagram.com/reel/DPq1aBcDeFg/')).toBe('DPq1aBcDeFg')
    expect(videoIdOf('youtube', null)).toBeNull()
  })

  it('solo se leen las campañas enlazadas que no acabaron hace más de 3 semanas', () => {
    expect(campaignsToSync(db, AHORA).map((c) => c.vyroId)).toEqual([VYRO_CAMP])
    expect(campaignsToSync(db, new Date(2026, 10, 25))).toEqual([])
  })
})

describe('emparejar con tus publicaciones', () => {
  it('lo que ya está en Vyro se marca como enviado y sale de «Enviar a Vyro»; el clip enseña su estado', () => {
    const a = pub('clp_1', 'youtube', 'https://youtu.be/G24rGMzlkgI')
    pub('clp_2', 'youtube', 'https://youtu.be/PAK7PmS6_0w')
    pub('clp_3', 'tiktok', null) // sin enlace: no se puede emparejar
    expect(listVyroPending(db, AHORA).map((p) => p.clipId)).toEqual(['clp_1', 'clp_2', 'clp_3'])

    const r = saveSubmissions(db, parseSubmissions(cuerpo([envio('v1', 'G24rGMzlkgI', 'active', 6200, 15.5), envio('v9', 'zzzzzzzzzzz', 'pending', 10, 0)])).items, AHORA)
    expect(r).toEqual({ saved: 2, newlySent: 1 })
    expect(listVyroPending(db, AHORA).map((p) => p.clipId)).toEqual(['clp_2', 'clp_3'])
    expect(getClip(db, 'clp_1')!.publications.find((p) => p.id === a)!.vyro).toMatchObject({ status: 'active', views: 6200, earned: 15.5 })

    // otra lectura actualiza cifras sin duplicar
    saveSubmissions(db, parseSubmissions(cuerpo([envio('v1', 'G24rGMzlkgI', 'active', 9000, 22.5)])).items, AHORA)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vyro_submissions').get() as { n: number }).n).toBe(2)
    const s = submissionsSummary(db)
    expect(s.campaigns).toEqual([{ vyroId: VYRO_CAMP, name: 'Total Drama Roblox - Streamer Tournament', total: 2, pending: 1, approved: 1, rejected: 0, views: 9010, earned: 22.5, unmatched: 1 }])
    expect(s.earned).toBe(22.5)
  })

  it('lo dado por enviado al instalar el recordatorio vuelve si, leído Vyro, no está allí; lo marcado a mano se respeta', () => {
    const viejo = pub('clp_1', 'youtube', 'https://youtu.be/AAAAAAAAAAA')
    const otro = pub('clp_2', 'youtube', 'https://youtu.be/BBBBBBBBBBB')
    const aMano = pub('clp_3', 'youtube', 'https://youtu.be/CCCCCCCCCCC')
    // como lo deja la migración: enviado = fecha de publicación
    db.prepare('UPDATE publications SET vyro_sent_at = published_at WHERE id IN (?, ?)').run(viejo, otro)
    setVyroSent(db, aMano, true, AHORA)
    expect(listVyroPending(db, AHORA)).toEqual([])          // sin leer Vyro no se sabe: no se pide
    saveSubmissions(db, parseSubmissions(cuerpo([envio('v2', 'BBBBBBBBBBB', 'pending', 50, 0)])).items, AHORA)
    markVyroCampaignRead(db, VYRO_CAMP, AHORA)
    const falta = listVyroPending(db, AHORA)
    expect(falta.map((p) => [p.clipId, p.verified, p.url, p.account])).toEqual([['clp_1', true, 'https://youtu.be/AAAAAAAAAAA', '@Shortsdemo']])
  })

  it('estados', () => {
    expect([statusKind('pending'), statusKind('active'), statusKind('rejected'), statusKind(null)]).toEqual(['pending', 'approved', 'rejected', 'pending'])
  })
})
