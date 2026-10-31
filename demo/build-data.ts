/**
 * Genera los datos de la demo web: una biblioteca de ejemplo, un canal de YouTube de ejemplo con
 * 60 días de mediciones y un vídeo largo de prueba, todo inventado. Usa la MISMA lógica de la
 * aplicación (importador, publicaciones, sincronización de canales) contra una base temporal, y
 * guarda lo que respondería cada llamada de la interfaz en demo/out/api.json.
 *
 *   npm run demo:data
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getChannelDashboards } from '../src/core/channel-dashboard'
import { setCampaignStatus, setCampaignTerms } from '../src/core/campaigns'
import { openDatabase } from '../src/core/db'
import { listExtras } from '../src/core/extras'
import { syncLibraries } from '../src/core/importer'
import { listLongVideos } from '../src/core/long-videos'
import { getPlan, listAccounts, saveAccount } from '../src/core/plan'
import { savePublication } from '../src/core/publications'
import { counts, getClip, lastSyncRun, listCampaigns, listClips, listLibraries, listPublished, listSyncProblems } from '../src/core/queries'
import { getStats } from '../src/core/stats'
import { getStatsSeries } from '../src/core/stats-series'
import { getWeekendPlan } from '../src/core/weekend'
import { NO_ADVICE } from '../src/core/advice'
import { getVideoControl } from '../src/core/video-control'
import { listVyroPending } from '../src/core/vyro-pending'
import { getVyro } from '../src/core/vyro'
import { getCalendar } from '../src/core/calendar'
import { getSocialDashboards } from '../src/core/social'
import { addChannel, listChannels, syncChannels, syncChannelStats } from '../src/core/youtube-channels'
import type { FetchLike } from '../src/core/youtube'
import { CampaignFixture } from '../tests/fixtures/builder'

const OUT = path.join(__dirname, 'out')
const NOW = new Date()
const TOPE = NOW.getTime() - 20 * 60_000
/** Día relativo a hoy a una hora dada; nunca en el futuro (lo de hoy se mide hace un rato). */
const dia = (n: number, hora = 21) => { const d = new Date(NOW); d.setDate(d.getDate() + n); d.setHours(hora, 0, 0, 0); return d.getTime() > TOPE ? new Date(TOPE - (22 - hora) * 60_000) : d }
const iso = (d: Date) => d.toISOString()
/** Día futuro (plazos, calendario): estos sí pueden ir por delante de hoy. */
const futuro = (n: number) => { const d = new Date(NOW); d.setDate(d.getDate() + n); return d }
const dayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ---------------------------------------------------------------- contenido inventado

interface Clip { id: string; title: string; dur: number; score: number }
const CAMPAÑAS: { id: string; folder: string; name: string; pay: [number, number, number]; ends: number; clips: Clip[] }[] = [
  { id: 'ciencia', folder: 'CURIOSIDADES_CIENCIA', name: 'Curiosidades de ciencia', pay: [1.2, 5000, 60], ends: 18, clips: [
    { id: 'clp_c01', title: 'Por qué el cielo es azul en 30 segundos', dur: 31, score: 94 },
    { id: 'clp_c02', title: 'El metal que se derrite en tu mano', dur: 27, score: 91 },
    { id: 'clp_c03', title: 'Cuánto pesa realmente una nube', dur: 33, score: 88 },
    { id: 'clp_c04', title: 'El sonido más fuerte jamás registrado', dur: 29, score: 86 },
    { id: 'clp_c05', title: 'Por qué los gatos siempre caen de pie', dur: 35, score: 83 },
    { id: 'clp_c06', title: 'El océano tiene cascadas bajo el agua', dur: 30, score: 79 }
  ] },
  { id: 'emprende', folder: 'PODCAST_EMPRENDEDORES', name: 'Podcast de emprendedores', pay: [1.5, 8000, 80], ends: 9, clips: [
    { id: 'clp_e01', title: 'El error que casi hunde mi primera empresa', dur: 42, score: 92 },
    { id: 'clp_e02', title: 'Cómo conseguí mis primeros 100 clientes', dur: 38, score: 90 },
    { id: 'clp_e03', title: 'Nunca contrates a un amigo sin esto', dur: 36, score: 85 },
    { id: 'clp_e04', title: 'La regla de los 5 minutos para decidir', dur: 29, score: 81 },
    { id: 'clp_e05', title: 'Lo que nadie te cuenta de invertir', dur: 44, score: 77 }
  ] },
  { id: 'cocina', folder: 'COCINA_60_SEGUNDOS', name: 'Cocina en 60 segundos', pay: [0.9, 3000, 40], ends: 26, clips: [
    { id: 'clp_k01', title: 'Pasta cremosa con 3 ingredientes', dur: 58, score: 89 },
    { id: 'clp_k02', title: 'El truco para un huevo perfecto', dur: 41, score: 87 },
    { id: 'clp_k03', title: 'Tortitas esponjosas sin báscula', dur: 55, score: 84 },
    { id: 'clp_k04', title: 'Arroz que no se pega nunca', dur: 47, score: 80 }
  ] }
]
const TODOS = CAMPAÑAS.flatMap((c) => c.clips.map((k) => ({ ...k, campaign: c.id })))

// rendimiento de cada clip: [días desde la subida (negativo = hace N días), techo de visitas, velocidad]
const RENDIMIENTO: Record<string, [number, number, number]> = {
  clp_c01: [-52, 98000, 0.3], clp_c02: [-44, 41000, 0.22], clp_c03: [-37, 23500, 0.18], clp_c04: [-25, 96000, 0.2],
  clp_c05: [-14, 82000, 0.11], clp_c06: [-5, 64000, 0.12],
  clp_e01: [-49, 52000, 0.2], clp_e02: [-40, 88000, 0.16], clp_e03: [-28, 18400, 0.25], clp_e04: [-17, 121000, 0.1], clp_e05: [-7, 76000, 0.13],
  clp_k01: [-46, 38500, 0.28], clp_k02: [-33, 9200, 0.3], clp_k03: [-21, 67000, 0.14], clp_k04: [-10, 92000, 0.12]
}
/**
 * Visitas acumuladas de un clip al final de un día. Se suma lo de cada día (curva que se va
 * apagando, más movimiento los fines de semana y algo de variación estable), así que nunca baja.
 */
const memo = new Map<string, number>()
function visitas(clipId: string, d: number, plataforma: 'youtube' | 'tiktok'): number {
  const clave = `${clipId}|${d}|${plataforma}`
  if (memo.has(clave)) return memo.get(clave)!
  const [subida, techo, vel] = RENDIMIENTO[clipId]
  const factor = plataforma === 'tiktok' ? 1.35 : 1
  let total = 0
  for (let t = 0; t <= d - subida; t++) {
    const base = techo * factor * (Math.exp(-vel * t) - Math.exp(-vel * (t + 1)))
    const dow = dia(subida + t).getDay()
    const finde = dow === 0 || dow === 6 ? 1.18 : 1
    const vaiven = 1 + 0.22 * Math.sin((clipId.charCodeAt(5) * 7 + subida + t) * 1.3)
    total += base * finde * vaiven
  }
  const v = Math.round(total)
  memo.set(clave, v)
  return v
}

// ---------------------------------------------------------------- biblioteca y base temporal

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos_demo_'))
const root = path.join(base, 'CAMPAIGNS')
fs.mkdirSync(root, { recursive: true })
for (const c of CAMPAÑAS) {
  const f = new CampaignFixture(root, c.folder, c.id, c.name)
  c.clips.forEach((k, i) => {
    f.addClip({ n: i + 1, clipId: k.id, title: k.title, score: k.score })
    f.patchMeta(i + 1, { duration: k.dur, caption: `${k.title} #shorts`, hashtags: ['#shorts'], language: 'es' })
  })
}
const db = openDatabase(path.join(base, 'ContentOS', 'content-os.db'))
syncLibraries(db, { roots: [root], thumbsDir: path.join(base, 'ContentOS', 'thumbs'), now: () => iso(dia(-60, 9)) })
for (const c of CAMPAÑAS) {
  setCampaignTerms(db, { campaignId: c.id, payRate: c.pay[0], minViews: c.pay[1], maxPayout: c.pay[2] })
  setCampaignStatus(db, { campaignId: c.id, endsAt: dayStr(futuro(c.ends)) })
}

// canales donde se publica
for (const [platform, name, dailyLimit] of [['youtube', '@CanalDemo', 3], ['tiktok', '@democlips', 4], ['instagram', '@democlips.reels', 2]] as const) {
  saveAccount(db, { platform, name, dailyLimit }, () => iso(dia(-60, 9)))
}

// ---------------------------------------------------------------- canal de YouTube de ejemplo

const CH = 'UC' + 'D3moCanalEjemplo00000'.padEnd(22, '0').slice(0, 22)
const vid = (clipId: string) => ('demo' + clipId.slice(4)).padEnd(11, 'x').slice(0, 11)
let hoy = -60
let subs = 1840
const fetchYT: FetchLike = async (url) => {
  const u = new URL(url)
  const recurso = u.pathname.split('/').pop()!
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  const subidos = TODOS.filter((k) => RENDIMIENTO[k.id][0] <= hoy)
  if (recurso === 'channels') {
    if (u.searchParams.get('part') === 'statistics') {
      const total = subidos.reduce((s, k) => s + visitas(k.id, hoy, 'youtube'), 0)
      return ok({ items: [{ id: CH, statistics: { subscriberCount: String(subs), viewCount: String(total + 412000), videoCount: String(subidos.length + 38) } }] })
    }
    return ok({ items: [{ id: CH, snippet: { title: 'Canal Demo', customUrl: '@canaldemo' }, contentDetails: { relatedPlaylists: { uploads: 'UUdemo' } } }] })
  }
  if (recurso === 'playlistItems') return ok({ items: subidos.map((k) => ({ contentDetails: { videoId: vid(k.id) } })) })
  const ids = new Set(u.searchParams.get('id')!.split(','))
  return ok({
    items: subidos.filter((k) => ids.has(vid(k.id))).map((k) => {
      const v = visitas(k.id, hoy, 'youtube')
      return {
        id: vid(k.id), snippet: { channelId: CH, title: k.title, description: `${k.title} #shorts`, publishedAt: iso(dia(RENDIMIENTO[k.id][0], 18)) },
        contentDetails: { duration: `PT${k.dur}S` },
        statistics: { viewCount: String(v), likeCount: String(Math.round(v * 0.041)), commentCount: String(Math.round(v * 0.0023)) }
      }
    })
  })
}

async function main() {
  await addChannel(db, '@canaldemo', 'demo', fetchYT, () => iso(dia(-60, 9)))
  // la última medición es la de anoche: el día de hoy aún no ha acabado
  for (hoy = -60; hoy <= -1; hoy++) {
    subs += Math.round(18 + 42 * Math.max(0, Math.sin(hoy / 6)) + (hoy > -30 ? 25 : 0))
    await syncChannels(db, 'demo', fetchYT, { now: () => iso(dia(hoy)), force: true })
    await syncChannelStats(db, 'demo', fetchYT, () => iso(dia(hoy)))
  }

  // TikTok: publicado a mano con su URL; las mediciones se guardan una vez al día
  const tk = TODOS.filter((k) => !['clp_c06', 'clp_e05'].includes(k.id))
  for (const k of tk) {
    const subido = RENDIMIENTO[k.id][0]
    const id = savePublication(db, { clipId: k.id, platform: 'tiktok', account: '@democlips', url: `https://www.tiktok.com/@democlips/video/70000000000${k.id.slice(5).padStart(8, '0')}`, publishedAt: iso(dia(subido, 19)) }, () => iso(dia(subido, 19)))
    const ins = db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, shares, saves, origin) VALUES (?, ?, ?, ?, ?, ?, ?, 'tiktok_web')")
    for (let d = subido; d <= -1; d++) {
      const v = visitas(k.id, d, 'tiktok')
      ins.run(id, iso(dia(d, 22)), v, Math.round(v * 0.063), Math.round(v * 0.004), Math.round(v * 0.008), Math.round(v * 0.006))
    }
  }
  // Instagram: marcados como subidos (sin lectura de cifras todavía)
  for (const k of TODOS.slice(0, 5)) savePublication(db, { clipId: k.id, platform: 'instagram', account: '@democlips.reels', publishedAt: iso(dia(RENDIMIENTO[k.id][0] + 1, 20)) })

  // ---------------------------------------------------------------- vídeo largo de prueba
  const largos = path.join(base, 'VIDEOS_LARGOS')
  const carpeta = path.join(largos, '01 Mantenimiento de canales de YouTube')
  fs.mkdirSync(carpeta, { recursive: true })
  fs.writeFileSync(path.join(carpeta, 'video.json'), JSON.stringify({
    channel: 'Canal Demo',
    titles: ['Cómo mantener un canal de YouTube sano (checklist semanal)', 'Auditoría de canal en 10 minutos: lo que reviso cada lunes', 'El mantenimiento que nadie hace en su canal (y debería)'],
    description: 'Checklist semanal para mantener un canal de YouTube: revisar retención, miniaturas que caen, comentarios sin responder, listas de reproducción y vídeos que conviene actualizar.\n\n00:00 Introducción\n01:10 Métricas que reviso cada semana\n03:40 Miniaturas y títulos que se quedan atrás\n06:15 Comentarios, listas y tarjetas\n08:30 Plan para la semana siguiente',
    hashtags: ['YouTube', 'CreadoresDeContenido', 'Productividad'],
    pinned_comment: '¿Qué revisas tú cada semana en tu canal? Te leo 👇',
    schedule: 'Martes 18:00',
    notes: 'Vídeo de prueba de la demo: generado, sin contenido real.',
    file: 'mantenimiento_canal.mp4'
  }, null, 2))
  fs.writeFileSync(path.join(carpeta, 'mantenimiento_canal.mp4'), 'demo')
  for (const l of ['A', 'B', 'C']) fs.writeFileSync(path.join(carpeta, `miniatura_${l}.jpg`), 'demo')
  fs.writeFileSync(path.join(carpeta, 'mantenimiento_canal.srt'), '1\n00:00:00,000 --> 00:00:03,000\nDemo\n')

  // ---------------------------------------------------------------- respuestas de la interfaz
  syncLibraries(db, { roots: [root], thumbsDir: path.join(base, 'ContentOS', 'thumbs') }) // última lectura: ahora
  const ahora = new Date()
  const plan = getPlan(db, ahora)
  const campañas = listCampaigns(db)
  const extras = listExtras(db, path.join(base, 'FUERA_DE_CAMPAÑA'))
  const largosView = listLongVideos(db, largos, 'long')
  for (const v of largosView.videos) v.sizeBytes = null // el MP4 de la carpeta temporal es de mentira; el de la demo se genera aparte
  const musica = listLongVideos(db, path.join(base, 'VIDEOS_MUSICA'), 'music')
  const control = getVideoControl(db)
  const desde = dayStr(dia(-35)), hasta = dayStr(futuro(35))
  const api: Record<string, unknown> = {
    getState: {
      appVersion: '0.1.0', dataDir: '%APPDATA%\\ContentOS', configPath: '%APPDATA%\\ContentOS\\config\\config.json', configError: null,
      configuredRoots: ['C:\\demo\\CAMPAIGNS'], libraries: listLibraries(db).map((l) => ({ ...l, rootPath: 'C:\\demo\\CAMPAIGNS' })), campaigns: campañas, counts: counts(db),
      lastRun: lastSyncRun(db), syncing: false, youtubeConnected: true, youtubeChannels: listChannels(db, 'clips'), socialConnected: [],
      personalChannels: listChannels(db, 'personal'), todayLeft: plan.left, accounts: listAccounts(db), vyroNew: 0,
      videosAlert: control.counts.duplicate + control.counts.missing + control.counts.manual + control.counts.not_found + control.counts.unchecked,
      vyroToSend: listVyroPending(db).length, extrasCount: extras.total, longPending: largosView.videos.filter((v) => !v.uploadedAt).length,
      musicPending: musica.videos.filter((v) => !v.uploadedAt).length
    },
    listClips: Object.fromEntries([['', listClips(db, null)], ...campañas.map((c) => [c.campaignId, listClips(db, c.campaignId)])]),
    getClip: Object.fromEntries(TODOS.map((k) => [k.id, getClip(db, k.id)])),
    listPublished: listPublished(db),
    listSyncProblems: listSyncProblems(db),
    youtubeDashboard: { clips: getChannelDashboards(db, ahora, 'clips'), personal: getChannelDashboards(db, ahora, 'personal') },
    socialDashboard: getSocialDashboards(db),
    getStats: getStats(db, ahora),
    getStatsSeries: getStatsSeries(db),
    getPlan: plan,
    getWeekendPlan: getWeekendPlan(db, ahora, NO_ADVICE),
    getVyroPending: listVyroPending(db),
    getCalendar: getCalendar(db, desde, hasta, ahora, { plan, weekend: getWeekendPlan(db, ahora, NO_ADVICE), notes: [], notesFile: null, notesError: null }),
    getVyro: getVyro(db),
    getVideoControl: control,
    getAccountBook: (() => {
      const entries = [
        { platform: 'youtube', channel: '@canaldemo', email: 'canal.demo@example.com', note: 'Canal principal de clips' },
        { platform: 'tiktok', channel: '@democlips', email: 'canal.demo@example.com', note: null },
        { platform: 'instagram', channel: '@democlips.reels', email: 'reels.demo@example.com', note: 'Solo Reels' }
      ]
      const correos = [...new Set(entries.map((e) => e.email))]
      return { file: 'C:\\demo\\PLAN\\cuentas.json', updatedAt: iso(dia(-3, 10)), entries, byEmail: correos.map((email) => ({ email, entries: entries.filter((e) => e.email === email) })), error: null }
    })(),
    getVyroAccount: { connected: false },
    listExtras: extras,
    listLongVideos: { long: { ...largosView, folder: 'C:\\demo\\VIDEOS_LARGOS' }, music: { ...musica, folder: 'C:\\demo\\VIDEOS_MUSICA' } },
    getRawFiles: null,
    calendarRange: [desde, hasta]
  }
  // ninguna ruta de este equipo en la demo: la carpeta temporal pasa a ser C:\\demo
  const limpiar = (v: unknown): unknown => typeof v === 'string' ? (v.startsWith(base) ? 'C:\\demo' + v.slice(base.length).replace(/\//g, '\\') : v)
    : Array.isArray(v) ? v.map(limpiar) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limpiar(x)])) : v
  const texto = JSON.stringify({ generatedAt: ahora.toISOString(), api: limpiar(api) })
  if (texto.includes(base) || texto.includes(os.tmpdir() + path.sep + 'cos_')) throw new Error('Queda una ruta temporal en los datos de la demo')
  fs.writeFileSync(path.join(OUT, 'api.json'), texto)
  fs.writeFileSync(path.join(OUT, 'media.json'), JSON.stringify({
    clips: TODOS.map((k) => ({ id: k.id, title: k.title, campaign: k.campaign })),
    channel: CH,
    videos: TODOS.map((k) => ({ videoId: vid(k.id), title: k.title, campaign: k.campaign })),
    long: largosView.videos.map((v) => v.id)
  }, null, 1))
  console.log(`demo: ${TODOS.length} clips, ${listPublished(db).length} publicaciones → ${OUT}`)
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
}

void main()
