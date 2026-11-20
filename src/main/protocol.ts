/**
 * cos://clip/<clip_id>  y  cos://thumb/<clip_id>
 * cos://extra/<grupo>/<archivo>.mp4: vídeo de «Fuera de campaña», solo dentro de esa carpeta.
 * cos://long/<carpeta> y cos://long-thumb/<carpeta>/<A|B|C>: «Vídeos largos», solo dentro de su carpeta.
 * cos://music/<carpeta> y cos://music-thumb/<carpeta>/<A|B|C>: igual para «Vídeos de música».
 * cos://roblox/<carpeta> y cos://roblox-thumb/<carpeta>/<A|B|C>: igual para «Historias Roblox».
 * cos://curio/<carpeta> y cos://curio-thumb/<carpeta>/<A|B|C>: igual para «Curiosidades».
 * cos://fondo/<versión>: el fondo de pantalla elegido en Ajustes.
 * cos://fabrica/<NN-tema>/<f00_4.jpg|hoja.jpg>: fotogramas de la revisión de la fábrica de Curiosidades.
 * La interfaz pide por clip_id; la ruta real sale de la base de datos. No se puede pedir
 * ningún otro archivo del disco. Solo lectura, con soporte de saltos (Range) para el vídeo.
 */
import { protocol, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { MEDIA_SCHEME } from '../core/api'
import type { DB } from '../core/db'
import { resolveExtra, resolveExtraThumb } from '../core/extras'
import { resolveLongThumb, resolveLongVideo } from '../core/long-videos'
import { resolveFabricaImage } from '../core/fabrica'
import { clipPaths } from '../core/queries'
import { isChannelId } from '../core/youtube'

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
  ])
}

function servir(ruta: string, tipo: string, rango: string | null): Response {
  const total = fs.statSync(ruta).size
  const base = { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
  const m = rango ? /^bytes=(\d*)-(\d*)$/.exec(rango.trim()) : null
  if (m && (m[1] || m[2])) {
    let inicio = m[1] ? parseInt(m[1], 10) : Math.max(0, total - parseInt(m[2], 10))
    let fin = m[1] && m[2] ? parseInt(m[2], 10) : total - 1
    if (Number.isNaN(inicio) || inicio >= total) {
      return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${total}` } })
    }
    inicio = Math.max(0, inicio)
    fin = Math.min(fin, total - 1)
    const cuerpo = Readable.toWeb(fs.createReadStream(ruta, { start: inicio, end: fin })) as unknown as ReadableStream
    return new Response(cuerpo, {
      status: 206,
      headers: { ...base, 'Content-Length': String(fin - inicio + 1), 'Content-Range': `bytes ${inicio}-${fin}/${total}` }
    })
  }
  const cuerpo = Readable.toWeb(fs.createReadStream(ruta)) as unknown as ReadableStream
  return new Response(cuerpo, { status: 200, headers: { ...base, 'Content-Length': String(total) } })
}

export function handleMedia(getDb: () => DB, avatarsDir: string, extrasDir: () => string, ytThumbsDir?: string, longDir?: () => string, musicDir?: () => string, cityDir?: () => string, robloxDir?: () => string, curioDir?: () => string, gtaDir?: () => string, backgroundFile?: () => string | null, fabricaDir?: () => string): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    try {
      const url = new URL(req.url)
      if (url.hostname === 'fondo' && backgroundFile) {
        // fondo de pantalla elegido en Ajustes (una copia guardada en los datos de la app)
        const ruta = backgroundFile()
        const tipo = ruta?.endsWith('.png') ? 'image/png' : ruta?.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
        return ruta ? servir(ruta, tipo, null) : new Response(null, { status: 404 })
      }
      if (url.hostname === 'fabrica' && fabricaDir) {
        const [id, archivo] = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent)
        const ruta = resolveFabricaImage(fabricaDir(), id, archivo)
        return ruta ? servir(ruta, 'image/jpeg', null) : new Response(null, { status: 404 })
      }
      if (url.hostname === 'ytthumb' && ytThumbsDir) {
        // miniatura de YouTube: se descarga una vez (solo de i.ytimg.com) y se sirve desde disco
        const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
        if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return new Response(null, { status: 404 })
        const archivo = path.join(ytThumbsDir, id + '.jpg')
        if (!fs.existsSync(archivo)) {
          const r = await net.fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`).catch(() => null)
          if (!r || !r.ok) return new Response(null, { status: 404 })
          fs.mkdirSync(ytThumbsDir, { recursive: true })
          fs.writeFileSync(archivo, Buffer.from(await r.arrayBuffer()))
        }
        return servir(archivo, 'image/jpeg', null)
      }
      if (url.hostname === 'extra-thumb') {
        const ruta = resolveExtraThumb(extrasDir(), decodeURIComponent(url.pathname.replace(/^\//, '')))
        const tipo = ruta?.endsWith('.png') ? 'image/png' : ruta?.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
        return ruta ? servir(ruta, tipo, null) : new Response(null, { status: 404 })
      }
      const dirLargo = url.hostname.startsWith('music') ? musicDir : url.hostname.startsWith('city') ? cityDir : url.hostname.startsWith('roblox') ? robloxDir : url.hostname.startsWith('curio') ? curioDir : url.hostname.startsWith('gta') ? gtaDir : longDir
      if ((url.hostname === 'long' || url.hostname === 'music' || url.hostname === 'city' || url.hostname === 'roblox' || url.hostname === 'curio' || url.hostname === 'gta') && dirLargo) {
        const ruta = resolveLongVideo(dirLargo(), decodeURIComponent(url.pathname.replace(/^\//, '')))
        return ruta ? servir(ruta, 'video/mp4', req.headers.get('range')) : new Response(null, { status: 404 })
      }
      if ((url.hostname === 'long-thumb' || url.hostname === 'music-thumb' || url.hostname === 'city-thumb' || url.hostname === 'roblox-thumb' || url.hostname === 'curio-thumb' || url.hostname === 'gta-thumb') && dirLargo) {
        const [id, letra] = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent)
        const ruta = resolveLongThumb(dirLargo(), id, letra)
        const tipo = ruta?.endsWith('.png') ? 'image/png' : ruta?.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
        return ruta ? servir(ruta, tipo, null) : new Response(null, { status: 404 })
      }
      if (url.hostname === 'extra') {
        const id = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent).join('/')
        const ruta = resolveExtra(extrasDir(), id)
        return ruta ? servir(ruta, 'video/mp4', req.headers.get('range')) : new Response(null, { status: 404 })
      }
      const clipId = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (url.hostname === 'avatar') {
        // el nombre del archivo es el identificador del canal, comprobado: no se puede pedir otra ruta
        const archivo = isChannelId(clipId) ? path.join(avatarsDir, clipId) : null
        return archivo && fs.existsSync(archivo) ? servir(archivo, 'image/jpeg', null) : new Response(null, { status: 404 })
      }
      const rutas = clipPaths(getDb(), clipId)
      const ruta = url.hostname === 'clip' ? rutas?.video : url.hostname === 'thumb' ? rutas?.thumb : url.hostname === 'qa' ? rutas?.qaSheet : null
      if (!ruta || !fs.existsSync(ruta)) return new Response(null, { status: 404 })
      const tipo = url.hostname === 'clip' ? 'video/mp4' : url.hostname === 'qa' ? 'image/png' : 'image/jpeg'
      return servir(ruta, tipo, req.headers.get('range'))
    } catch {
      return new Response(null, { status: 500 })
    }
  })
}
