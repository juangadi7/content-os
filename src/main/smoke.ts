/**
 * Prueba de humo real (CONTENT_OS_SMOKE=<carpeta de salida>): maneja la ventana como lo haría
 * una persona —clics sobre la interfaz de verdad— y comprueba cada paso contra la base de datos.
 * Se lanza con una carpeta de datos temporal (CONTENT_OS_DATA_DIR) para no dejar publicaciones
 * de prueba en los datos reales. No abre el Explorador ni el reproductor de Windows.
 */
import { app, clipboard, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { CHANNELS } from '../core/api'
import type { DB } from '../core/db'
import { attachMaterial, getOrder } from '../core/orders'
import { filterClips, filterLibrary, sortClips } from '../core/format'
import { clipPaths, getClip, listClips } from '../core/queries'
import { syncVyro } from '../core/vyro'
import { listVyroPending } from '../core/vyro-pending'

type Row = Record<string, any>

export async function runSmokeTest(win: BrowserWindow, db: DB, salida: string, sincronizando: () => boolean): Promise<void> {
  const wc = win.webContents
  const pasos: { paso: string; ok: boolean; detalle?: unknown }[] = []
  const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const js = <T = unknown>(codigo: string) => wc.executeJavaScript(codigo, true) as Promise<T>
  const hasta = async (condicion: string, ms = 15000): Promise<boolean> => {
    for (const fin = Date.now() + ms; Date.now() < fin; ) {
      if (await js<boolean>(`!!(${condicion})`).catch(() => false)) return true
      await esperar(100)
    }
    return false
  }
  const clic = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const escribir = (selector: string, valor: string) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(valor)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const foto = async (nombre: string) => {
    // se fuerza un repintado y se descarta la primera captura: sin foco, Chromium puede devolver un fotograma viejo
    win.moveTop()
    await js('new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 500) })')
    wc.invalidate()
    await esperar(400)
    await wc.capturePage()
    await esperar(150)
    fs.writeFileSync(path.join(salida, nombre), (await wc.capturePage()).toPNG())
  }
  const paso = (nombre: string, ok: boolean, detalle?: unknown) => {
    pasos.push({ paso: nombre, ok, detalle })
    if (!ok) throw new Error(`falla: ${nombre}`)
  }

  fs.mkdirSync(salida, { recursive: true })
  const portapapelesPrevio = (await clipboard.readText())
  let error: string | null = null
  try {
    // 1. arrancar
    await new Promise<void>((r) => (wc.isLoading() ? wc.once('did-finish-load', () => r()) : r()))
    paso('1. la aplicación arranca', await hasta(`document.querySelector('.side') && window.contentOS`))
    paso('   aislamiento: React no ve Node ni ipcRenderer', (await js<string>(`[typeof window.require, typeof window.process, typeof window.ipcRenderer].join()`)) === 'undefined,undefined,undefined')
    // 16-nov-2026: abre en «Inicio», con la barra de arriba y el menú limpio (Mis canales, Otros, Ajustes; Vyro escondido)
    paso('1b. abre en «Inicio» con la barra de arriba y el menú de canales', await hasta(`document.querySelector('main').dataset.view === 'home' && document.querySelector('[data-test="top-import"]') && document.querySelector('[data-test="nav-gta"]') && document.querySelector('[data-test="nav-settings"]')`))
    paso('   Vyro, Calendario y Fin de semana no están en el menú', await js<boolean>(`!document.querySelector('[data-test="grp-vyro"]') && !document.querySelector('[data-test="nav-calendar"]') && !document.querySelector('[data-test="nav-weekend"]') && !document.querySelector('[data-test="home-channel-vyro"]')`))
    // canales en acordeón: abrir uno cierra el otro
    await clic('[data-test="grp-curio"]')
    paso('   canales en acordeón: abrir Curiosidades cierra GTA 6', await hasta(`!!document.querySelector('[data-test="nav-curio"]') && !document.querySelector('[data-test="nav-gta"]')`))
    await clic('[data-test="grp-gta"]')
    // Vyro se activa en Ajustes (el resto de la prueba lo usa)
    await clic('[data-test="top-settings"]')
    await hasta(`!!document.querySelector('[data-test="settings-show-vyro"]')`)
    await clic('[data-test="settings-show-vyro"]')
    paso('   al activar Vyro en Ajustes aparece en el menú', await hasta(`!!document.querySelector('[data-test="grp-vyro"]')`))
    for (const g of ['vyro', 'otros']) await js(`(() => { const b = document.querySelector('[data-test="grp-${g}"]'); if (b.getAttribute('aria-expanded') !== 'true') b.click() })()`)
    paso('   al abrir «Vyro» aparecen sus apartados', await hasta(`!!document.querySelector('[data-test="nav-campaigns"]') && !!document.querySelector('[data-test="nav-today"]')`))
    await clic('[data-test="nav-campaigns"]')

    // 2. cuatro campañas tras la sincronización automática de arranque
    paso('2. sincroniza al abrir', await hasta(`document.querySelector('[data-test="sync-status"]').textContent.startsWith('Sincronizado')`, 120000) && !sincronizando(),
      await js(`document.querySelector('[data-test="sync-status"]').textContent`))
    const nCamp = (db.prepare('SELECT COUNT(*) AS n FROM campaigns').get() as Row).n
    paso('   muestra todas las campañas', (await js<number>(`document.querySelectorAll('[data-test="campaign-card"]').length`)) === nCamp && nCamp >= 1, nCamp)
    await foto('1-campañas.png')

    // 3. abrir una campaña (la que tiene scores y portadas)
    const camp = db.prepare(
      `SELECT campaign_id FROM clips WHERE score IS NOT NULL AND thumb_path IS NOT NULL GROUP BY campaign_id ORDER BY COUNT(*) DESC LIMIT 1`
    ).get() as Row
    await clic(`[data-campaign="${camp.campaign_id}"]`)
    paso('3. abre una campaña', await hasta(`document.querySelector('main').dataset.view === 'campaign' && document.querySelectorAll('[data-test="clip-row"]').length > 0`))

    // 4. clips en el orden de calidad
    const esperados = listClips(db, camp.campaign_id)
    const enPantalla = await js<string[]>(`[...document.querySelectorAll('[data-test="clip-row"]')].map((r) => r.dataset.clip)`)
    paso('4. muestra los clips en el orden score DESC, QA DESC, clip_id', JSON.stringify(enPantalla) === JSON.stringify(esperados.map((k) => k.clipId)),
      esperados.map((k) => `${k.position}. ${k.score} / ${k.qaScore}`))
    const conPortada = (db.prepare('SELECT COUNT(*) AS n FROM clips WHERE campaign_id = ? AND thumb_path IS NOT NULL').get(camp.campaign_id) as Row).n
    paso('   carga las miniaturas existentes', await hasta(`[...document.querySelectorAll('[data-test="clip-row"] img.thumb')].filter((i) => i.complete && i.naturalWidth > 0).length === ${conPortada}`, 20000), conPortada)
    await foto('2-campaña.png')

    // 5. detalle del primer clip
    const clipId = esperados[0].clipId
    await clic(`[data-test="clip-row"][data-clip="${clipId}"]`)
    paso('5. abre el detalle del clip', await hasta(`document.querySelector('[data-test="clip-detail"]')?.dataset.clip === ${JSON.stringify(clipId)}`))
    const ficha = getClip(db, clipId)!

    // 6. reproducir dentro de la aplicación, y saltar hacia el final (peticiones por rangos)
    paso('   el vídeo carga', await hasta(`document.querySelector('[data-test="video"]')?.readyState >= 1`, 20000))
    await clic('[data-test="play"]')
    const reproduce = await hasta(`(() => { const v = document.querySelector('[data-test="video"]'); return !v.paused && v.currentTime > 0.6 })()`, 20000)
    const video = await js<Row>(`(() => { const v = document.querySelector('[data-test="video"]');
      return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, currentTime: v.currentTime, error: v.error && v.error.message } })()`)
    paso('6. reproduce el clip', reproduce && Math.abs(video.width - 1080) <= 4 && video.height === 1920 && Math.abs(video.duration - ficha.duration!) < 1, video)
    await js(`(() => { const v = document.querySelector('[data-test="video"]'); v.currentTime = v.duration - 3 })()`)
    paso('   salta al final y sigue reproduciendo', await hasta(`(() => { const v = document.querySelector('[data-test="video"]'); return !v.seeking && v.currentTime > v.duration - 3.2 && v.readyState >= 2 })()`, 20000))
    await js(`(() => { const v = document.querySelector('[data-test="video"]'); v.pause(); v.currentTime = Math.min(4, v.duration / 2) })()`)
    await hasta(`!document.querySelector('[data-test="video"]').seeking`)
    paso('   Ficha: reproductor vertical sin deformar, estado visible y detalles técnicos plegados', await js<boolean>(`(() => {
      const p = document.querySelector('.dv-player'), v = document.querySelector('[data-test="video"]')
      const proporcion = p.clientWidth / p.clientHeight
      return Math.abs(proporcion - 9 / 16) < 0.02 && getComputedStyle(v).objectFit === 'contain' && p.clientHeight >= 380 &&
        document.querySelector('[data-test="detail-chips"]').textContent.includes('Pendiente') &&
        document.querySelector('[data-test="clip-title"]').textContent.length > 0 && !document.querySelector('details.dv-more').open &&
        ['title', 'caption', 'hashtags'].every((b) => document.querySelector('.dv-copy [data-test="text-' + b + '"]'))
    })()`), await js(`[document.querySelector('.dv-player').clientWidth, document.querySelector('.dv-player').clientHeight, document.querySelector('[data-test="detail-chips"]').textContent]`))
    await foto('3-clip.png')

    // 7. copiar título, descripción y hashtags: lo copiado es exactamente lo de la ficha
    const meta = JSON.parse((db.prepare('SELECT metadata_json FROM clips WHERE clip_id = ?').get(clipId) as Row).metadata_json)
    await clic('[data-test="copy-title"]')
    paso('7. copia el título y avisa «Copiado»', (await hasta(`document.querySelector('[data-test="copied-title"]')`)) && (await clipboard.readText()) === meta.title, (await clipboard.readText()))
    await clic('[data-test="copy-caption"]')
    await hasta(`document.querySelector('[data-test="copied-caption"]')`)
    paso('   copia la descripción tal cual', (await clipboard.readText()) === meta.caption)
    if (meta.hashtags?.length) {
      await clic('[data-test="copy-hashtags"]')
      await hasta(`document.querySelector('[data-test="copied-hashtags"]')`)
      paso('   copia los hashtags', (await clipboard.readText()) === meta.hashtags.join(' '))
    } else {
      paso('   sin hashtags: el botón de copiar queda desactivado', await js<boolean>(`document.querySelector('[data-test="copy-hashtags"]').disabled`))
    }

    // 8. marcar publicado en TikTok
    await clic('[data-test="publish-tiktok"]')
    paso('8. abre la ventana de publicar', await hasta(`document.querySelector('[data-test="publish-modal"]')`))
    await escribir('[data-test="f-account"]', '@prueba_humo')
    await escribir('[data-test="f-url"]', 'https://www.tiktok.com/@prueba_humo/video/1')
    await escribir('[data-test="f-notes"]', 'Publicación creada por la prueba de humo')
    await clic('[data-test="save-publication"]')
    paso('   guarda y enseña «Publicado»', await hasta(`!document.querySelector('[data-test="publish-modal"]') && document.querySelector('[data-test="pub-tiktok"]').textContent.includes('Publicado ·')`))
    const pub = db.prepare("SELECT * FROM publications WHERE clip_id = ? AND platform = 'tiktok'").all(clipId) as Row[]
    const clipFila = db.prepare('SELECT sha256, file_sha256, title FROM clips WHERE clip_id = ?').get(clipId) as Row
    paso('   la publicación queda en la base con el hash del MP4', pub.length === 1 && pub[0].sha256_at_publish === clipFila.file_sha256 &&
      pub[0].sha256_at_publish === clipFila.sha256 && pub[0].account === '@prueba_humo' && pub[0].title_used === clipFila.title && pub[0].status === 'published',
      { sha256_at_publish: pub[0]?.sha256_at_publish, url: pub[0]?.url, published_at: pub[0]?.published_at })
    // repetir la misma cuenta no duplica
    await clic('[data-test="publish-tiktok"]')
    await hasta(`document.querySelector('[data-test="publish-modal"]')`)
    await escribir('[data-test="f-account"]', '@prueba_humo')
    await clic('[data-test="save-publication"]')
    const avisa = await hasta(`document.querySelector('[data-test="publish-error"]')?.textContent.includes('Ya hay una publicación')`)
    const tras = db.prepare('SELECT COUNT(*) AS n, MAX(url) AS url FROM publications').get() as Row
    paso('   repetir plataforma y cuenta no duplica ni pisa la existente', avisa && tras.n === 1 && tras.url === 'https://www.tiktok.com/@prueba_humo/video/1')
    await clic('[data-test="cancel-publication"]')
    await hasta(`!document.querySelector('[data-test="publish-modal"]')`)
    await js(`document.querySelector('[data-test="publications"]').scrollIntoView({ block: 'center' })`)
    paso('   Ficha: al publicarlo, la cabecera pasa a «Publicado» con el chip de la plataforma y su canal', JSON.stringify(await js<string[]>(`[...document.querySelectorAll('[data-test="detail-chips"] .chip-s')].map((c) => c.textContent)`)) === '["Publicado","TikTok · @prueba_humo"]')
    await foto('4-publicaciones.png')

    // 9. volver a la campaña
    await clic('[data-test="back"]')
    paso('9. vuelve a la campaña', await hasta(`document.querySelector('main').dataset.view === 'campaign' && document.querySelectorAll('[data-test="clip-row"]').length === ${esperados.length}`))
    paso('   la fila ya dice «Publicado · TikTok»', await hasta(`document.querySelector('[data-test="clip-row"][data-clip="${clipId}"] [data-test="pub-state"]').textContent.includes('TikTok')`))
    await foto('5-campaña-con-publicado.png')

    // material en bruto: se enseña lo que ocupa y la ventana de confirmación. La prueba CANCELA: no borra nada.
    // Se usa una campaña que aún tenga material (la biblioteca es la real: el usuario puede haber liberado el de esta).
    const conMaterial = (id: string) => {
      const dir = path.join((db.prepare('SELECT source_path FROM campaigns WHERE campaign_id = ?').get(id) as Row).source_path, 'SOURCE')
      try {
        return fs.readdirSync(dir).some((n) => fs.statSync(path.join(dir, n)).isFile() && fs.statSync(path.join(dir, n)).size > 1_000_000)
      } catch {
        return false
      }
    }
    const campBruto = conMaterial(camp.campaign_id) ? camp.campaign_id
      : (db.prepare("SELECT campaign_id FROM campaigns WHERE present_in_source = 1 AND state = 'ok'").all() as Row[]).map((r) => r.campaign_id as string).find(conMaterial)
    if (!campBruto) throw new Error('ninguna campaña de la biblioteca tiene material en bruto para probar')
    if (campBruto !== camp.campaign_id) {
      await clic('[data-test="nav-campaigns"]')
      await hasta(`!!document.querySelector('[data-campaign="${campBruto}"]')`)
      await clic(`[data-campaign="${campBruto}"]`)
      await hasta(`document.querySelector('main').dataset.view === 'campaign'`)
    }
    const fuente = path.join((db.prepare('SELECT source_path FROM campaigns WHERE campaign_id = ?').get(campBruto) as Row).source_path, 'SOURCE')
    const brutoAntes = fs.readdirSync(fuente).map((n) => n + ':' + fs.statSync(path.join(fuente, n)).size).join('|')
    paso('   Bruto: enseña cuánto ocupa el material original', await hasta(`document.querySelector('[data-test="raw-bar"]')?.textContent.match(/\\d+(,\\d+)? (MB|GB)/)`, 20000), await js(`document.querySelector('[data-test="raw-bar"]')?.textContent`))
    await clic('[data-test="raw-open"]')
    paso('   Bruto: pide confirmación y avisa de lo que se pierde', await hasta(`document.querySelector('[data-test="raw-modal"]')?.textContent.includes('regenerar') && document.querySelector('[data-test="raw-trash"]')`))
    await foto('11-material-en-bruto.png')
    await clic('[data-test="raw-close"]')
    await hasta(`!document.querySelector('[data-test="raw-modal"]')`)
    paso('   Bruto: al cancelar no se toca ningún archivo', fs.readdirSync(fuente).map((n) => n + ':' + fs.statSync(path.join(fuente, n)).size).join('|') === brutoAntes && brutoAntes.length > 0)
    if (campBruto !== camp.campaign_id) {
      await clic('[data-test="nav-campaigns"]')
      await hasta(`!!document.querySelector('[data-campaign="${camp.campaign_id}"]')`)
      await clic(`[data-campaign="${camp.campaign_id}"]`)
      await hasta(`document.querySelector('main').dataset.view === 'campaign' && document.querySelectorAll('[data-test="clip-row"]').length === ${esperados.length}`)
    }

    // cerrar una campaña: sus clips dejan de contar como pendientes y la tarjeta pasa al final; reabrir lo deshace
    const pendientesAntes = await js<string>(`document.querySelector('[data-test="nav-pending"] .n').textContent`)
    await escribir('[data-test="campaign-ends"]', '2031-01-15')
    paso('   Plazo: con fecha de fin enseña los días que quedan', await hasta(`document.querySelector('[data-test="campaign-status"]').textContent.includes('quedan')`))
    await clic('[data-test="close-campaign"]')
    paso('   Cerrar campaña: queda marcada como cerrada', await hasta(`document.querySelector('[data-test="campaign-status"]').textContent.includes('Campaña cerrada')`))
    const pendientesCerrada = await js<string>(`document.querySelector('[data-test="nav-pending"] .n').textContent`)
    paso('   Cerrar campaña: sus clips salen de pendientes', Number(pendientesCerrada) === Number(pendientesAntes) - (esperados.length - 1), [pendientesAntes, pendientesCerrada])
    await clic('[data-test="nav-campaigns"]')
    await hasta(`document.querySelectorAll('[data-test="campaign-card"]').length === ${nCamp}`)
    const tarjetas = await js<string[]>(`[...document.querySelectorAll('[data-test="campaign-card"]')].map((c) => c.dataset.campaign + ':' + c.dataset.closed)`)
    paso('   Cerrar campaña: la tarjeta pasa al final como «Cerrada»', tarjetas[nCamp - 1] === camp.campaign_id + ':1' && tarjetas.slice(0, nCamp - 1).every((t) => t.endsWith(':0')), tarjetas)
    await foto('10-campaña-cerrada.png')
    await clic(`[data-campaign="${camp.campaign_id}"]`)
    await hasta(`document.querySelector('[data-test="reopen-campaign"]')`)
    await clic('[data-test="reopen-campaign"]')
    paso('   Reabrir: vuelve a contar', await hasta(`document.querySelector('[data-test="nav-pending"] .n').textContent === '${pendientesAntes}' && document.querySelector('[data-test="close-campaign"]')`))
    // Papelera de la campaña: pide confirmación y «Cancelar» no borra nada (la prueba nunca confirma: lee la biblioteca real)
    await clic('[data-test="trash-campaign"]')
    const confirma = await hasta(`document.querySelector('[data-test="trash-campaign-confirm"]') && document.querySelector('[data-test="trash-campaign-bar"]').textContent.includes('¿Seguro?')`)
    await clic('[data-test="trash-campaign-cancel"]')
    paso('   Campaña: «Enviar a la Papelera…» pide confirmación y «Cancelar» no toca nada', confirma && await hasta(`!document.querySelector('[data-test="trash-campaign-confirm"]')`) && fs.existsSync(path.join((db.prepare('SELECT source_path FROM campaigns WHERE campaign_id = ?').get(camp.campaign_id) as Row).source_path, 'campaign.json')))

    // YouTube: sin clave guardada ofrece conectar, y una clave mal escrita se rechaza sin salir a la red
    await clic('[data-test="top-settings"]')
    await hasta(`!!document.querySelector('[data-test="nav-youtube"]')`)
    await clic('[data-test="nav-youtube"]')
    paso('   YouTube: ofrece conectar con una clave de API', await hasta(`document.querySelector('[data-test="youtube-modal"] [data-test="youtube-key"]')`))
    await escribir('[data-test="youtube-key"]', 'esto no es una clave')
    await clic('[data-test="youtube-save"]')
    paso('   YouTube: rechaza una clave mal formada', await hasta(`document.querySelector('[data-test="youtube-error"]')?.textContent.includes('no parece una clave')`))
    await foto('8-youtube.png')
    await clic('[data-test="youtube-close"]')
    await hasta(`!document.querySelector('[data-test="youtube-modal"]')`)

    // estadísticas: con mediciones de ejemplo metidas en esta base temporal, la pantalla las enseña y las suma
    const otros = db.prepare("SELECT clip_id, sha256 FROM clips WHERE campaign_id = ? AND clip_id <> ? ORDER BY clip_id LIMIT 2").all(camp.campaign_id, clipId) as Row[]
    const hace = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
    otros.forEach((o, i) => {
      const id = db.prepare("INSERT INTO publications (clip_id, platform, account, url, published_at, sha256_at_publish, created_at, updated_at) VALUES (?, 'youtube', '@prueba_humo', ?, ?, ?, ?, ?)")
        .run(o.clip_id, 'https://www.youtube.com/shorts/humo000000' + i, hace(30 + i * 20), o.sha256, hace(30), hace(30)).lastInsertRowid
      // mediciones de días anteriores, para que haya evolución que dibujar
      db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, origin) VALUES (?, ?, ?, ?, ?, 'prueba')").run(id, hace(76), 900 + i * 300, 6, 0)
      db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, origin) VALUES (?, ?, ?, ?, ?, 'prueba')").run(id, hace(52), 2600 + i * 500, 18, 1)
      db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, origin) VALUES (?, ?, ?, ?, ?, 'prueba')").run(id, hace(3), 4100 + i * 900, 30 + i, 2)
      db.prepare("INSERT INTO analytics_snapshots (publication_id, measured_at, views, likes, comments, origin) VALUES (?, ?, ?, ?, ?, 'prueba')").run(id, hace(0.1), 5180 + i * 1500, 37 + i * 4, 2 + i)
    })
    await clic('[data-test="nav-stats"]')
    paso('   Estadísticas: lista los vídeos publicados', await hasta(`document.querySelectorAll('[data-test="stats-row"]').length === 3`))
    const totalVisto = await js<string>(`document.querySelector('[data-test="stats-totals"] .tile .v').textContent`)
    paso('   Estadísticas: suma las visitas (5.180 + 6.680)', totalVisto === '11.860', totalVisto)
    const orden = await js<string[]>(`[...document.querySelectorAll('[data-test="stats-views"]')].map((e) => e.textContent)`)
    paso('   Estadísticas: ordena por visitas y marca lo que no se puede medir', JSON.stringify(orden) === JSON.stringify(['6.680', '5.180', 'sin medir']), orden)
    paso('   Estadísticas: dibuja la evolución con un punto por día medido', await hasta(`document.querySelectorAll('[data-test="chart-evolution"] circle').length >= 3`), await js(`document.querySelectorAll('[data-test="chart-evolution"] circle').length`))
    // en este punto la campaña aún no tiene condiciones de pago: el camino al cobro debe decirlo, no inventar barras
    paso('   Estadísticas: una tira por canal, y sin condiciones de pago lo dice en vez de dibujar', await js<boolean>(`document.querySelectorAll('[data-test="stats-account"]').length === 2 && document.querySelectorAll('[data-test="stats-goal"] .goal').length === 0 && !!document.querySelector('[data-test="stats-goal"] .nodata')`),
      await js(`[document.querySelectorAll('[data-test="stats-account"]').length, document.querySelectorAll('[data-test="stats-goal"] .goal').length]`))
    await foto('9-estadisticas.png')
    await js(`document.querySelector('[data-test="stats-videos"]').scrollIntoView({ block: 'end' })`)
    await foto('9b-estadisticas-tabla.png')
    await js(`document.querySelector('.main').scrollTo(0, 0)`)
    await clic('[data-test="stats-row"]')
    paso('   Estadísticas: un clic abre el clip', await hasta(`document.querySelector('main').dataset.view === 'clip' && document.querySelector('[data-test="metrics-youtube"]')`))
    await clic('[data-test="back"]')
    await hasta(`document.querySelector('main').dataset.view === 'stats'`)

    // vistas laterales
    await clic('[data-test="nav-published"]')
    paso('   «Publicados» lista las publicaciones', await hasta(`document.querySelectorAll('[data-test="published-row"]').length === 3`))

    // Publicados en cuadrícula: una tarjeta por CLIP con sus plataformas; en lista, una fila por PUBLICACIÓN
    const tarjeta = `[data-test="published-grid"] [data-test="published-row"][data-clip="${clipId}"]`
    paso('   Publicados: se abre en cuadrícula, con el chip de la plataforma y el canal en cada tarjeta', await js<boolean>(`!!document.querySelector('[data-test="published-grid"]')`) &&
      JSON.stringify(await js<string[]>(`[...document.querySelectorAll('${tarjeta} .chip-s.plat')].map((c) => c.textContent)`)) === '["TikTok · @prueba_humo"]' &&
      (await js<string>(`document.querySelector('[data-test="published-count"]').textContent`)) === '3 clips · 3 publicaciones')
    // el mismo clip se publica también en Instagram: sigue siendo UNA tarjeta, ahora con dos plataformas
    db.prepare("INSERT INTO publications (clip_id, platform, account, url, published_at, created_at, updated_at) VALUES (?, 'instagram', '@prueba_humo', 'https://www.instagram.com/reel/humo0001/', ?, ?, ?)").run(clipId, hace(1), hace(1), hace(1))
    win.webContents.send(CHANNELS.stateChanged, await js('window.contentOS.getState()'))
    paso('   Publicados: un clip en dos plataformas es una sola tarjeta con dos chips', await hasta(`document.querySelector('[data-test="published-count"]').textContent === '3 clips · 4 publicaciones'`) &&
      (await js<number>(`document.querySelectorAll('[data-test="published-grid"] [data-test="published-row"]').length`)) === 3 &&
      JSON.stringify(await js<string[]>(`[...document.querySelectorAll('${tarjeta} .chip-s.plat')].map((c) => c.textContent)`)) === '["Instagram · @prueba_humo","TikTok · @prueba_humo"]' &&
      (await js<string>(`document.querySelector('${tarjeta} .ccard-m').textContent`)).includes('2 publicaciones'),
      await js(`[...document.querySelectorAll('${tarjeta} .chip-s')].map((c) => c.textContent)`))
    await foto('18-publicados-cuadricula.png')
    await clic('[data-test="view-list"]')
    paso('   Publicados: la lista conserva una fila por publicación, con su cuenta y su URL', await hasta(`document.querySelectorAll('[data-test="published-rows"] [data-test="published-row"]').length === 4`) &&
      (await js<number>(`document.querySelectorAll('[data-test="published-rows"] [data-test="published-row"][data-clip="${clipId}"]').length`)) === 2 &&
      (await js<string>(`document.querySelector('[data-test="published-rows"]').textContent`)).includes('https://www.instagram.com/reel/humo0001/'))
    await foto('19-publicados-lista.png')
    await clic(`[data-test="published-rows"] [data-test="published-row"][data-clip="${clipId}"]`)
    paso('   Publicados: en el detalle siguen las dos publicaciones por separado, cada una con su cuenta', await hasta(`document.querySelector('[data-test="clip-detail"]')?.dataset.clip === ${JSON.stringify(clipId)} && document.querySelector('[data-test="pub-tiktok"]')`) &&
      (await js<boolean>(`['tiktok', 'instagram'].every((p) => { const t = document.querySelector('[data-test="pub-' + p + '"]').textContent; return t.includes('Publicado ·') && t.includes('@prueba_humo') }) && document.querySelector('[data-test="pub-youtube"]').textContent.includes('No publicado')`)))
    await clic('[data-test="back"]')
    await hasta(`document.querySelector('main').dataset.view === 'published'`)
    await clic('[data-test="view-grid"]')
    await hasta(`document.querySelectorAll('[data-test="published-grid"] [data-test="published-row"]').length === 3`)
    await foto('6-publicados.png')
    await clic('[data-test="nav-pending"]')
    const total = (db.prepare('SELECT COUNT(*) AS n FROM clips WHERE present_in_source = 1').get() as Row).n
    paso('   «Pendientes» lista el resto', await hasta(`document.querySelectorAll('[data-test="clip-row"]').length === ${total - 3}`), total - 3)

    // Pendientes en cuadrícula: tarjetas con portada, filtro por campaña, orden y cambio a lista
    const pend = filterClips(listClips(db, null), 'pending')
    paso('   Pendientes: se abre en cuadrícula, una tarjeta por clip y en el mismo orden de calidad', await js<boolean>(`!!document.querySelector('[data-test="clip-grid"]')`) &&
      JSON.stringify(await js<string[]>(`[...document.querySelectorAll('[data-test="clip-grid"] [data-test="clip-row"]')].map((c) => c.dataset.clip)`)) === JSON.stringify(pend.map((k) => k.clipId)))
    paso('   Pendientes: las tarjetas cargan su portada sin deformarla', await hasta(`(() => { const i = [...document.querySelectorAll('.ccard-img img')].filter((x) => x.complete && x.naturalWidth > 0); return i.length >= 4 && i.every((x) => getComputedStyle(x).objectFit === 'contain') })()`, 20000))
    await foto('16-pendientes-cuadricula.png')
    const camp2 = (db.prepare("SELECT campaign_id FROM clips WHERE campaign_id <> ? GROUP BY campaign_id ORDER BY COUNT(*) DESC LIMIT 1").get(camp.campaign_id) as Row).campaign_id as string
    const deCamp2 = pend.filter((k) => k.campaignId === camp2)
    await clic(`[data-test="pending-campaign"][data-campaign="${camp2}"]`)
    paso('   Pendientes: filtrar por campaña deja solo sus clips', await hasta(`document.querySelectorAll('[data-test="clip-row"]').length === ${deCamp2.length}`) && deCamp2.length > 0 &&
      (await js<string>(`document.querySelector('[data-test="list-count"]').textContent`)) === `${deCamp2.length} de ${pend.length} sin publicar`, deCamp2.length)
    await js(`(() => { const el = document.querySelector('[data-test="pending-sort"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'name'); el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    const porNombre = sortClips(deCamp2, 'name').map((k) => k.clipId)
    paso('   Pendientes: ordenar por nombre reordena las tarjetas', await hasta(`JSON.stringify([...document.querySelectorAll('[data-test="clip-row"]')].map((c) => c.dataset.clip)) === ${JSON.stringify(JSON.stringify(porNombre))}`))
    await clic('[data-test="view-list"]')
    paso('   Pendientes: la vista de lista enseña los mismos clips en tabla', await hasta(`!document.querySelector('[data-test="clip-grid"]') && !!document.querySelector('[data-test="clip-rows"] .row.hdr') && document.querySelectorAll('[data-test="clip-row"]').length === ${deCamp2.length}`))
    await foto('17-pendientes-lista.png')
    await clic('[data-test="view-grid"]')
    await clic('[data-test="pending-campaigns"] [data-campaign=""]')
    await js(`(() => { const el = document.querySelector('[data-test="pending-sort"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'score'); el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    const primero = pend[0].clipId
    await clic(`[data-test="clip-grid"] [data-clip="${primero}"]`)
    paso('   Pendientes: una tarjeta abre su clip y «volver» regresa a la cuadrícula', await hasta(`document.querySelector('[data-test="clip-detail"]')?.dataset.clip === ${JSON.stringify(primero)}`))
    await clic('[data-test="back"]')
    await hasta(`document.querySelector('main').dataset.view === 'pending' && document.querySelectorAll('[data-test="clip-row"]').length === ${pend.length}`)

    // Todos los clips: una tarjeta por clip (aunque esté en varias plataformas), con filtros de estado, plataforma y campaña
    await clic('[data-test="nav-all"]')
    const todosClips = listClips(db, null).filter((k) => !k.campaignClosed)
    paso('   Todos los clips: una tarjeta por clip, sin repetir ninguno', await hasta(`document.querySelectorAll('[data-test="clip-grid"] [data-test="clip-row"]').length === ${todosClips.length}`, 20000) &&
      (await js<boolean>(`(() => { const ids = [...document.querySelectorAll('[data-test="clip-row"]')].map((c) => c.dataset.clip); return new Set(ids).size === ids.length })()`)) &&
      (await js<string>(`document.querySelector('[data-test="list-count"]').textContent`)) === `${todosClips.length} clips`, todosClips.length)
    paso('   Todos los clips: el clip publicado en dos plataformas es una sola tarjeta con sus dos chips', (await js<number>(`document.querySelectorAll('[data-test="clip-row"][data-clip="${clipId}"]').length`)) === 1 &&
      JSON.stringify(await js<string[]>(`[...document.querySelectorAll('[data-test="clip-row"][data-clip="${clipId}"] .chip-s')].map((c) => c.textContent)`)) === '["Publicado","Instagram · @prueba_humo","TikTok · @prueba_humo"]')
    await foto('20-todos-cuadricula.png')
    const elegir = (sel: string, valor: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(valor)}); el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    const publicados = filterLibrary(todosClips, { state: 'published' })
    await elegir('[data-test="all-state"]', 'published')
    paso('   Todos los clips: el filtro de estado deja solo los publicados', await hasta(`document.querySelectorAll('[data-test="clip-row"]').length === ${publicados.length}`) && publicados.length >= 3 &&
      (await js<string>(`document.querySelector('[data-test="list-count"]').textContent`)) === `${publicados.length} de ${todosClips.length} clips`, publicados.length)
    const enInstagram = filterLibrary(todosClips, { state: 'published', platform: 'instagram' })
    await elegir('[data-test="all-platform"]', 'instagram')
    paso('   Todos los clips: el filtro de plataforma se combina con el de estado', await hasta(`document.querySelectorAll('[data-test="clip-row"]').length === ${enInstagram.length}`) && enInstagram.length === 1 &&
      (await js<string>(`document.querySelector('[data-test="clip-row"]').dataset.clip`)) === clipId)
    await elegir('[data-test="all-state"]', 'pending')
    paso('   Todos los clips: una combinación sin resultados lo dice y ofrece quitar los filtros', await hasta(`!!document.querySelector('[data-test="empty-search"]')`))
    await clic('[data-test="empty-search"] .btn')
    paso('   Todos los clips: «Quitar filtros» vuelve a enseñarlos todos', await hasta(`document.querySelectorAll('[data-test="clip-row"]').length === ${todosClips.length}`))
    await clic('[data-test="view-list"]')
    paso('   Todos los clips: la vista de lista enseña los mismos clips en tabla', await hasta(`!document.querySelector('[data-test="clip-grid"]') && document.querySelectorAll('[data-test="clip-rows"] [data-test="clip-row"]').length === ${todosClips.length}`))
    await clic('[data-test="view-grid"]')
    await clic(`[data-test="clip-grid"] [data-clip="${clipId}"]`)
    paso('   Todos los clips: una tarjeta abre su ficha y «volver» regresa', await hasta(`document.querySelector('[data-test="clip-detail"]')?.dataset.clip === ${JSON.stringify(clipId)}`))
    await clic('[data-test="back"]')
    await hasta(`document.querySelector('main').dataset.view === 'all' && document.querySelectorAll('[data-test="clip-row"]').length === ${todosClips.length}`)

    // un clip sin score dice «Sin score» (nunca 0) y uno sin portada enseña el hueco
    const sinScore = db.prepare('SELECT campaign_id FROM clips WHERE score IS NULL LIMIT 1').get() as Row | undefined
    if (sinScore) {
      await clic('[data-test="nav-campaigns"]')
      await hasta(`document.querySelector('[data-campaign="${sinScore.campaign_id}"]')`)
      await clic(`[data-campaign="${sinScore.campaign_id}"]`)
      await hasta(`document.querySelectorAll('[data-test="clip-row"]').length > 0`)
      const scores = await js<string[]>(`[...document.querySelectorAll('[data-test="row-score"]')].map((e) => e.textContent)`)
      // la campaña puede mezclar clips con y sin score: cada clip sin score dice «Sin score» y ninguno sale como 0
      const sinNota = (db.prepare("SELECT COUNT(*) AS n FROM clips WHERE campaign_id = ? AND score IS NULL AND present_in_source = 1").get(sinScore.campaign_id) as Row).n
      paso('   los clips sin score dicen «Sin score»', scores.length > 0 && scores.filter((s) => s === 'Sin score').length >= Math.min(sinNota, scores.length) && !scores.includes('0'), { scores, sinNota })
      await foto('7-campaña-sin-score.png')
    }
    const sinPortada = db.prepare('SELECT campaign_id FROM clips WHERE thumb_path IS NULL LIMIT 1').get() as Row | undefined
    if (sinPortada) {
      await clic('[data-test="nav-campaigns"]')
      await hasta(`document.querySelector('[data-campaign="${sinPortada.campaign_id}"]')`)
      await clic(`[data-campaign="${sinPortada.campaign_id}"]`)
      paso('   los clips sin portada enseñan un hueco limpio', await hasta(`document.querySelectorAll('[data-test="thumb-placeholder"]').length > 0`))
    }

    // plan de hoy: el canal usado antes ya está, se añade otro y se marca un clip como subido desde el plan
    await clic('[data-test="nav-today"]')
    paso('   Hoy: el canal usado al publicar entra solo, con lo ya subido hoy', await hasta(`document.querySelector('[data-test="today-account"][data-account="@prueba_humo"] [data-test="today-progress"]')?.textContent.startsWith('1 de 3')`),
      await js(`document.querySelector('main').textContent.slice(0, 300)`))
    await clic('[data-test="accounts-open"]')
    await hasta(`document.querySelector('[data-test="accounts-modal"]')`)
    await escribir('[data-test="acc-name"]', '@canal_humo')
    await escribir('[data-test="acc-limit"]', '2')
    await hasta(`!document.querySelector('[data-test="acc-add"]').disabled`)
    await clic('[data-test="acc-add"]')
    paso('   Hoy: añade un canal de YouTube', await hasta(`document.querySelectorAll('[data-test="account-row"]').length === 2`))
    await clic('[data-test="acc-close"]')
    const filaHoy = `[data-test="today-account"][data-account="@canal_humo"]`
    paso('   Hoy: le propone tantos clips como su tope diario', await hasta(`document.querySelectorAll('${filaHoy} [data-test="today-row"]').length === 2`))
    const propuesto = await js<string>(`document.querySelector('${filaHoy} [data-test="today-row"]').dataset.clip`)
    const yaEnYouTube = (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE clip_id = ? AND platform = 'youtube'").get(propuesto) as Row).n
    await clic(`${filaHoy} [data-test="today-mark"]`)
    paso('   Hoy: «Marcar subido» lo apunta en ese canal y descuenta el cupo', yaEnYouTube === 0 &&
      await hasta(`document.querySelector('${filaHoy} [data-test="today-progress"]').textContent.startsWith('1 de 2') && document.querySelectorAll('${filaHoy} [data-test="today-row"]').length === 1`) &&
      (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE clip_id = ? AND platform = 'youtube' AND account = '@canal_humo'").get(propuesto) as Row).n === 1, propuesto)
    paso('   Hoy: cada canal lleva su imagen o, si no la hay, su inicial', await js<boolean>(`(() => { const t = [...document.querySelectorAll('[data-test="today-account"]')]; return t.length >= 2 && t.every((c) => c.querySelectorAll('[data-test="today-avatar"]').length === 1) && document.querySelector('${filaHoy} [data-test="today-avatar"]').textContent === 'C' })()`))
    paso('   Hoy: cada clip propuesto tiene «Ver vídeo» y «Marcar subido», y las notas van plegadas', await js<boolean>(`(() => { const r = document.querySelector('${filaHoy} [data-test="today-row"]'); return r.querySelector('[data-test="today-view"]').textContent.includes('Ver vídeo') && r.querySelector('[data-test="today-mark"]').textContent.includes('Marcar subido') && [...document.querySelectorAll('details')].every((d) => !d.open) })()`))
    await foto('12-hoy.png')
    const aVer = await js<string>(`document.querySelector('${filaHoy} [data-test="today-row"]').dataset.clip`)
    await clic(`${filaHoy} [data-test="today-view"]`)
    paso('   Hoy: «Ver vídeo» abre ese clip', await hasta(`document.querySelector('[data-test="clip-detail"]')?.dataset.clip === ${JSON.stringify(aVer)}`))
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    paso('   Hoy: al volver sigue el plan como estaba', await hasta(`document.querySelector('main').dataset.view === 'today' && document.querySelectorAll('${filaHoy} [data-test="today-row"]').length === 1`))

    // Vyro: sin salir a la red, con dos lecturas de ejemplo (la segunda trae una campaña nueva)
    const nombreLocal = (db.prepare('SELECT COALESCE(display_name, folder_name) AS n FROM campaigns WHERE campaign_id = ?').get(camp.campaign_id) as Row).n as string
    const ejemplo = (n: number, brand: string, name: string) => ({
      vyroId: 'humo' + n, slug: 'humo-' + n, brand, name, payRate: 1.5, budgetTotal: 4000, budgetRemaining: 3100, minViews: 5000, minLength: 30,
      platforms: ['youtube', 'tiktok'], languages: ['en'], hashtags: ['#humo'], disclosure: ['#ad'], materialLinks: [], status: 'active', locked: false,
      startsAt: new Date(Date.now() - n * 3600_000).toISOString(), endsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), createdAt: null
    })
    syncVyro(db, [ejemplo(2, '', nombreLocal)])
    syncVyro(db, [ejemplo(2, '', nombreLocal), ejemplo(1, 'Marca de humo', 'Campaña recién salida')])
    win.webContents.send(CHANNELS.stateChanged, await js('window.contentOS.getState()')) // como hace la comprobación periódica
    paso('   Vyro: el menú avisa de la campaña nueva', await hasta(`document.querySelector('[data-test="vyro-badge"]')?.textContent.trim() === '1'`))
    await clic('[data-test="nav-vyro"]')
    paso('   Vyro: enseña las campañas, la nueva marcada y sin hacer', await hasta(`document.querySelectorAll('[data-test="vyro-card"]').length === 2 && document.querySelector('[data-slug="humo-1"][data-new="1"] [data-test="vyro-todo"]')`))
    paso('   Vyro: enlaza sola la que ya tienes y le pone el plazo', (await js<string>(`document.querySelector('[data-slug="humo-2"] [data-test="vyro-link"]').value`)) === camp.campaign_id &&
      !!(db.prepare('SELECT ends_at FROM campaigns WHERE campaign_id = ?').get(camp.campaign_id) as Row).ends_at,
      { enlazada: await js(`document.querySelector('[data-slug="humo-2"] [data-test="vyro-link"]')?.value ?? null`), esperada: camp.campaign_id, nombre: nombreLocal, enBase: db.prepare("SELECT campaign_id, link_state FROM vyro_campaigns WHERE vyro_id = 'humo2'").get() })
    paso('   Vyro: al verla deja de contar como nueva', await hasta(`!document.querySelector('[data-test="vyro-badge"]')`))
    paso('   Vyro: arriba, «Tus envíos en Vyro» con su botón para conectar la cuenta (o el resumen si ya está conectada)',
      await hasta(`(() => { const b = document.querySelector('[data-test="vyro-account"]'); return !!b && (b.dataset.connected === '1' ? !!document.querySelector('[data-test="vyro-sync"]') : !!document.querySelector('[data-test="vyro-connect"]')) })()`))
    await foto('13-vyro.png')

    // «Hacer esta campaña»: pedido con notas, material detectado en una carpeta de descargas de prueba, encargo copiado
    await clic('[data-slug="humo-1"] [data-test="vyro-make"]')
    await hasta(`document.querySelector('[data-test="order-modal"]')`)
    await escribir('[data-test="order-notes"]', 'Descripción obligatoria: frase de la marca. Tope 500 $ por vídeo.')
    await clic('[data-test="order-create"]')
    paso('   Pedido: se crea y queda esperando material', await hasta(`document.querySelector('[data-test="order-status"]')?.textContent.includes('Esperando material')`))
    const pedido = getOrder(db, 'humo1')!
    const dentroDeDatos = path.resolve(pedido.file).startsWith(path.resolve(app.getPath('userData'), '..'))
    paso('   Pedido: escribe pedido.json con las reglas y las notas, fuera de la biblioteca', dentroDeDatos && JSON.parse(fs.readFileSync(pedido.file, 'utf8')).reglas_extra_del_usuario.includes('Tope 500'), pedido.file)
    const descargas = path.join(path.dirname(pedido.folder), '_descargas_de_prueba')
    fs.mkdirSync(descargas, { recursive: true })
    fs.writeFileSync(path.join(descargas, 'Episodio de prueba.mp4'), Buffer.alloc(3 * 1024 * 1024))
    attachMaterial(db, descargas)
    win.webContents.send(CHANNELS.stateChanged, await js('window.contentOS.getState()'))
    paso('   Pedido: apunta solo el vídeo descargado', await hasta(`document.querySelectorAll('[data-test="order-file"]').length === 1 && document.querySelector('[data-test="order-file"]').textContent.includes('3 MB')`))
    await clic('[data-test="order-ready"]')
    await hasta(`document.querySelector('[data-test="order-status"]').textContent.includes('Material completo')`)
    await clic('[data-test="order-copy"]')
    paso('   Pedido: copia el encargo para Claude', (await hasta(`document.querySelector('[data-test="order-copied"]')`)) && (await clipboard.readText()) === getOrder(db, 'humo1')!.prompt, await clipboard.readText())
    await foto('14-pedido.png')
    await clic('[data-test="order-close"]')
    paso('   Pedido: la tarjeta lo enseña como listo', await hasta(`document.querySelector('[data-slug="humo-1"] [data-test="vyro-order"]')?.textContent.includes('Pedido listo')`))

    // ganancia estimada: la campaña enlazada recibió de Vyro 1,50 $ por 1.000 visitas y un mínimo de 5.000
    await clic('[data-test="nav-stats"]')
    paso('   Ganancia: suma lo estimado de los vídeos medidos (7,77 + 10,02)', await hasta(`document.querySelector('[data-test="stats-earning"] .v')?.textContent === '17,79 $'`), await js(`document.querySelector('[data-test="stats-earning"]')?.textContent`))
    paso('   Ganancia: con condiciones de pago, el camino al cobro enseña los dos vídeos que cobran', await js<boolean>(`document.querySelectorAll('[data-test="stats-goal"] .goal').length === 2 && document.querySelectorAll('[data-test="stats-goal"] .goal-bar.done').length === 2`),
      await js(`[...document.querySelectorAll('[data-test="stats-goal"] .goal-v')].map((e) => e.textContent)`))
    await foto('15-ganancia.png')
    await clic('[data-test="nav-campaigns"]')
    await hasta(`document.querySelector('[data-campaign="${camp.campaign_id}"]')`)
    await clic(`[data-campaign="${camp.campaign_id}"]`)
    paso('   Ganancia: la campaña enseña sus condiciones de pago', await hasta(`document.querySelector('[data-test="terms-bar"]')?.textContent.includes('1,50 $ por 1.000 visitas · mínimo 5.000 visitas')`), await js(`document.querySelector('[data-test="terms-bar"]')?.textContent`))

    // canales: un canal de ejemplo en esta base temporal, con vídeos emparejados y sin emparejar
    await clic('[data-test="nav-channels"]')
    paso('   Canales: sin canales lo dice y ofrece conectar YouTube', await hasta(`document.querySelector('[data-test="channels-empty"]')?.textContent.includes('YouTube no está conectado')`))
    const CANAL = 'UC' + 'h'.repeat(22)
    db.prepare("INSERT INTO youtube_channels (channel_id, handle, title, uploads_playlist, added_at, last_scan_at, subscribers, total_views, video_count, stats_at) VALUES (?, '@canal_humo', 'Canal de humo', 'UUhumo', ?, ?, 48, 9000, 8, ?)").run(CANAL, hace(500), hace(0.1), hace(0.1))
    const pubHumo = db.prepare("SELECT id FROM publications WHERE url = 'https://www.youtube.com/shorts/humo0000000'").get() as Row
    const cifras = [5200, 900, 1400, 640, 3, 0, 4, 2]
    cifras.forEach((views, i) => {
      const id = 'humocanal0' + i
      db.prepare("INSERT INTO youtube_videos (video_id, channel_id, title, published_at, duration_seconds, publication_id, match_state, views, likes, comments, stats_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 31, ?, ?, ?, ?, 0, ?, ?, ?)")
        .run(id, CANAL, 'Vídeo de humo ' + (i + 1), hace(400 - i * 30), i === 0 ? pubHumo.id : null, i === 0 ? 'manual' : 'unmatched', views, Math.round(views / 20), hace(0.1), hace(400), hace(0.1))
      db.prepare('INSERT INTO youtube_video_snapshots (video_id, measured_at, views, likes, comments) VALUES (?, ?, ?, 0, 0)').run(id, hace(26), Math.round(views * 0.9))
      db.prepare('INSERT INTO youtube_video_snapshots (video_id, measured_at, views, likes, comments) VALUES (?, ?, ?, 0, 0)').run(id, hace(0.1), views)
    })
    await clic('[data-test="nav-stats"]')
    await clic('[data-test="nav-channels"]')
    paso('   Canales: lista todos los vídeos del canal, del más reciente al más antiguo', await hasta(`document.querySelectorAll('[data-test="channel-row"]').length === 8`) &&
      JSON.stringify(await js<string[]>(`[...document.querySelectorAll('[data-test="channel-row"]')].map((r) => r.dataset.video)`)) === JSON.stringify(cifras.map((_, i) => 'humocanal0' + (7 - i))),
      await js(`[...document.querySelectorAll('[data-test="channel-row"]')].map((r) => r.dataset.video)`))
    paso('   Canales: suma las visitas y enseña suscriptores y una barra por vídeo', (await js<string>(`document.querySelector('[data-test="channel-views"] .v').textContent`)) === '8.149' &&
      (await js<string>(`document.querySelector('[data-test="channel-kpis"] .tile .v').textContent`)) === '48' && (await js<number>(`document.querySelectorAll('[data-test="channel-strip"] rect').length`)) === 8,
      await js(`document.querySelector('[data-test="channel-kpis"]').textContent`))
    paso('   Canales: el estudio no aparece hasta que se pide', await js<boolean>(`!document.querySelector('[data-test="study-verdict"]')`))
    await foto('14-canales.png')
    await clic('[data-test="study-channel"]')
    paso('   Estudiar canal: da el veredicto, los hallazgos y los siguientes pasos', await hasta(`document.querySelector('[data-test="study-verdict"]')?.dataset.level === 'frenado'`) &&
      (await js<boolean>(`document.querySelectorAll('[data-test="study-finding"]').length >= 2 && document.querySelectorAll('[data-test="study-steps"] li').length >= 2 && document.querySelector('[data-test="study-findings"]').textContent.includes('4 de 8 vídeos')`)),
      await js(`document.querySelector('[data-test="study-verdict"]')?.textContent`))
    paso('   Estudiar canal: marca en la lista los mejores y los peores', await js<boolean>(`document.querySelector('[data-video="humocanal00"]').textContent.includes('de los mejores') && document.querySelector('[data-video="humocanal05"]').textContent.includes('de los peores')`))
    await clic('[data-test="study-copy"]')
    paso('   Estudiar canal: copia el estudio en texto', (await hasta(`document.querySelector('[data-test="study-copy"]').textContent.includes('Copiado')`)) && (await clipboard.readText()).startsWith('ESTUDIO DEL CANAL @canal_humo'), (await clipboard.readText()).slice(0, 60))
    await foto('15-canales-estudio.png')
    await clic('[data-video="humocanal00"]')
    paso('   Canales: un vídeo emparejado abre su clip', await hasta(`document.querySelector('main').dataset.view === 'clip'`))

    // canales personales: un apartado aparte, que no se mezcla con los clips
    await clic('[data-test="nav-personal"]')
    paso('   Canales personales: vacío, lo explica y pide conectar YouTube', await hasta(`document.querySelector('main').dataset.view === 'personal' && document.querySelector('[data-test="personal-empty"]')?.textContent.includes('no tenga que ver con los clips')`))
    const MIO = 'UC' + 'p'.repeat(22)
    const dia = (d: number, h: number) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, 0, 0, 0); return x.toISOString() }
    db.prepare("INSERT INTO youtube_channels (channel_id, handle, title, uploads_playlist, added_at, last_scan_at, subscribers, total_views, video_count, stats_at, kind) VALUES (?, '@mi_canal_humo', 'Mi canal', 'UUmio', ?, ?, 1230, 256000, 2, ?, 'personal')").run(MIO, dia(5, 10), hace(0.1), hace(0.1))
    for (const [d, h, vistas, subs] of [[3, 10, 250000, 1200], [2, 9, 251500, 1210], [2, 21, 252200, 1210], [0, 8, 256000, 1230]] as const) {
      db.prepare('INSERT INTO youtube_channel_snapshots (channel_id, measured_at, subscribers, total_views, video_count) VALUES (?, ?, ?, ?, 2)').run(MIO, dia(d, h), subs, vistas)
    }
    ;[['humopropio1', 'Mi viaje de humo', dia(2, 12), 3000], ['humopropio2', 'Un vídeo antiguo', dia(40, 12), 80000]].forEach(([id, titulo, publicado, vistas]) => {
      db.prepare("INSERT INTO youtube_videos (video_id, channel_id, title, published_at, duration_seconds, match_state, views, likes, comments, stats_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 600, 'unmatched', ?, 40, 3, ?, ?, ?)")
        .run(id, MIO, titulo, publicado, vistas, hace(0.1), dia(5, 10), hace(0.1))
      db.prepare('INSERT INTO youtube_video_snapshots (video_id, measured_at, views, likes, comments) VALUES (?, ?, ?, 40, 3)').run(id, hace(26), Math.round(Number(vistas) * 0.95))
      db.prepare('INSERT INTO youtube_video_snapshots (video_id, measured_at, views, likes, comments) VALUES (?, ?, ?, 40, 3)').run(id, hace(0.1), vistas)
    })
    await clic('[data-test="nav-stats"]')
    paso('   Canales personales: sus vídeos no aparecen como «sin emparejar» en Estadísticas', await hasta(`document.querySelector('main').dataset.view === 'stats'`) &&
      !(await js<string>(`document.querySelector('main').textContent`)).includes('Mi viaje de humo'))
    await clic('[data-test="nav-channels"]')
    paso('   Canales personales: tampoco salen en «Canales», que sigue con el de clips', await hasta(`document.querySelectorAll('[data-test="channel-row"]').length === 8`) &&
      !(await js<string>(`document.querySelector('main').textContent`)).includes('mi_canal_humo'))
    await clic('[data-test="nav-personal"]')
    paso('   Canales personales: enseña el total del canal y sus vídeos, del más reciente al más antiguo', await hasta(`document.querySelectorAll('[data-test="personal-row"]').length === 2`) &&
      (await js<string>(`document.querySelector('[data-test="personal-total"]').textContent`)) === '256.000' &&
      JSON.stringify(await js<string[]>(`[...document.querySelectorAll('[data-test="personal-row"]')].map((r) => r.dataset.video)`)) === '["humopropio1","humopropio2"]',
      await js(`document.querySelector('[data-test="personal-kpis"]').textContent`))
    const ganado = await js<string[]>(`[...document.querySelectorAll('[data-test="personal-day-gain"]')].map((e) => e.textContent)`)
    paso('   Canales personales: día a día, con lo ganado cada día medido y sin inventar los que faltan', JSON.stringify(ganado) === '["+3.800","+2.200","—"]' &&
      (await js<number>(`document.querySelectorAll('[data-test="personal-daybars"] rect').length`)) === 3 &&
      (await js<string>(`document.querySelector('[data-test="personal-day"]').textContent`)).includes('2 días'), ganado)
    // los datos de ejemplo se han metido directamente en la base: se pregunta el estado, que es de donde el menú saca sus cuentas
    paso('   Canales personales: el estado los cuenta aparte de los canales de clips', await js<boolean>(`window.contentOS.getState().then((e) => e.personalChannels.length === 1 && e.personalChannels[0].kind === 'personal' && e.youtubeChannels.length === 1 && e.youtubeChannels[0].kind === 'clips')`))
    await foto('16-canales-personales.png')
    await clic('[data-test="personal-remove"]')
    paso('   Canales personales: quitar un canal pide confirmación', await hasta(`document.querySelector('[data-test="personal-remove-confirm"]')?.textContent.includes('@mi_canal_humo')`))

    // fuera de campaña: vídeos sin campaña, leídos de su carpeta (aquí, dentro de los datos temporales)
    await clic('[data-test="nav-extras"]')
    paso('Fuera de campaña: vacío, explica dónde van los vídeos', await hasta(`document.querySelector('main').dataset.view === 'extras' && document.querySelector('[data-test="extras-empty"]')?.textContent.includes('fuera-de-campana')`))
    const origen = (db.prepare('SELECT clip_id FROM clips WHERE resolved_path IS NOT NULL').all() as Row[]).map((k) => clipPaths(db, k.clip_id)?.video).find((v): v is string => !!v && fs.existsSync(v))!
    const grupo = path.join((await js<{ dataDir: string }>('window.contentOS.getState()')).dataDir, 'fuera-de-campana', 'Prueba humo')
    fs.mkdirSync(grupo, { recursive: true })
    fs.copyFileSync(origen, path.join(grupo, '1_demo.mp4'))
    fs.writeFileSync(path.join(grupo, '1_demo.json'), JSON.stringify({ title: 'Vídeo de prueba sin campaña', description: 'Hecho fuera de campaña.', hashtags: ['prueba'] }))
    const portada = (db.prepare('SELECT clip_id FROM clips WHERE thumb_path IS NOT NULL').all() as Row[]).map((k) => clipPaths(db, k.clip_id)?.thumb).find((v): v is string => !!v && fs.existsSync(v))!
    fs.copyFileSync(portada, path.join(grupo, 'miniatura.jpg'))
    fs.writeFileSync(path.join(grupo, 'grupo.json'), JSON.stringify({ name: 'Vídeo original de prueba', source_channel: 'Canal humo' }))
    const tamOrigen = fs.statSync(path.join(grupo, '1_demo.mp4')).size
    await clic('[data-test="nav-campaigns"]')
    await clic('[data-test="nav-extras"]')
    paso('   Fuera de campaña: una tarjeta por vídeo original, con su nombre y su miniatura, como en Campañas', await hasta(`document.querySelectorAll('[data-test="extras-group-card"]').length === 1 && document.querySelector('[data-test="extras-group-card"] img')?.naturalWidth > 0`) &&
      (await js<string>(`document.querySelector('[data-test="extras-group-card"] h3').textContent`)) === 'Vídeo original de prueba' &&
      (await js<number>(`document.querySelectorAll('[data-test="extra-video"]').length`)) === 0)
    await foto('18-fuera-de-campana-portada.png')
    await clic('[data-test="extras-group-card"]')
    paso('   Fuera de campaña: enseña el vídeo con su título y lo reproduce desde su carpeta', await hasta(`document.querySelectorAll('[data-test="extra-video"]').length === 1 && document.querySelector('[data-test="extra-video"] video').readyState >= 1`) &&
      (await js<string>(`document.querySelector('[data-test="extra-video"] h3').textContent`)) === 'Vídeo de prueba sin campaña',
      await js(`document.querySelector('[data-test="extra-video"] video')?.error?.message ?? null`))
    await clic('[data-test="extra-mark"][data-platform="youtube"]')
    paso('   Fuera de campaña: marcar como subido a YouTube se guarda y no toca el vídeo', await hasta(`document.querySelector('[data-test="extra-mark"][data-platform="youtube"]').getAttribute('aria-pressed') === 'true'`) &&
      (db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'extra_upload:Prueba humo/1_demo.mp4'").get() as Row).n === 1 &&
      fs.statSync(path.join(grupo, '1_demo.mp4')).size === tamOrigen)
    paso('   Fuera de campaña: el menú lo cuenta', await hasta(`document.querySelector('[data-test="nav-extras"] .n')?.textContent === '1'`) || (await js<number>('window.contentOS.getState().then((e) => e.extrasCount)')) === 1)
    paso('   Fuera de campaña: no se puede pedir un archivo de fuera de su carpeta', (await js<number>(`fetch('cos://extra/..%2F..%2Fcontent-os.db').then((r) => r.status).catch(() => -1)`)) !== 200 &&
      (await js<number>(`fetch('cos://extra/Prueba%20humo/1_demo.json').then((r) => r.status).catch(() => -1)`)) !== 200)
    paso('   Fuera de campaña: dentro, el nombre del vídeo arriba y vuelta atrás', (await js<string>(`document.querySelector('[data-test="extras-group-title"]').textContent`)) === 'Vídeo original de prueba')
    await foto('17-fuera-de-campana.png')
    await clic('[data-test="extras-back"]')
    await hasta(`document.querySelector('[data-test="extras-group-card"]')`)
    await clic('[data-test="extras-trash-all"]')
    paso('   Fuera de campaña: «Eliminar todo» pide confirmación y no borra nada todavía', await hasta(`document.querySelector('[data-test="extras-trash-confirm"]')?.textContent.includes('Papelera')`) &&
      fs.existsSync(path.join(grupo, '1_demo.mp4')))
    await clic('[data-test="extras-trash-yes"]')
    paso('   Fuera de campaña: al confirmar se va el grupo entero y sus marcas', await hasta(`document.querySelector('[data-test="extras-empty"]')`) &&
      !fs.existsSync(grupo) && (db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'extra_upload:%'").get() as Row).n === 0)

    // vídeos largos: canales propios, cada vídeo con 3 miniaturas y 3 títulos (A, B, C)
    await clic('[data-test="nav-long"]')
    paso('Vídeos largos: vacío, explica dónde van los vídeos', await hasta(`document.querySelector('main').dataset.view === 'long' && document.querySelector('[data-test="long-empty"]')?.textContent.includes('videos-largos')`))
    const largo = path.join((await js<{ dataDir: string }>('window.contentOS.getState()')).dataDir, 'videos-largos', '01 · Prueba')
    fs.mkdirSync(largo, { recursive: true })
    fs.copyFileSync(origen, path.join(largo, 'largo.mp4'))
    for (const l of ['A', 'B', 'C']) fs.copyFileSync(portada, path.join(largo, `miniatura_${l}.jpg`))
    fs.writeFileSync(path.join(largo, 'video.json'), JSON.stringify({
      channel: 'Canal humo', titles: ['Título A de prueba', 'Título B de prueba', 'Título C de prueba'], description: 'Descripción larga.',
      hashtags: ['prueba'], pinned_comment: '¿A, B o C?', schedule: 'Martes a las 20:00', file: 'largo.mp4'
    }))
    const tamLargo = fs.statSync(path.join(largo, 'largo.mp4')).size
    await clic('[data-test="nav-campaigns"]')
    await clic('[data-test="nav-long"]')
    paso('   Vídeos largos: el vídeo con sus 3 miniaturas y sus 3 títulos en orden A, B, C', await hasta(`document.querySelectorAll('[data-test="long-video"]').length === 1 && [...document.querySelectorAll('[data-test="long-thumbs"] img')].filter((i) => i.naturalWidth > 0).length === 3`) &&
      (await js<string>(`[...document.querySelectorAll('[data-test="long-titles"] li')].map((li) => li.dataset.letter + ':' + li.querySelector('.ltext').firstChild.textContent).join('|')`)) === 'A:Título A de prueba|B:Título B de prueba|C:Título C de prueba' &&
      (await js<string>(`document.querySelector('[data-test="long-schedule"]').textContent`)).includes('Martes a las 20:00'))
    paso('   Vídeos largos: el vídeo se reproduce desde su carpeta', await hasta(`document.querySelector('[data-test="long-video"] video')?.readyState >= 1`), await js(`document.querySelector('[data-test="long-video"] video')?.error?.message ?? null`))
    await foto('19-videos-largos.png')
    await clic('[data-test="long-copy-title"]')
    await esperar(300)
    paso('   Vídeos largos: copiar el título A lo deja en el portapapeles', (await clipboard.readText()) === 'Título A de prueba', await clipboard.readText())
    await clic('[data-test="long-mark"]')
    paso('   Vídeos largos: marcar como subido a YouTube se guarda y no toca el vídeo', await hasta(`document.querySelector('[data-test="long-mark"]').getAttribute('aria-pressed') === 'true'`) &&
      (db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'long_upload:01 · Prueba'").get() as Row).n === 1 &&
      fs.statSync(path.join(largo, 'largo.mp4')).size === tamLargo)
    paso('   Vídeos largos: no se puede pedir un archivo de fuera de su carpeta', (await js<number>(`fetch('cos://long/..').then((r) => r.status).catch(() => -1)`)) !== 200 &&
      (await js<number>(`fetch('cos://long-thumb/01%20%C2%B7%20Prueba/D').then((r) => r.status).catch(() => -1)`)) !== 200 &&
      (await js<number>(`fetch('cos://long-thumb/..%2F..%2Fcontent-os.db/A').then((r) => r.status).catch(() => -1)`)) !== 200)
    fs.rmSync(path.dirname(largo), { recursive: true, force: true })
    // vídeos de música: la misma ficha, en su propia carpeta y con su propia marca de subido
    await clic('[data-test="nav-music"]')
    paso('Vídeos de música: vacío, con su título y su propia carpeta', await hasta(`document.querySelector('main').dataset.view === 'music' && document.querySelector('[data-test="long-title"]')?.textContent.includes('música') && document.querySelector('[data-test="long-empty"]')?.textContent.includes('videos-musica')`))
    const musica = path.join((await js<{ dataDir: string }>('window.contentOS.getState()')).dataDir, 'videos-musica', '01 · Lluvia')
    fs.mkdirSync(musica, { recursive: true })
    fs.copyFileSync(origen, path.join(musica, 'musica.mp4'))
    fs.copyFileSync(portada, path.join(musica, 'miniatura_A.jpg'))
    fs.writeFileSync(path.join(musica, 'video.json'), JSON.stringify({ channel: 'Ambientes humo', titles: ['Lluvia A de prueba'], file: 'musica.mp4' }))
    await clic('[data-test="nav-campaigns"]')
    await clic('[data-test="nav-music"]')
    paso('   Vídeos de música: el vídeo aparece con su miniatura y se reproduce desde su carpeta', await hasta(`document.querySelectorAll('[data-test="long-video"]').length === 1 && [...document.querySelectorAll('[data-test="long-thumbs"] img')].filter((i) => i.naturalWidth > 0).length === 1`) &&
      await hasta(`document.querySelector('[data-test="long-video"] video')?.readyState >= 1`), await js(`document.querySelector('[data-test="long-video"] video')?.error?.message ?? null`))
    await foto('19b-videos-musica.png')
    await clic('[data-test="long-mark"]')
    paso('   Vídeos de música: marcar como subido guarda su propia marca', await hasta(`document.querySelector('[data-test="long-mark"]').getAttribute('aria-pressed') === 'true'`) &&
      (db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'music_upload:01 · Lluvia'").get() as Row).n === 1)
    paso('   Vídeos de música: no se puede pedir un archivo de fuera de su carpeta', (await js<number>(`fetch('cos://music/..').then((r) => r.status).catch(() => -1)`)) !== 200 &&
      (await js<number>(`fetch('cos://music-thumb/..%2F..%2Fcontent-os.db/A').then((r) => r.status).catch(() => -1)`)) !== 200)
    fs.rmSync(path.dirname(musica), { recursive: true, force: true })
    // campañas: la ficha dice cuándo irá a la Papelera una campaña terminada (aquí no se borra nada: la limpieza no corre en la prueba)
    const terminada = db.prepare('SELECT campaign_id FROM campaigns WHERE present_in_source = 1 LIMIT 1').get() as Row
    db.prepare("UPDATE campaigns SET ends_at = '2026-01-01' WHERE campaign_id = ?").run(terminada.campaign_id)
    await clic('[data-test="nav-campaigns"]')
    await clic('[data-test="sync"]')
    paso('Campañas: una campaña terminada dice cuándo va a la Papelera', await hasta(`document.querySelector('[data-campaign="${terminada.campaign_id}"] [data-test="purge-on"]')?.textContent === 'El 9 ene'`),
      await js(`document.querySelector('[data-campaign="${terminada.campaign_id}"] [data-test="purge-on"]')?.textContent ?? null`))

    // fin de semana: qué programar el sábado y el domingo en cada canal del plan
    // Fin de semana ya no está en el menú (se llega desde el Calendario): se abre directamente
    wc.send(CHANNELS.navigate, 'weekend')
    await hasta(`document.querySelector('main').dataset.view === 'weekend' && document.querySelectorAll('[data-test="weekend-account"]').length > 0`)
    // el domingo por la tarde (o sin canales libres) puede no quedar ningún hueco por programar: entonces solo se comprueba eso
    const hayHuecos = await js<boolean>(`!!document.querySelector('[data-test="weekend-slot"]')`)
    const domingoTarde = new Date().getDay() === 0 && new Date().getHours() >= 12
    if (!hayHuecos && domingoTarde) {
      paso('Fin de semana: el domingo por la tarde no propone huecos que ya han pasado', await js<boolean>(`!document.querySelector('[data-test="weekend-slot"]')`))
    } else {
      paso('Fin de semana: una tarjeta por canal con sus huecos de sábado y domingo', await hasta(`document.querySelector('main').dataset.view === 'weekend' && document.querySelectorAll('[data-test="weekend-account"]').length > 0 && document.querySelector('[data-test="weekend-slot"]')`),
        await js(`document.querySelector('[data-test="weekend-count"]')?.textContent ?? null`))
      const clipFinde = await js<string>(`document.querySelector('[data-test="weekend-slot"]').dataset.clip`)
      const canalFinde = await js<string>(`document.querySelector('[data-test="weekend-slot"]').closest('[data-test="weekend-account"]').dataset.account`)
      await clic('[data-test="weekend-mark"]')
      // en ese canal deja de proponerse (en otra plataforma sí puede salir: cada plataforma va aparte)
      paso('   Fin de semana: «Marcar programado» lo apunta a su hora (futura) y deja de proponerlo en ese canal', await hasta(`document.querySelector('[data-test="weekend-done"]') && !document.querySelector('[data-account="${canalFinde}"] [data-test="weekend-slot"][data-clip="${clipFinde}"]')`) &&
        (db.prepare('SELECT COUNT(*) AS n FROM publications WHERE clip_id = ? AND account = ? AND published_at > ?').get(clipFinde, canalFinde, new Date().toISOString()) as Row).n === 1 &&
        (await js<number>(`document.querySelectorAll('[data-account="${canalFinde}"] [data-test="weekend-slot"][data-clip="${clipFinde}"]').length`)) === 0,
        { clipFinde, canalFinde, pubs: db.prepare('SELECT account, published_at FROM publications WHERE clip_id = ?').all(clipFinde), error: await js(`document.querySelector('[data-test="weekend-error"]')?.textContent ?? null`) })
      await foto('19-fin-de-semana.png')
  
      await clic(`[data-account="${canalFinde}"] [data-test="weekend-done"][data-clip="${clipFinde}"] [data-test="weekend-undo"]`)
      paso('   Fin de semana: «Deshacer» lo quita', await hasta(`!document.querySelector('[data-account="${canalFinde}"] [data-test="weekend-done"][data-clip="${clipFinde}"]')`) &&
        (db.prepare('SELECT COUNT(*) AS n FROM publications WHERE clip_id = ? AND account = ? AND published_at > ?').get(clipFinde, canalFinde, new Date().toISOString()) as Row).n === 0, { pubs: db.prepare('SELECT account, published_at FROM publications WHERE clip_id = ?').all(clipFinde), ahora: new Date().toISOString(), filas: await js(`[...document.querySelectorAll('[data-test="weekend-done"]')].map((x) => x.dataset.clip)`) })
      // Elegir otro: el hueco cambia al clip que eliges y lo dice
      const antesClip = await js<string>(`document.querySelector('[data-test="weekend-slot"]').dataset.clip`)
      await clic('[data-test="weekend-slot"] [data-test="weekend-pick-open"]')
      await hasta(`!!document.querySelector('[data-test="weekend-pick-select"]')`)
      const otro = await js<string | null>(`[...document.querySelector('[data-test="weekend-pick-select"]').options].map((o) => o.value).find((v) => v && v !== ${JSON.stringify(antesClip)}) ?? null`)
      if (otro) {
        await js(`(() => { const el = document.querySelector('[data-test="weekend-pick-select"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${JSON.stringify(otro)}); el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      }
      // con pocas campañas en la biblioteca puede no haber otro clip que proponer: entonces no hay nada que comprobar
      if (otro) paso('   Fin de semana: «Elegir otro» pone en el hueco el clip que eliges', await hasta(`[...document.querySelectorAll('[data-test="weekend-slot"]')].some((x) => x.dataset.clip === ${JSON.stringify(otro)} && x.textContent.includes('elegido por ti'))`), otro)
    }

    // «Actualizar»: recalcula sin perder la pantalla
    await clic('[data-test="nav-today"]')
    await hasta(`!!document.querySelector('[data-test="refresh-plan"]')`)
    await clic('[data-test="refresh-plan"]')
    paso('Hoy: «Actualizar» recalcula y vuelve a quedar listo', await hasta(`document.querySelector('[data-test="refresh-plan"]')?.textContent === 'Actualizar' && document.querySelector('main').dataset.view === 'today'`))
    // Enviar a Vyro: lo ya publicado sale en «Hoy» con su enlace; «Enviado» lo quita y lo apunta
    const porEnviar = listVyroPending(db)
    await clic('[data-test="nav-today"]')
    paso('Enviar a Vyro: «Hoy» lista lo ya público que falta enviar', porEnviar.length > 0 &&
      await hasta(`document.querySelectorAll('[data-test="vyro-send-item"]').length === ${porEnviar.length}`) &&
      await hasta(`!!document.querySelector('[data-test="vyro-send-badge"]')`), porEnviar.length)
    await foto('21-enviar-a-vyro.png')
    await clic(`[data-test="vyro-send-item"][data-publication="${porEnviar[0].publicationId}"] [data-test="vyro-send-done"]`)
    paso('   Enviar a Vyro: «Enviado» lo quita de la lista y lo guarda', await hasta(`!document.querySelector('[data-test="vyro-send-item"][data-publication="${porEnviar[0].publicationId}"]')`) &&
      !!(db.prepare('SELECT vyro_sent_at FROM publications WHERE id = ?').get(porEnviar[0].publicationId) as Row).vyro_sent_at)

    // Control de vídeos: cada publicación con su estado en Vyro
    await clic('[data-test="nav-control"]')
    const pubsControl = (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE status = 'published' AND platform <> 'tiktok' AND published_at >= ?").get(new Date(Date.now() - 21 * 86_400_000).toISOString()) as Row).n
    // el filtro «Todos» se pulsa cuando la pantalla ya ha cargado: antes, el clic se perdía y se quedaba en «Atención»
    const todos = `[...document.querySelectorAll('[data-test="control-filter"]')].find((b) => b.textContent.startsWith('Todos'))`
    await hasta(`!!${todos}`)
    await js(`${todos}?.click()`)
    await hasta(`${todos}?.classList.contains('on')`)
    paso('Control de vídeos: una tarjeta por vídeo con su estado en Vyro', await hasta(`document.querySelectorAll('[data-test="control-video"]').length >= ${pubsControl} && [...document.querySelectorAll('[data-test="control-video"]')].every((c) => c.dataset.state && c.querySelector('[data-test="control-status"]'))`), pubsControl)
    await foto('22-control-de-videos.png')
    // Cuentas: el apartado abre (en la prueba no hay archivo de cuentas: lo dice)
    await clic('[data-test="top-settings"]')
    await hasta(`!!document.querySelector('[data-test="nav-accounts"]')`)
    await clic('[data-test="nav-accounts"]')
    paso('Cuentas: el apartado abre y, sin archivo, explica cómo se rellena', await hasta(`!!document.querySelector('[data-test="accounts-book-title"]') && !!document.querySelector('[data-test="accounts-book-empty"]')`))

    // canales propios (16-nov-2026): añadir un vídeo, marcarlo por red, apuntar cifras, estadísticas, cuentas, Inicio y Ajustes
    const datosHumo = (await js<{ dataDir: string }>('window.contentOS.getState()')).dataDir
    const suelto = path.join(datosHumo, 'descargas-humo', 'gta-mapa_v2.mp4')
    fs.mkdirSync(path.dirname(suelto), { recursive: true })
    fs.copyFileSync(origen, suelto)
    const importado = await js<{ created: { id: string }[] }>(`window.contentOS.importVideos('gta', [{ path: ${JSON.stringify(suelto)}, title: 'Si has estado en Miami, ya conoces medio GTA 6' }])`)
    paso('Canales propios: «Añadir vídeos» mete el MP4 en la carpeta del canal sin tocar el original', importado.created.length === 1 && fs.existsSync(suelto) &&
      fs.existsSync(path.join(datosHumo, 'videos-gta6', importado.created[0].id, 'video.json')), importado)
    await js(`(() => { const b = document.querySelector('[data-test="grp-gta"]'); if (b.getAttribute('aria-expanded') !== 'true') b.click() })()`)
    await hasta(`!!document.querySelector('[data-test="nav-gta"]')`)
    await clic('[data-test="nav-gta"]')
    paso('   GTA 6: el vídeo aparece con sus marcas por red', await hasta(`document.querySelectorAll('[data-test="long-video"]').length === 1 && !!document.querySelector('[data-test="city-mark-tiktok"]')`))
    await clic('[data-test="city-mark-tiktok"]')
    paso('   GTA 6: marcar TikTok lo guarda como subida de esa red', await hasta(`document.querySelector('[data-test="city-mark-tiktok"]').getAttribute('aria-pressed') === 'true'`) &&
      (db.prepare("SELECT COUNT(*) AS n FROM own_posts WHERE channel = 'gta' AND platform = 'tiktok'").get() as Row).n === 1)
    await clic('[data-test="long-add-stats"]')
    await hasta(`!!document.querySelector('[data-test="ownstats-modal"]')`)
    await escribir('[data-test="ownstats-views"]', '12400')
    await escribir('[data-test="ownstats-likes"]', '830')
    await escribir('[data-test="ownstats-retention"]', '72')
    await clic('[data-test="ownstats-save"]')
    paso('   GTA 6: apuntar cifras a mano las enseña bajo el vídeo', await hasta(`!document.querySelector('[data-test="ownstats-modal"]') && (document.querySelector('[data-test="long-stats"]')?.textContent ?? '').includes('12,4 mil')`),
      await js(`document.querySelector('[data-test="long-stats"]')?.textContent ?? null`))
    await foto('23-gta-videos.png')
    await clic('[data-test="nav-gta-stats"]')
    paso('   GTA 6: estadísticas con sus cifras y de dónde salen', await hasta(`(document.querySelector('[data-test="own-kpi-views"]')?.textContent ?? '').includes('12,4 mil') && (document.querySelector('[data-test="own-kpi-retention"]')?.textContent ?? '').includes('72') && !!document.querySelector('[data-test="own-kpi-views"] .src.manual') && document.querySelectorAll('[data-test="own-row"]').length === 1`))
    await foto('24-gta-estadisticas.png')
    await clic('[data-test="nav-gta-accounts"]')
    await hasta(`!!document.querySelector('[data-test="own-account-input-tiktok"]')`)
    await escribir('[data-test="own-account-input-tiktok"]', 'https://www.tiktok.com/@noticiasdemo')
    await clic('[data-test="own-account-add-tiktok"]')
    paso('   GTA 6: apuntar su cuenta de TikTok (pegando el enlace)', await hasta(`(document.querySelector('[data-test="own-accounts-tiktok"]')?.textContent ?? '').includes('@noticiasdemo')`))
    await foto('25-gta-cuentas.png')
    await clic('[data-test="top-import"]')
    paso('Añadir vídeos: la ventana abre desde la barra de arriba', await hasta(`!!document.querySelector('[data-test="import-drop"]')`))
    await foto('26-anadir-videos.png')
    await js(`document.querySelector('.veil').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await clic('[data-test="top-home"]')
    paso('Inicio: tarjetas de datos, visitas, «Hoy» y los canales', await hasta(`(document.querySelector('[data-test="home-kpi-likes"]')?.textContent ?? '').includes('830') && document.querySelectorAll('.chcard').length === 4 && !!document.querySelector('[data-test="home-today"]')`))
    await foto('0-inicio.png')
    await clic('[data-test="top-settings"]')
    paso('Ajustes: se ve el fondo de serie', await hasta(`document.querySelector('.bgprev')?.naturalWidth > 0`))
    await foto('27-ajustes.png')
    fs.rmSync(path.dirname(suelto), { recursive: true, force: true })

    // Calendario: el mes en semanas completas, hoy marcado y elegido; apuntar, marcar y borrar una tarea
    await clic('[data-test="top-calendar"]')
    const hoyCal = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
    paso('Calendario: el mes en semanas completas, con hoy marcado', await hasta(`(() => { const n = document.querySelectorAll('[data-test="calendar-day"]').length; return (n === 35 || n === 42 || n === 28) && !!document.querySelector('[data-test="calendar-day"].today[data-day="${hoyCal}"]') })()`))
    await escribir('[data-test="calendar-task-text"]', 'Tarea de la prueba de humo')
    await clic('[data-test="calendar-task-add"]')
    paso('   Calendario: apuntar una tarea la pone en el día elegido', await hasta(`[...document.querySelectorAll('[data-test="calendar-panel"] [data-test="calendar-item"][data-source="mine"]')].some((i) => i.textContent.includes('Tarea de la prueba de humo'))`) &&
      (db.prepare("SELECT COUNT(*) AS n FROM calendar_tasks WHERE day = ? AND text = 'Tarea de la prueba de humo'").get(hoyCal) as Row).n === 1)
    await foto('20b-calendario.png')
    await clic('[data-test="calendar-panel"] [data-source="mine"] [data-test="calendar-task-done"]')
    paso('   Calendario: marcarla como hecha', await hasta(`!!document.querySelector('[data-test="calendar-panel"] [data-source="mine"].done')`) &&
      (db.prepare("SELECT done FROM calendar_tasks WHERE text = 'Tarea de la prueba de humo'").get() as Row).done === 1)
    await clic('[data-test="calendar-panel"] [data-source="mine"] [data-test="calendar-task-delete"]')
    paso('   Calendario: borrarla', await hasta(`!document.querySelector('[data-test="calendar-panel"] [data-source="mine"]')`) &&
      (db.prepare('SELECT COUNT(*) AS n FROM calendar_tasks').get() as Row).n === 0)
    await clic('[data-test="calendar-next"]')
    paso('   Calendario: cambia de mes', await hasta(`document.querySelector('[data-test="calendar-month"]').textContent !== ''`))

    // Fábrica de Curiosidades (16-nov-2026): lee la tanda, enseña nota y pasos, y «Hacer tanda» responde
    if (!process.env.CONTENT_OS_FABRICA) {
      const fab = path.join(process.env.CONTENT_OS_DATA_DIR ?? '', 'fabrica-prueba')
      const tanda = path.join(fab, 'fabrica', 'tandas', '2026-11-16')
      fs.mkdirSync(tanda, { recursive: true })
      fs.mkdirSync(path.join(fab, 'videos', '43-garbo', 'revision'), { recursive: true })
      fs.writeFileSync(path.join(fab, 'Hacer tanda.bat'), '@echo off\r\n')
      fs.writeFileSync(path.join(tanda, 'estado.json'), JSON.stringify({ fecha: '2026-11-16', N: 2, videos: [
        { id: '43-garbo', tema: 'Garbo', paso: 'listo', nota: 95, intentos: 0, motivo: '', render: 'v1' },
        { id: '44-funcionario', tema: 'Funcionario', paso: 'animacion', nota: null, intentos: 1, motivo: '' }],
        cola: [{ dia: '2026-11-17', hora: '10:00', video: '43-garbo', archivo: '43-garbo.mp4', estado: 'propuesto' }], metricool: 'Esperando el OK.' }))
      fs.writeFileSync(path.join(tanda, 'temas.json'), JSON.stringify({ candidatos: [
        { id: 't1', tema: 'Garbo', nota_tema: 9, elegido: true }, { id: 't2', tema: 'Huéscar', nota_tema: 8, reserva: true }, { id: 't3', tema: 'Ali Dia', nota_tema: 6 }],
        revision_tema: { elegidos: ['t1'], reservas: ['t2'], fuera: ['t3'] } }))
      fs.writeFileSync(path.join(fab, 'videos', '43-garbo', 'guion.json'), JSON.stringify({ title: 'El barcelonés que engañó a Hitler' }))
      fs.writeFileSync(path.join(fab, 'videos', '43-garbo', 'revision', 'nota.json'), JSON.stringify({ total: 95, veredicto: 'pasa', nota_tema: 9,
        guion: { puntos: 58, detalle: { pregunta_abierta: 15 } }, video_final: { puntos: 37, detalle: { segundo0: 14 } } }))
      const mej = path.join(fab, 'fabrica', 'mejoras', '2026-11-17')
      fs.mkdirSync(mej, { recursive: true })
      fs.writeFileSync(path.join(mej, 'MEJORAS.md'), '# Mejoras\n')
      fs.writeFileSync(path.join(mej, 'mejoras.json'), JSON.stringify({ fecha: '2026-11-17', resumen: 'Los virales enseñan el final en el segundo 0.',
        importante: true, aviso: 'Enseñar lo increíble en el segundo 0', nuestros: 'Pocos datos todavía.',
        virales: [{ titulo: 'El hombre que vivió en un aeropuerto', enlace: 'https://www.youtube.com/shorts/abc', visitas: 2300000, por_que_funciona: 'Imagen rara en el segundo 0' }],
        mejoras: [
          { titulo: 'Imagen imposible en el segundo 0', que: 'Abrir con la escena final', por_que: '3 de 3 virales lo hacen', tipo: 'gratis', coste: '0 €', importancia: 'alta', quien: 'animador' },
          { titulo: 'Voz más natural', que: 'ElevenLabs', por_que: 'Retención', tipo: 'pago', coste: '5 €/mes', importancia: 'media', quien: 'voz' }] }))
    }
    await js(`(() => { const b = document.querySelector('[data-test="grp-curio"]'); if (b.getAttribute('aria-expanded') !== 'true') b.click() })()`)
    await hasta(`!!document.querySelector('[data-test="nav-curio-fabrica"]')`)
    await clic('[data-test="nav-curio-fabrica"]')
    paso('Fábrica: aparece en Curiosidades con sus vídeos, temas y cola', await hasta(`document.querySelectorAll('[data-test="fab-card"]').length >= 1 && !!document.querySelector('[data-test="fab-temas"] li') && !!document.querySelector('[data-test="fab-cola"] .fab-hora')`))
    if (!process.env.CONTENT_OS_FABRICA) {
      paso('   Fábrica: nota del revisor, tanda en marcha y título del guion', await js<boolean>(`(() => { const t = document.querySelector('[data-test="fabrica"]').textContent; return t.includes('95') && t.includes('El barcelonés que engañó a Hitler') && !!document.querySelector('[data-test="fab-running"]') && !!document.querySelector('.fab-pasos li.ahora') })()`))
    }
    if (!process.env.CONTENT_OS_FABRICA) {
      paso('   Fábrica: la sala 3D dibuja a los agentes y marca quién trabaja (animador y jefe)', await hasta(`!!document.querySelector('[data-test="fab-sala"] canvas') && document.querySelector('[data-agente="animador"]')?.dataset.activo === '1' && document.querySelector('[data-agente="jefe"]')?.dataset.activo === '1' && document.querySelector('[data-agente="guionista"]')?.dataset.activo === '0'`))
      await esperar(1500)
      await foto('29s-fabrica-sala.png')
    }
    await clic('[data-test="fab-why"]')
    paso('   Fábrica: «Por qué esta nota» abre el detalle', await hasta(`!!document.querySelector('.fab-barras li')`))
    await foto('29-fabrica.png')
    await js(`document.querySelector('[data-test="fab-temas"]').scrollIntoView({ block: 'end' })`)
    await foto('29b-fabrica-temas-cola.png')
    if (!process.env.CONTENT_OS_FABRICA) {
      paso('   Fábrica: aviso de mejora gratis importante y «Cómo mejorar» con gratis y de pago', await hasta(`!!document.querySelector('[data-test="fab-importante"]') && document.querySelector('[data-test="fab-mejoras"]').textContent.includes('Imagen imposible en el segundo 0') && document.querySelector('[data-test="fab-mtipo"]').textContent.includes('Pagando (1)')`))
      await js(`[...document.querySelectorAll('[data-test="fab-mtipo"] button')][1].click()`)
      paso('   Fábrica: pestaña «Pagando» enseña lo de pago con su coste', await hasta(`document.querySelector('[data-test="fab-mejoras"]').textContent.includes('5 €/mes')`))
      await js(`document.querySelector('[data-test="fab-mejoras"]').scrollIntoView({ block: 'end' })`)
      await foto('29c-fabrica-mejoras.png')
    }
    await clic('[data-test="fab-start"]')
    paso('   Fábrica: «Hacer tanda» avisa de que se ha abierto', await hasta(`document.querySelector('[data-test="fab-aviso"]')?.classList.contains('ok')`))
  } catch (e) {
    error = String(e)
    await foto('error.png').catch(() => undefined)
  }
  await clipboard.writeText(portapapelesPrevio)
  const ok = error === null && pasos.every((p) => p.ok)
  fs.writeFileSync(path.join(salida, 'humo.json'), JSON.stringify({ ok, error, electron: process.versions.electron, pasos }, null, 1))
  app.exit(ok ? 0 : 1)
}
