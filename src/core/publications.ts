/** Publicaciones manuales. Datos propios de CONTENT OS: nunca se escriben en el generador. */
import type { DB } from './db'
import { isPlatform, type Platform } from './format'
import { rememberAccount } from './plan'

export interface PublicationInput {
  /** Si se indica, se edita esa publicación; si no, se crea una nueva (clip + plataforma + cuenta no puede repetirse). */
  id?: number
  clipId: string
  platform: Platform
  account?: string
  url?: string | null
  /** ISO 8601. Por defecto, ahora. */
  publishedAt?: string | null
  titleUsed?: string | null
  captionUsed?: string | null
  notes?: string | null
}

type Row = Record<string, any>

const texto = (v: unknown, max: number): string | null => {
  if (v == null) return null
  if (typeof v !== 'string') throw new Error('Texto no válido.')
  const t = v.trim()
  if (t.length > max) throw new Error(`Texto demasiado largo (máximo ${max} caracteres).`)
  return t === '' ? null : t
}

/**
 * Marca un clip como publicado en una plataforma y cuenta. La primera vez guarda el hash del
 * MP4 que hay en ese momento (sha256_at_publish); al editar después, ese hash no se toca.
 * Devuelve el id de la publicación.
 */
export function savePublication(db: DB, input: PublicationInput, now: () => string = () => new Date().toISOString()): number {
  if (!input || typeof input.clipId !== 'string') throw new Error('Falta el clip.')
  if (!isPlatform(input.platform)) throw new Error('Plataforma no válida.')
  const clip = db.prepare('SELECT clip_id, sha256, file_sha256 FROM clips WHERE clip_id = ?').get(input.clipId) as Row | undefined
  if (!clip) throw new Error('El clip no existe.')

  const account = texto(input.account ?? '', 120) ?? ''
  const url = texto(input.url, 2000)
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('La URL debe empezar por http:// o https://')
  const t = now()
  let publishedAt = t
  if (input.publishedAt) {
    const d = new Date(input.publishedAt)
    if (Number.isNaN(d.getTime())) throw new Error('Fecha no válida.')
    publishedAt = d.toISOString()
  }
  const datos = {
    account, url, published_at: publishedAt, notes: texto(input.notes, 5000),
    title_used: texto(input.titleUsed, 2000), caption_used: texto(input.captionUsed, 10000), t
  }
  // hash real del archivo si se pudo calcular; si no, el del render que declara la ficha
  const hashActual: string | null = clip.file_sha256 ?? clip.sha256 ?? null

  const existente = (input.id != null
    ? db.prepare('SELECT * FROM publications WHERE id = ? AND clip_id = ?').get(input.id, input.clipId)
    : db.prepare('SELECT * FROM publications WHERE clip_id = ? AND platform = ? AND account = ?').get(input.clipId, input.platform, account)) as
    | Row
    | undefined
  if (input.id != null && !existente) throw new Error('La publicación no existe.')
  // sin id, una publicación ya existente no se pisa (se perderían su URL y sus notas): se edita
  if (input.id == null && existente) throw new Error('Ya hay una publicación de este clip en esa plataforma y cuenta. Usa «Editar».')

  try {
    if (existente) {
      db.prepare(
        `UPDATE publications SET account = @account, status = 'published', url = @url, published_at = @published_at, notes = @notes,
           title_used = @title_used, caption_used = @caption_used, sha256_at_publish = COALESCE(sha256_at_publish, @sha), updated_at = @t
         WHERE id = @id`
      ).run({ ...datos, sha: hashActual, id: existente.id })
      return existente.id as number
    }
    const r = db.prepare(
      `INSERT INTO publications (clip_id, platform, account, status, url, published_at, notes, title_used, caption_used,
         sha256_at_publish, created_at, updated_at)
       VALUES (@clip_id, @platform, @account, 'published', @url, @published_at, @notes, @title_used, @caption_used, @sha, @t, @t)`
    ).run({ ...datos, clip_id: input.clipId, platform: input.platform, sha: hashActual })
    rememberAccount(db, input.platform, account, t)
    return Number(r.lastInsertRowid)
  } catch (e) {
    if (/UNIQUE/.test((e as Error).message)) throw new Error('Ya hay una publicación de este clip en esa plataforma y cuenta.')
    throw e
  }
}

/** Quita la marca de publicado. No toca el clip ni ningún archivo. */
export function deletePublication(db: DB, id: number): void {
  if (!Number.isInteger(id)) throw new Error('Publicación no válida.')
  const medidas = (db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots WHERE publication_id = ?').get(id) as Row).n
  if (medidas > 0) throw new Error('Esta publicación tiene métricas guardadas y no se puede quitar.')
  db.transaction(() => {
    db.prepare("UPDATE youtube_videos SET publication_id = NULL, match_state = 'review', match_reason = NULL WHERE publication_id = ?").run(id)
    db.prepare('DELETE FROM publications WHERE id = ?').run(id)
  })()
}
