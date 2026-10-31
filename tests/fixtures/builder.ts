/**
 * Construye bibliotecas de ejemplo en una carpeta temporal, con la misma forma que deja
 * mundial-clipper (campaign.json, clip_ids.json, METADATA, QA, REPORT, CLIPS).
 * Los MP4 son archivos pequeños de mentira: al importador solo le importa su contenido.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ClipSpec {
  n: number
  clipId: string | null
  title?: string
  filename?: string
  content?: string
  score?: number | null
  qa?: number
  start?: number
  end?: number
  campaignId?: string | null
}

export const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex')

export function tmpDir(prefix = 'cos_'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const nnn = (n: number) => String(n).padStart(3, '0')
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export class CampaignFixture {
  readonly dir: string
  constructor(readonly root: string, readonly folder: string, readonly campaignId: string, readonly name = folder) {
    this.dir = path.join(root, folder)
    for (const d of ['METADATA', 'CLIPS', 'QA', 'REPORT', 'SOURCE', 'FAILED', '_work']) fs.mkdirSync(path.join(this.dir, d), { recursive: true })
    fs.writeFileSync(path.join(this.dir, 'campaign.json'), JSON.stringify({ name, platform: 'Vyro', language: 'en', sources: ['x.mp4'] }, null, 2))
    fs.writeFileSync(path.join(this.dir, 'SOURCE', 'x.mp4'), 'fuente')
    fs.writeFileSync(path.join(this.dir, '_work', 'clips.json'), '[]')
    fs.writeFileSync(path.join(this.dir, 'FAILED', '099_rechazado.mp4'), 'rechazado')
    this.writeLedger([])
    this.writeReport()
  }

  metaPath(n: number) { return path.join(this.dir, 'METADATA', `clip_${nnn(n)}.json`) }
  clipPath(filename: string) { return path.join(this.dir, 'CLIPS', filename) }
  ledgerPath() { return path.join(this.dir, 'clip_ids.json') }

  writeLedger(clips: { clip_id: string; start_time: number; end_time: number }[], campaignId: string | null = this.campaignId) {
    fs.writeFileSync(this.ledgerPath(), JSON.stringify({ campaign_id: campaignId, clips: clips.map((c) => ({ ...c, source: 'x.mp4' })) }, null, 1))
  }

  writeReport(extra: Record<string, unknown> = {}) {
    fs.writeFileSync(path.join(this.dir, 'REPORT', 'campaign_report.json'),
      JSON.stringify({ campaign: this.name, date: '2026-01-01', clips_generated: 3, clips_rejected: 1, ...extra }, null, 2))
  }

  /** Escribe ficha + portada + QA + MP4 de un clip y lo apunta en clip_ids.json. Devuelve la ficha. */
  addClip(s: ClipSpec): Record<string, unknown> {
    const title = s.title ?? `Clip ${s.n}`
    const filename = s.filename ?? `${nnn(s.n)}_${slug(title)}.mp4`
    const content = s.content ?? `video-${s.clipId}-${s.n}`
    fs.writeFileSync(this.clipPath(filename), content)
    const start = s.start ?? s.n * 100
    const end = s.end ?? s.n * 100 + 30
    const meta: Record<string, unknown> = {
      metadata_version: 2,
      clip_id: s.clipId,
      campaign_id: s.campaignId === undefined ? this.campaignId : s.campaignId,
      filename, title, caption: `${title}. #tag`, hashtags: ['#tag'], language: 'en', duration: 30.5, status: 'READY',
      qa_score: s.qa ?? 0.99, source: 'x.mp4', start_time: start, end_time: end, style: { fuente: 'Arial' }, cover_second: 0.8,
      full_path: this.clipPath(filename), sha256: sha(content), created_at: '2026-01-01T10:00:00+01:00',
      score: s.score === undefined ? 90 : s.score, score_origin: 'unknown', selection_reason: null, prediction: null, metadata_errors: []
    }
    if (s.clipId === null) delete meta.clip_id
    this.writeMeta(s.n, meta)
    fs.writeFileSync(path.join(this.dir, 'METADATA', `clip_${nnn(s.n)}_portada.jpg`), `portada-${s.n}`)
    fs.writeFileSync(path.join(this.dir, 'QA', `clip_${nnn(s.n)}.json`),
      JSON.stringify({ clip_id: s.clipId, filename, summary: { technical_quality: 'PASS' }, qa_score: s.qa ?? 0.99 }))
    fs.writeFileSync(path.join(this.dir, 'QA', `clip_${nnn(s.n)}.png`), 'hoja')
    if (s.clipId) {
      const ledger = JSON.parse(fs.readFileSync(this.ledgerPath(), 'utf8'))
      ledger.clips = ledger.clips.filter((c: { clip_id: string }) => c.clip_id !== s.clipId)
      ledger.clips.push({ clip_id: s.clipId, source: 'x.mp4', start_time: start, end_time: end })
      fs.writeFileSync(this.ledgerPath(), JSON.stringify(ledger, null, 1))
    }
    return meta
  }

  readMeta(n: number): Record<string, unknown> { return JSON.parse(fs.readFileSync(this.metaPath(n), 'utf8')) }
  writeMeta(n: number, meta: Record<string, unknown>) { fs.writeFileSync(this.metaPath(n), JSON.stringify(meta, null, 2)) }
  patchMeta(n: number, cambios: Record<string, unknown>) { this.writeMeta(n, { ...this.readMeta(n), ...cambios }) }

  /** Quita un clip como lo haría una regeneración: sin ficha, sin portada, sin QA y sin MP4. */
  removeClip(n: number) {
    const meta = this.readMeta(n)
    for (const p of [this.metaPath(n), path.join(this.dir, 'METADATA', `clip_${nnn(n)}_portada.jpg`),
      path.join(this.dir, 'QA', `clip_${nnn(n)}.json`), path.join(this.dir, 'QA', `clip_${nnn(n)}.png`),
      this.clipPath(String(meta.filename))]) fs.rmSync(p, { force: true })
  }
}

/** Huella de todos los archivos de un árbol: ruta relativa -> tamaño, fecha y hash del contenido. */
export function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        out[path.relative(dir, p) + path.sep] = 'dir'
        walk(p)
      } else {
        const st = fs.statSync(p)
        out[path.relative(dir, p)] = `${st.size}:${Math.round(st.mtimeMs)}:${sha(fs.readFileSync(p))}`
      }
    }
  }
  walk(dir)
  return out
}
