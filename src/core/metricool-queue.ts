/**
 * Cola de Metricool de Curiosidades (17-nov-2026). La deja la fábrica del canal en
 * `Canal curiosidades/fabrica/datos/cola_metricool.json` cada día y cada vez que programa algo. La app solo la lee:
 *   - lo «programado» sale de «por subir» y lleva su etiqueta con la fecha;
 *   - lo «publicado» cuenta como subido a YouTube con source = 'metricool' (y su id de YouTube);
 *   - los «problemas» se enseñan como aviso.
 * Norma de Juan (17-nov): lo que no esté programado lo sube él a mano algunos días, para que YouTube no vea solo subidas automáticas.
 */
import fs from 'node:fs'
import type { DB } from './db'
import { shortUrl } from './youtube'

export interface MetricoolQueueItem {
  /** Carpeta del vídeo en VIDEOS_CURIOSIDADES (la clave). */
  folder: string
  /** Número del vídeo («44-funcionario» → «44»). */
  number: string | null
  /** Red donde se publica (la cola de hoy solo usa YouTube Shorts). */
  network: string
  title: string | null
  /** «2026-11-18T10:00» (hora de España). */
  at: string | null
  state: 'programado' | 'publicado'
  youtubeId: string | null
  problem: string | null
}

export interface MetricoolQueue {
  updatedAt: string | null
  items: MetricoolQueueItem[]
  problems: string[]
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Lee la cola. null si no existe o no se entiende (entonces no cambia nada en la app). */
export function readMetricoolQueue(file: string): MetricoolQueue | null {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
  if (!d || typeof d !== 'object') return null
  const items: MetricoolQueueItem[] = []
  for (const x of Array.isArray(d.programados) ? (d.programados as Record<string, unknown>[]) : []) {
    const folder = texto(x?.carpeta_content_os)
    const state = x?.estado === 'publicado' ? 'publicado' : x?.estado === 'programado' ? 'programado' : null
    if (!folder || !state) continue
    const yt = texto(x.youtube_id)
    const nn = texto(x.nn) ?? folder
    items.push({
      folder, number: /^(\d+)/.exec(nn)?.[1] ?? null, network: texto(x.red) ?? 'YouTube Shorts',
      title: texto(x.titulo), at: texto(x.fecha), state, youtubeId: yt && /^[A-Za-z0-9_-]{11}$/.test(yt) ? yt : null, problem: texto(x.problema)
    })
  }
  const problems = (Array.isArray(d.problemas) ? d.problemas : []).map(texto).filter((p): p is string => !!p)
  return { updatedAt: texto(d.actualizado), items, problems }
}

/** Carpeta → fecha de lo que está programado (todavía sin publicar). */
export function scheduledByFolder(q: MetricoolQueue | null): Map<string, string> {
  const m = new Map<string, string>()
  for (const i of q?.items ?? []) if (i.state === 'programado') m.set(i.folder, i.at ?? '')
  return m
}

/**
 * Lo ya publicado por Metricool pasa a las subidas del canal (YouTube, source 'metricool', con su id).
 * Si esa subida ya estaba apuntada (a mano o leída de la API), solo se le añade el id que falte; no se duplica.
 * Devuelve cuántas subidas nuevas apuntó.
 */
export function applyMetricoolQueue(db: DB, q: MetricoolQueue | null, folders: Set<string>, now = new Date().toISOString()): number {
  let n = 0
  for (const i of q?.items ?? []) {
    if (i.state !== 'publicado' || !folders.has(i.folder)) continue
    const ya = db.prepare("SELECT id, ext_id FROM own_posts WHERE channel = 'curio' AND video = ? AND platform = 'youtube'").get(i.folder) as { id: number; ext_id: string | null } | undefined
    const url = i.youtubeId ? shortUrl(i.youtubeId) : null
    const fecha = i.at && !Number.isNaN(Date.parse(i.at)) ? new Date(i.at).toISOString() : now
    if (ya) {
      if (!ya.ext_id && i.youtubeId) db.prepare('UPDATE own_posts SET ext_id = ?, url = COALESCE(url, ?) WHERE id = ?').run(i.youtubeId, url, ya.id)
      continue
    }
    // el mismo vídeo de YouTube no puede estar en dos carpetas
    if (i.youtubeId && db.prepare("SELECT 1 FROM own_posts WHERE platform = 'youtube' AND ext_id = ?").get(i.youtubeId)) continue
    const cuenta = (db.prepare("SELECT account FROM own_accounts WHERE channel = 'curio' AND platform = 'youtube' ORDER BY id LIMIT 1").get() as { account: string } | undefined)?.account ?? ''
    db.prepare("INSERT INTO own_posts (channel, video, platform, account, url, ext_id, posted_at, source, created_at) VALUES ('curio', ?, 'youtube', ?, ?, ?, ?, 'metricool', ?)")
      .run(i.folder, cuenta, url, i.youtubeId, fecha, now)
    n++
  }
  return n
}

/** Avisos de la cola para enseñar en rojo: los generales y los de cada vídeo («ya_publicado», «doble»). */
export function queueProblems(q: MetricoolQueue | null): string[] {
  if (!q) return []
  // el de un vídeo no se repite si ya sale en los avisos generales (la fábrica suele explicarlo ahí con más detalle)
  const yaDicho = (i: MetricoolQueueItem) => q.problems.some((p) => (i.title && p.includes(i.title)) || p.includes(i.folder))
  const porVideo = q.items.filter((i) => i.problem && !yaDicho(i)).map((i) => `${i.title ?? i.folder}: ${i.problem === 'ya_publicado' ? 'ya estaba publicado' : i.problem === 'doble' ? 'programado dos veces' : i.problem}`)
  return [...q.problems, ...porVideo]
}

/** Publicaciones gratis al mes en Metricool (plan Free). */
export const METRICOOL_FREE_PER_MONTH = 20

export interface MetricoolQueueView {
  /** false si la fábrica aún no ha dejado la cola. */
  exists: boolean
  updatedAt: string | null
  /** Por fecha, de la más antigua a la más reciente. */
  items: MetricoolQueueItem[]
  problems: string[]
  /** Programados que faltan por salir. */
  pending: number
  /** Fecha del último vídeo en cola (programado). */
  lastAt: string | null
  /** Publicaciones de este mes (programadas o ya publicadas) según la cola, y las que quedan del plan gratis. */
  usedThisMonth: number
  freeLeft: number
}

/** Pantalla «Cola de Metricool»: la cola ordenada por fecha con su resumen. «now» decide qué mes cuenta. */
export function metricoolQueueView(q: MetricoolQueue | null, now = new Date()): MetricoolQueueView {
  const items = [...(q?.items ?? [])].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
  const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const usados = items.filter((i) => (i.at ?? '').startsWith(mes)).length
  const programados = items.filter((i) => i.state === 'programado')
  return {
    exists: !!q,
    updatedAt: q?.updatedAt ?? null,
    items,
    problems: queueProblems(q),
    pending: programados.length,
    lastAt: programados.at(-1)?.at ?? null,
    usedThisMonth: usados,
    freeLeft: Math.max(0, METRICOOL_FREE_PER_MONTH - usados)
  }
}
