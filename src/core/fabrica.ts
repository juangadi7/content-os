/**
 * «Fábrica» de Curiosidades (16-nov-2026, pedido por Juan): panel de la fábrica de vídeos que vive en
 * Desktop/Cosas IA/Canal curiosidades (skill /fabrica + agentes cazador-temas, guionista, revisor, animador).
 *
 * Solo LEE lo que la fábrica escribe:
 *   fabrica/tandas/<fecha>/estado.json   paso de cada vídeo, notas, cola de Metricool revisada y lista propuesta
 *   fabrica/tandas/<fecha>/temas.json    candidatos del cazador con la nota del revisor
 *   videos/<NN-tema>/guion.json          título
 *   videos/<NN-tema>/revision/nota.json  nota detallada del revisor
 *   videos/<NN-tema>/revision/f00_4.jpg  fotograma del segundo 0 (se sirve como cos://fabrica/<NN-tema>/f00_4.jpg)
 * No escribe nada en esa carpeta.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Pasos de un vídeo dentro de la fábrica, en orden. */
export const FABRICA_PASOS = ['tema', 'guion', 'voz', 'animacion', 'revision', 'listo'] as const
export type FabricaPaso = (typeof FABRICA_PASOS)[number] | 'tirado'

export interface FabricaNota {
  total: number | null
  veredicto: 'pasa' | 'rehacer' | 'tirar' | null
  guion: number | null
  video: number | null
  notaTema: number | null
  notasGuion: string
  notasVideo: string
  queRehacer: string
  /** Puntos por apartado (guion y vídeo juntos), con su máximo. */
  detalle: { nombre: string; puntos: number; max: number }[]
}

export interface FabricaVideo {
  id: string
  tema: string
  titulo: string
  paso: FabricaPaso
  nota: number | null
  intentos: number
  motivo: string
  render: string
  conFoto: boolean
  revision: FabricaNota | null
}

export interface FabricaTema {
  id: string
  tema: string
  gancho: string
  porQue: string
  nota: number | null
  comentario: string
  estado: 'elegido' | 'reserva' | 'fuera' | 'sin revisar'
}

export interface FabricaCola {
  dia: string
  /** «10:00» / «16:00» (desde el 17-nov hay 2 al día); vacío en tandas antiguas. */
  hora: string
  video: string
  archivo: string
  estado: 'propuesto' | 'programado' | 'publicado'
}

export interface FabricaTanda {
  fecha: string
  n: number
  videos: FabricaVideo[]
  temas: FabricaTema[]
  /** Revisión de la cola de Metricool (si la hubo): «NN-tema (nota)». */
  colaRevisada: { pasa: string[]; rehacer: string[]; tirar: string[] } | null
  /** Lista de subida (propuesta o ya programada en Metricool). */
  cola: FabricaCola[]
  metricool: string
  tieneInforme: boolean
  /** `paso` general de la tanda que escribe el jefe («temas» mientras el cazador busca; «fin» al acabar). */
  paso: string
  /** Última vez que se escribió estado.json (ms). */
  actualizado: number
}

/** Una tanda que lleva más de 3 h sin escribir nada se da por parada (se cortó el límite de uso, se cerró…). */
const PARADA_MS = 3 * 3600_000

/**
 * ¿Está trabajando la fábrica en esta tanda? Sí si algún vídeo va por la mitad, o si todavía no hay vídeos
 * (el cazador está buscando temas) y la tanda no está cerrada; nunca si lleva más de 3 h sin moverse.
 */
export function tandaEnMarcha(t: FabricaTanda, ahora = Date.now()): boolean {
  if (t.actualizado && ahora - t.actualizado > PARADA_MS) return false
  if (/^(fin|terminad|hecha|listo)/i.test(t.paso)) return false
  if (t.videos.length === 0) return t.paso !== ''
  return t.videos.some((v) => v.paso !== 'listo' && v.paso !== 'tirado')
}

/** Una propuesta del «mejorador» (17-nov): qué cambiar para subir la calidad, gratis o de pago. */
export interface FabricaMejora {
  titulo: string
  que: string
  porQue: string
  tipo: 'gratis' | 'pago'
  coste: string
  importancia: 'alta' | 'media' | 'baja'
  quien: string
}

/** Informe diario del mejorador: fabrica/mejoras/<fecha>/mejoras.json. */
export interface FabricaMejoras {
  fecha: string
  resumen: string
  importante: boolean
  aviso: string
  nuestros: string
  virales: { titulo: string; enlace: string; visitas: number | null; porQue: string }[]
  mejoras: FabricaMejora[]
  tieneInforme: boolean
}

export interface FabricaView {
  carpeta: string
  existe: boolean
  tandas: FabricaTanda[]
  /** Informes del mejorador, el más reciente primero (máx. 14). */
  mejoras: FabricaMejoras[]
}

/** Máximo de cada apartado de la nota (FABRICA.md). */
const MAXIMOS: Record<string, [string, number]> = {
  primera_frase_tu: ['1.ª frase con «tú»', 5],
  parece_imposible: ['Parece imposible', 5],
  pregunta_abierta: ['Pregunta abierta', 15],
  historia_con_giro: ['Historia con giro', 15],
  lo_mas_loco_final_vuelta: ['Lo más loco y final', 10],
  datos_con_fuente: ['Datos con fuente', 5],
  cierre_sigueme: ['Cierre «Sígueme»', 5],
  segundo0: ['Segundo 0', 15],
  imagen: ['Imagen', 10],
  duracion: ['Duración', 5],
  musica_volumen: ['Música y volumen', 5],
  voz: ['Voz', 5]
}

const ID_VIDEO = /^\d{2,3}-[a-z0-9-]+$/
const FECHA = /^\d{4}-\d{2}-\d{2}(-\d+)?$/

function leerJson(ruta: string): any {
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}
const texto = (v: unknown) => (typeof v === 'string' ? v : '')
const numero = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function leerNota(carpeta: string, id: string): FabricaNota | null {
  const n = leerJson(path.join(carpeta, 'videos', id, 'revision', 'nota.json'))
  if (!n || typeof n !== 'object') return null
  const detalle: FabricaNota['detalle'] = []
  for (const parte of [n.guion?.detalle, n.video_final?.detalle]) {
    if (!parte || typeof parte !== 'object') continue
    for (const [k, v] of Object.entries(parte)) {
      const p = numero(v)
      if (p == null) continue
      const [nombre, max] = MAXIMOS[k] ?? [k.replace(/_/g, ' '), 0]
      detalle.push({ nombre, puntos: p, max })
    }
  }
  const v = texto(n.veredicto)
  return {
    total: numero(n.total),
    veredicto: v === 'pasa' || v === 'rehacer' || v === 'tirar' ? v : null,
    guion: numero(n.guion?.puntos),
    video: numero(n.video_final?.puntos),
    notaTema: numero(n.nota_tema),
    notasGuion: texto(n.guion?.notas),
    notasVideo: texto(n.video_final?.notas),
    queRehacer: texto(n.que_rehacer),
    detalle
  }
}

function leerTanda(carpeta: string, fecha: string): FabricaTanda | null {
  const dir = path.join(carpeta, 'fabrica', 'tandas', fecha)
  const e = leerJson(path.join(dir, 'estado.json'))
  const t = leerJson(path.join(dir, 'temas.json'))
  if (!e && !t) return null

  const videos: FabricaVideo[] = (Array.isArray(e?.videos) ? e.videos : [])
    .filter((v: any) => v && typeof v.id === 'string')
    .map((v: any): FabricaVideo => {
      const id: string = v.id
      const valido = ID_VIDEO.test(id)
      const guion = valido ? leerJson(path.join(carpeta, 'videos', id, 'guion.json')) : null
      const paso = texto(v.paso)
      return {
        id,
        tema: texto(v.tema),
        titulo: texto(guion?.title) || texto(v.tema) || id,
        paso: ([...FABRICA_PASOS, 'tirado'] as string[]).includes(paso) ? (paso as FabricaPaso) : 'tema',
        nota: numero(v.nota),
        intentos: numero(v.intentos) ?? 0,
        motivo: texto(v.motivo),
        render: texto(v.render),
        conFoto: valido && fs.existsSync(path.join(carpeta, 'videos', id, 'revision', 'f00_4.jpg')),
        revision: valido ? leerNota(carpeta, id) : null
      }
    })

  const rev = t?.revision_tema ?? {}
  const lista = (k: string): string[] => (Array.isArray(rev[k]) ? rev[k].filter((x: unknown) => typeof x === 'string') : [])
  const elegidos = lista('elegidos')
  const reservas = lista('reservas')
  const fuera = lista('fuera')
  const temas: FabricaTema[] = (Array.isArray(t?.candidatos) ? t.candidatos : [])
    .filter((c: any) => c && typeof c.id === 'string')
    .map((c: any): FabricaTema => ({
      id: c.id,
      tema: texto(c.tema),
      gancho: texto(c.gancho_propuesto),
      porQue: texto(c.por_que_es_top),
      nota: numero(c.nota_tema),
      comentario: texto(c.comentario_revisor),
      estado:
        c.elegido === true || elegidos.includes(c.id) ? 'elegido'
          : c.reserva === true || reservas.includes(c.id) ? 'reserva'
            : fuera.includes(c.id) || numero(c.nota_tema) != null ? 'fuera'
              : 'sin revisar'
    }))
    .sort((a: FabricaTema, b: FabricaTema) => (b.nota ?? -1) - (a.nota ?? -1))

  const cr = e?.cola_metricool_revisada
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : [])
  const cola: FabricaCola[] = (Array.isArray(e?.cola) ? e.cola : [])
    .filter((c: any) => c && typeof c.dia === 'string' && typeof c.video === 'string')
    .map((c: any): FabricaCola => ({
      dia: c.dia,
      hora: texto(c.hora),
      video: c.video,
      archivo: texto(c.archivo),
      estado: c.estado === 'programado' || c.estado === 'publicado' ? c.estado : 'propuesto'
    }))
    .sort((a: FabricaCola, b: FabricaCola) => (a.dia + a.hora).localeCompare(b.dia + b.hora))

  return {
    fecha,
    n: numero(e?.N) ?? videos.length,
    videos,
    temas,
    colaRevisada: cr && typeof cr === 'object' ? { pasa: arr(cr.pasa), rehacer: arr(cr.rehacer), tirar: arr(cr.tirar) } : null,
    cola,
    metricool: texto(e?.metricool),
    tieneInforme: fs.existsSync(path.join(dir, 'INFORME.md')),
    paso: texto(e?.paso),
    actualizado: (() => {
      try {
        return fs.statSync(path.join(dir, 'estado.json')).mtimeMs
      } catch {
        return 0
      }
    })()
  }
}

function leerMejoras(carpeta: string, fecha: string): FabricaMejoras | null {
  const dir = path.join(carpeta, 'fabrica', 'mejoras', fecha)
  const m = leerJson(path.join(dir, 'mejoras.json'))
  if (!m || typeof m !== 'object') return null
  const virales = (Array.isArray(m.virales) ? m.virales : [])
    .filter((v: any) => v && typeof v === 'object')
    .map((v: any) => ({ titulo: texto(v.titulo), enlace: texto(v.enlace), visitas: numero(v.visitas), porQue: texto(v.por_que_funciona) }))
  const orden = { alta: 0, media: 1, baja: 2 }
  const mejoras: FabricaMejora[] = (Array.isArray(m.mejoras) ? m.mejoras : [])
    .filter((x: any) => x && typeof x.titulo === 'string')
    .map((x: any): FabricaMejora => ({
      titulo: x.titulo,
      que: texto(x.que),
      porQue: texto(x.por_que),
      tipo: x.tipo === 'pago' ? 'pago' : 'gratis',
      coste: texto(x.coste),
      importancia: x.importancia === 'alta' || x.importancia === 'baja' ? x.importancia : 'media',
      quien: texto(x.quien)
    }))
    .sort((a: FabricaMejora, b: FabricaMejora) => orden[a.importancia] - orden[b.importancia])
  return {
    fecha,
    resumen: texto(m.resumen),
    importante: m.importante === true,
    aviso: texto(m.aviso),
    nuestros: texto(m.nuestros),
    virales,
    mejoras,
    tieneInforme: fs.existsSync(path.join(dir, 'MEJORAS.md'))
  }
}

function listarFechas(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && FECHA.test(d.name)).map((d) => d.name).sort().reverse()
  } catch {
    return []
  }
}

/** Todas las tandas, la más reciente primero. */
export function readFabrica(carpeta: string): FabricaView {
  const raiz = path.join(carpeta, 'fabrica', 'tandas')
  const tandas = listarFechas(raiz).map((f) => leerTanda(carpeta, f)).filter((t): t is FabricaTanda => t !== null)
  const mejoras = listarFechas(path.join(carpeta, 'fabrica', 'mejoras'))
    .map((f) => leerMejoras(carpeta, f))
    .filter((m): m is FabricaMejoras => m !== null)
    .slice(0, 14)
  return { carpeta, existe: fs.existsSync(carpeta), tandas, mejoras }
}

/** Ruta de una imagen de revisión (solo f00_4.jpg y hoja.jpg de un vídeo con nombre válido). */
export function resolveFabricaImage(carpeta: string, id: unknown, archivo: unknown): string | null {
  if (typeof id !== 'string' || !ID_VIDEO.test(id)) return null
  if (archivo !== 'f00_4.jpg' && archivo !== 'hoja.jpg') return null
  const ruta = path.join(carpeta, 'videos', id, 'revision', archivo)
  return fs.existsSync(ruta) ? ruta : null
}

/** Ruta del informe de una tanda (para abrirlo). */
export function resolveFabricaReport(carpeta: string, fecha: unknown): string | null {
  if (typeof fecha !== 'string' || !FECHA.test(fecha)) return null
  const ruta = path.join(carpeta, 'fabrica', 'tandas', fecha, 'INFORME.md')
  return fs.existsSync(ruta) ? ruta : null
}

/** Informe del mejorador de un día (para abrirlo). */
export function resolveFabricaMejoras(carpeta: string, fecha: unknown): string | null {
  if (typeof fecha !== 'string' || !FECHA.test(fecha)) return null
  const ruta = path.join(carpeta, 'fabrica', 'mejoras', fecha, 'MEJORAS.md')
  return fs.existsSync(ruta) ? ruta : null
}

/** Solo enlaces a vídeos de YouTube, TikTok o Instagram (los virales que mira el mejorador). */
export function esEnlaceViral(url: unknown): url is string {
  return typeof url === 'string' && /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com)\/[^\s]*$/.test(url)
}

/** Último render bueno de un vídeo (NN-tema_vX.mp4, nunca raw.mp4). */
export function resolveFabricaRender(carpeta: string, id: unknown): string | null {
  if (typeof id !== 'string' || !ID_VIDEO.test(id)) return null
  const dir = path.join(carpeta, 'videos', id, 'renders')
  try {
    const mp4 = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4') && f !== 'raw.mp4').sort()
    return mp4.length ? path.join(dir, mp4[mp4.length - 1]) : null
  } catch {
    return null
  }
}
