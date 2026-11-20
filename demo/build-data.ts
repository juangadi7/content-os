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
import { OWN_CHANNELS, addOwnAccount, addOwnStats, getOwnChannelStats, setOwnPost, type OwnChannel, type OwnPlatform } from '../src/core/own-channels'
import { importOwnVideos } from '../src/core/own-import'
import { readFabrica } from '../src/core/fabrica'
import { applyMetricoolQueue, metricoolQueueView, readMetricoolQueue, scheduledByFolder } from '../src/core/metricool-queue'

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


  // ---------------------------------------------------------------- canales propios (GTA 6, Curiosidades, Historias Roblox)
  // Los vídeos entran con la misma función que «Añadir vídeos»; las subidas y las cifras, con las de «Apuntar cifras».
  const PROPIOS: Record<OwnChannel, { carpeta: string; cuentas: Partial<Record<OwnPlatform, string>>; videos: [string, number, number][] }> = {
    gta: { carpeta: 'VIDEOS_GTA6', cuentas: { tiktok: '@noticiasdemo', youtube: '@gta6demo' }, videos: [
      ['GTA 6: todo lo que sabemos del mapa', -26, 48000], ['Los 5 detalles del tráiler que nadie vio', -19, 91000],
      ['¿Cuánto costará GTA 6? Lo que dicen las tiendas', -12, 23500], ['Vice City entonces y ahora', -6, 35800], ['Las físicas del agua en GTA 6', -2, 7400]
    ] },
    curio: { carpeta: 'VIDEOS_CURIOSIDADES', cuentas: { youtube: '@curiosidadesdemo', tiktok: '@curiosidades.demo', instagram: '@curiosidades.demo' }, videos: [
      ['El espía que engañó a medio mundo desde un sofá', -21, 64000], ['El pueblo donde está prohibido morir', -16, 120000],
      ['Por qué los aviones no vuelan en línea recta', -11, 41000], ['El hombre que vivió 18 años en un aeropuerto', -7, 88000],
      ['La isla que cambia de país cada seis meses', -3, 15600], ['El sonido que se oyó a 4.800 km', -1, 2100]
    ] },
    roblox: { carpeta: 'VIDEOS_ROBLOX', cuentas: { youtube: '@historiasdemo' }, videos: [
      ['La casa del árbol que nadie construyó', -15, 18200], ['El servidor que se quedó vacío a las 3:00', -9, 27400], ['Mi mejor amigo era un bot', -4, 9900]
    ] }
  }
  const tmpMp4 = path.join(base, 'mp4')
  fs.mkdirSync(tmpMp4, { recursive: true })
  const carpetasPropias = {} as Record<OwnChannel, string>
  for (const c of OWN_CHANNELS) {
    const def = PROPIOS[c]
    carpetasPropias[c] = path.join(base, def.carpeta)
    const items = def.videos.map(([titulo], i) => {
      const f = path.join(tmpMp4, `${c}_${i + 1}.mp4`)
      fs.writeFileSync(f, `demo ${c} ${i}`)
      return { path: f, title: titulo, description: `${titulo} #shorts` }
    })
    const creados = importOwnVideos(carpetasPropias[c], c, items).created
    // portada de cada vídeo (la imagen real la dibuja demo/make_media.py)
    for (const { id } of creados) fs.writeFileSync(path.join(carpetasPropias[c], id, 'miniatura_A.jpg'), 'demo')
    for (const [plat, cuenta] of Object.entries(def.cuentas) as [OwnPlatform, string][]) addOwnAccount(db, c, plat, cuenta, iso(dia(-30, 9)))
    creados.forEach(({ id }, i) => {
      const [, subida, techo] = def.videos[i]
      for (const [plat, cuenta] of Object.entries(def.cuentas) as [OwnPlatform, string][]) {
        const factor = plat === 'tiktok' ? 1.3 : plat === 'instagram' ? 0.45 : 1
        const url = plat === 'youtube' ? `https://www.youtube.com/shorts/${(c + i + 'demo').padEnd(11, 'x').slice(0, 11)}`
          : plat === 'tiktok' ? `https://www.tiktok.com/${cuenta}/video/73000000000000${String(i + 1).padStart(5, '0')}` : null
        setOwnPost(db, { channel: c, video: id, platform: plat, uploaded: true, url, account: cuenta }, iso(dia(subida, 18)))
        // mediciones a las ~2 h, 1 día, 2 días, 4 días, 1 semana y anoche
        const horas = [2, 24, 48, 96, 168, (-1 - subida) * 24 + 4].filter((h, k, a) => h > 0 && a.indexOf(h) === k && subida + h / 24 <= -0.2)
        for (const h of horas) {
          const t = new Date(dia(subida, 18).getTime() + h * 3_600_000)
          const v = Math.round(techo * factor * (1 - Math.exp(-h / 40)))
          addOwnStats(db, {
            channel: c, video: id, platform: plat, views: v, likes: Math.round(v * 0.052), comments: Math.round(v * 0.003), shares: Math.round(v * 0.007),
            ...(plat === 'youtube' ? { viewedPct: 62 + (i * 7) % 20, avgViewS: 19 + (i * 3) % 12, retention: 74 + (i * 5) % 18 } : {})
          }, t.toISOString())
        }
      }
    })
  }

  // ---------------------------------------------------------------- Fábrica de Curiosidades (equipo de agentes de IA)
  const fab = path.join(base, 'Canal curiosidades')
  const escribir = (rel: string, datos: unknown) => {
    const r = path.join(fab, rel)
    fs.mkdirSync(path.dirname(r), { recursive: true })
    fs.writeFileSync(r, typeof datos === 'string' ? datos : JSON.stringify(datos, null, 1))
  }
  const fechaTanda = dayStr(dia(0, 9))
  const tanda = [
    { id: '61-sofa', tema: 'El espía del sofá', titulo: 'El espía que engañó a medio mundo desde un sofá', paso: 'listo', nota: 94 },
    { id: '62-aeropuerto', tema: 'Aeropuerto', titulo: 'El hombre que vivió 18 años en un aeropuerto', paso: 'listo', nota: 91 },
    { id: '63-isla', tema: 'Isla compartida', titulo: 'La isla que cambia de país cada seis meses', paso: 'revision', nota: null },
    { id: '64-sonido', tema: 'El sonido más fuerte', titulo: 'El sonido que se oyó a 4.800 km', paso: 'animacion', nota: null },
    { id: '65-faro', tema: 'El faro sin farero', titulo: 'El faro que lleva 100 años encendido solo', paso: 'guion', nota: null }
  ]
  escribir(`fabrica/tandas/${fechaTanda}/estado.json`, {
    fecha: fechaTanda, N: tanda.length,
    videos: tanda.map((t) => ({ id: t.id, tema: t.tema, paso: t.paso, nota: t.nota, intentos: t.id === '63-isla' ? 1 : 0, motivo: t.id === '63-isla' ? 'El segundo 0 no engancha: se repite la animación.' : '', ...(t.paso === 'listo' ? { render: 'v1' } : {}) })),
    cola: [
      { dia: dayStr(futuro(1)), hora: '10:00', video: '61-sofa', archivo: '61-sofa.mp4', estado: 'programado' },
      { dia: dayStr(futuro(1)), hora: '18:00', video: '62-aeropuerto', archivo: '62-aeropuerto.mp4', estado: 'propuesto' }
    ],
    metricool: 'Uno programado; el otro espera tu OK.'
  })
  escribir(`fabrica/tandas/${fechaTanda}/temas.json`, {
    candidatos: [
      { id: 't1', tema: 'El espía del sofá', nota_tema: 9, elegido: true }, { id: 't2', tema: 'Aeropuerto', nota_tema: 9, elegido: true },
      { id: 't3', tema: 'Isla compartida', nota_tema: 8, elegido: true }, { id: 't4', tema: 'El sonido más fuerte', nota_tema: 8, elegido: true },
      { id: 't5', tema: 'El faro sin farero', nota_tema: 7, elegido: true }, { id: 't6', tema: 'La ciudad bajo el hielo', nota_tema: 7, reserva: true },
      { id: 't7', tema: 'Récords de la lotería', nota_tema: 5 }
    ],
    revision_tema: { elegidos: ['t1', 't2', 't3', 't4', 't5'], reservas: ['t6'], fuera: ['t7'] }
  })
  for (const t of tanda) {
    escribir(`videos/${t.id}/guion.json`, { title: t.titulo })
    if (t.nota) escribir(`videos/${t.id}/revision/nota.json`, { total: t.nota, veredicto: 'pasa', nota_tema: 9,
      guion: { puntos: t.nota - 37, detalle: { pregunta_abierta: 14, gancho: 15 } }, video_final: { puntos: 37, detalle: { segundo0: 14, ritmo: 12 } } })
  }
  escribir(`fabrica/mejoras/${fechaTanda}/MEJORAS.md`, '# Mejoras\n')
  escribir(`fabrica/mejoras/${fechaTanda}/mejoras.json`, {
    fecha: fechaTanda, resumen: 'Los vídeos que más funcionan enseñan la imagen más rara en el segundo 0.', importante: true,
    aviso: 'Abrir con la escena más increíble', nuestros: 'Los dos últimos superan el 70 % de retención en YouTube.',
    virales: [{ titulo: 'El pueblo que no aparece en los mapas', enlace: 'https://www.youtube.com/shorts/demoviral01', visitas: 2_300_000, por_que_funciona: 'Pregunta abierta en la primera frase' }],
    mejoras: [
      { titulo: 'Imagen imposible en el segundo 0', que: 'Abrir con la escena final', por_que: '3 de 3 virales lo hacen', tipo: 'gratis', coste: '0 €', importancia: 'alta', quien: 'animador' },
      { titulo: 'Subtítulos más grandes', que: 'Subir a 90 px', por_que: 'Se leen mejor en el móvil', tipo: 'gratis', importancia: 'baja', quien: 'animador' },
      { titulo: 'Voz más natural', que: 'Probar otra voz sintética', por_que: 'Retención', tipo: 'pago', coste: '5 €/mes', importancia: 'media', quien: 'voz' }
    ]
  })
  const fabrica = readFabrica(fab)

  // ---------------------------------------------------------------- cola de Metricool (vídeos programados de Curiosidades)
  const curioVista = listLongVideos(db, carpetasPropias.curio, 'curio').videos
  const curioIds = curioVista.map((v) => v.id)
  const idDe = (titulo: string) => curioVista.find((v) => v.titles[0]?.text === titulo)!.id
  fs.mkdirSync(path.join(fab, 'fabrica'), { recursive: true })
  const colaFile = path.join(fab, 'fabrica', 'cola_metricool.json')
  fs.writeFileSync(colaFile, JSON.stringify({
    actualizado: iso(dia(0, 8)),
    programados: [
      { carpeta_content_os: idDe(PROPIOS.curio.videos[4][0]), nn: idDe(PROPIOS.curio.videos[4][0]), titulo: PROPIOS.curio.videos[4][0], red: 'YouTube Shorts', fecha: `${dayStr(dia(-3))}T10:00`, estado: 'publicado' },
      { carpeta_content_os: idDe(PROPIOS.curio.videos[5][0]), nn: idDe(PROPIOS.curio.videos[5][0]), titulo: PROPIOS.curio.videos[5][0], red: 'YouTube Shorts', fecha: `${dayStr(futuro(1))}T10:00`, estado: 'programado' },
      { carpeta_content_os: 'proximo', nn: '62', titulo: 'El hombre que vivió 18 años en un aeropuerto', red: 'YouTube Shorts', fecha: `${dayStr(futuro(1))}T18:00`, estado: 'programado' }
    ],
    problemas: []
  }))
  const cola = readMetricoolQueue(colaFile)
  applyMetricoolQueue(db, cola, new Set(curioIds))
  const programados = scheduledByFolder(cola)

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
  const propios = Object.fromEntries(OWN_CHANNELS.map((c) => {
    const vista = { ...listLongVideos(db, carpetasPropias[c], c), folder: `C:\\demo\\${PROPIOS[c].carpeta}` }
    for (const v of vista.videos) v.sizeBytes = null
    if (c === 'curio') vista.videos = vista.videos.map((v) => ({ ...v, scheduledAt: programados.get(v.id) ?? null }))
    return [c, vista]
  })) as Record<OwnChannel, ReturnType<typeof listLongVideos>>
  const desde = dayStr(dia(-35)), hasta = dayStr(futuro(35))
  const api: Record<string, unknown> = {
    getState: {
      appVersion: '0.1.0', dataDir: '%APPDATA%\\ContentOS', configPath: '%APPDATA%\\ContentOS\\config\\config.json', configError: null,
      configuredRoots: ['C:\\demo\\CAMPAIGNS'], libraries: listLibraries(db).map((l) => ({ ...l, rootPath: 'C:\\demo\\CAMPAIGNS' })), campaigns: campañas, counts: counts(db),
      lastRun: lastSyncRun(db), syncing: false, youtubeConnected: true, youtubeChannels: listChannels(db, 'clips'), socialConnected: [],
      personalChannels: listChannels(db, 'personal'), todayLeft: plan.left, accounts: listAccounts(db), vyroNew: 0,
      videosAlert: control.counts.duplicate + control.counts.missing + control.counts.manual + control.counts.not_found + control.counts.unchecked,
      vyroToSend: listVyroPending(db).length, extrasCount: extras.total, longPending: largosView.videos.filter((v) => !v.uploadedAt).length,
      musicPending: musica.videos.filter((v) => !v.uploadedAt).length,
      cityPending: 0,
      robloxPending: propios.roblox.videos.filter((v) => !v.uploadedAt).length,
      curioPending: propios.curio.videos.filter((v) => !v.uploadedAt && !v.scheduledAt).length,
      gtaPending: propios.gta.videos.filter((v) => !v.uploadedAt).length,
      ownVideos: Object.fromEntries(OWN_CHANNELS.map((c) => [c, propios[c].total])),
      background: null
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
    listLongVideos: { long: { ...largosView, folder: 'C:\\demo\\VIDEOS_LARGOS' }, city: { ...musica, folder: 'C:\\demo\\VIDEOS_CIUDAD' }, music: { ...musica, folder: 'C:\\demo\\VIDEOS_MUSICA' }, ...propios },
    getOwnStats: Object.fromEntries(OWN_CHANNELS.map((c) => [c, getOwnChannelStats(db, c, propios[c].videos.map((v) => ({ id: v.id, title: v.titles[0]?.text ?? v.id, description: v.description })), [])])),
    getFabrica: fabrica,
    getMetricoolQueue: metricoolQueueView(cola, ahora),
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
    long: largosView.videos.map((v) => v.id),
    own: Object.fromEntries(OWN_CHANNELS.map((c) => [c, propios[c].videos.map((v) => ({ id: v.id, title: v.titles[0]?.text ?? v.id }))])),
    fabrica: tanda.map((t) => ({ id: t.id, title: t.titulo }))
  }, null, 1))
  console.log(`demo: ${TODOS.length} clips, ${listPublished(db).length} publicaciones → ${OUT}`)
  db.close()
  fs.rmSync(base, { recursive: true, force: true })
}

void main()
