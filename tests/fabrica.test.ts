import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it } from 'vitest'
import { esEnlaceViral, readFabrica, resolveFabricaMejoras, tandaEnMarcha } from '../src/core/fabrica'
import { Mejoras } from '../src/renderer/views/FabricaView'
import { estadoAgentes } from '../src/renderer/components/FabricaSala'

// Fábrica de Curiosidades: el informe diario del «mejorador» (17-nov-2026)
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'fabrica-'))
afterAll(() => fs.rmSync(raiz, { recursive: true, force: true }))

function escribir(rel: string, datos: unknown) {
  const ruta = path.join(raiz, rel)
  fs.mkdirSync(path.dirname(ruta), { recursive: true })
  fs.writeFileSync(ruta, typeof datos === 'string' ? datos : JSON.stringify(datos))
}

escribir('fabrica/tandas/2026-11-17/estado.json', {
  fecha: '2026-11-17', N: 1, videos: [],
  cola: [
    { dia: '2026-11-18', hora: '16:00', video: '45-congelada', archivo: '45-congelada.mp4', estado: 'programado' },
    { dia: '2026-11-18', hora: '10:00', video: '44-funcionario', archivo: '44-funcionario.mp4', estado: 'programado' }
  ]
})
escribir('fabrica/mejoras/2026-11-16/mejoras.json', { fecha: '2026-11-16', resumen: 'Ayer', mejoras: [] })
escribir('fabrica/mejoras/2026-11-17/mejoras.json', {
  fecha: '2026-11-17', resumen: 'Los virales enseñan lo increíble en el segundo 0.', importante: true, aviso: 'Imagen imposible al empezar',
  nuestros: 'Pocos datos.',
  virales: [{ titulo: 'Recortó su día', enlace: 'https://www.youtube.com/shorts/abc', visitas: 5_300_000, por_que_funciona: 'Giro final' }],
  mejoras: [
    { titulo: 'Voz más natural', que: 'ElevenLabs', por_que: 'Retención', tipo: 'pago', coste: '5 €/mes', importancia: 'media', quien: 'voz' },
    { titulo: 'Subtítulos más grandes', que: 'Subir a 90 px', por_que: 'Se leen en el móvil', tipo: 'gratis', importancia: 'baja', quien: 'animador' },
    { titulo: 'Imagen imposible en el segundo 0', que: 'Abrir con la escena final', por_que: '3 de 3 virales', tipo: 'gratis', importancia: 'alta', quien: 'animador' },
    { titulo: 5 }
  ]
})
escribir('fabrica/mejoras/2026-11-17/MEJORAS.md', '# Mejoras\n')
escribir('fabrica/mejoras/no-es-fecha/mejoras.json', { resumen: 'no' })

describe('Fábrica: mejorador y cola de 2 al día', () => {
  const datos = readFabrica(raiz)

  it('lee los informes del mejorador, el más reciente primero, y ordena las mejoras por importancia', () => {
    expect(datos.mejoras.map((m) => m.fecha)).toEqual(['2026-11-17', '2026-11-16'])
    const m = datos.mejoras[0]
    expect(m.importante).toBe(true)
    expect(m.tieneInforme).toBe(true)
    expect(m.mejoras.map((x) => x.titulo)).toEqual(['Imagen imposible en el segundo 0', 'Voz más natural', 'Subtítulos más grandes'])
    expect(m.mejoras[1]).toMatchObject({ tipo: 'pago', coste: '5 €/mes', porQue: 'Retención' })
    expect(m.virales[0]).toMatchObject({ visitas: 5_300_000, porQue: 'Giro final' })
    expect(datos.mejoras[1].importante).toBe(false)
  })

  it('ordena la cola por día y hora', () => {
    expect(datos.tandas[0].cola.map((c) => `${c.dia} ${c.hora}`)).toEqual(['2026-11-18 10:00', '2026-11-18 16:00'])
  })

  it('solo abre el informe de una fecha válida y enlaces de vídeo conocidos', () => {
    expect(resolveFabricaMejoras(raiz, '2026-11-17')).toBe(path.join(raiz, 'fabrica', 'mejoras', '2026-11-17', 'MEJORAS.md'))
    expect(resolveFabricaMejoras(raiz, '../2026-11-17')).toBeNull()
    expect(resolveFabricaMejoras(raiz, '2026-11-16')).toBeNull()
    expect(esEnlaceViral('https://www.youtube.com/shorts/abc')).toBe(true)
    expect(esEnlaceViral('https://www.tiktok.com/@x/video/1')).toBe(true)
    expect(esEnlaceViral('file:///C:/Windows/system32/calc.exe')).toBe(false)
    expect(esEnlaceViral('https://evil.example.com/youtube.com/')).toBe(false)
    expect(esEnlaceViral('javascript:alert(1)')).toBe(false)
  })

  it('«Cómo mejorar» enseña primero las gratis, con su importancia, y los virales', () => {
    const html = renderToStaticMarkup(createElement(Mejoras, { lista: datos.mejoras, onOpen: () => undefined }))
    expect(html).toContain('Gratis (2)')
    expect(html).toContain('Pagando (1)')
    expect(html).toContain('Imagen imposible en el segundo 0')
    expect(html).toContain('Importante')
    expect(html).not.toContain('Voz más natural')
    expect(html).toContain('5,3 M visitas')
  })

  it('sin informes todavía, explica qué hará el mejorador', () => {
    const html = renderToStaticMarkup(createElement(Mejoras, { lista: [], onOpen: () => undefined }))
    expect(html).toContain('primer informe')
  })

  it('la sala marca quién trabaja según el paso de cada vídeo', () => {
    const tanda = { ...datos.tandas[0], n: 3, videos: [
      { id: '46-aeropuerto', paso: 'guion' }, { id: '47-loteria', paso: 'animacion' }, { id: '48-faro', paso: 'listo' }] } as never
    const a = Object.fromEntries(estadoAgentes(tanda, false).map((x) => [x.id, x]))
    expect(a.jefe).toMatchObject({ activo: true, texto: 'Coordinando · 1 de 3 listos' })
    expect(a.guionista).toMatchObject({ activo: true, texto: 'Trabajando: aeropuerto' })
    expect(a.animador.activo).toBe(true)
    expect(a.cazador).toMatchObject({ activo: false, texto: 'Su parte, hecha' })
    expect(a.revisor).toMatchObject({ activo: false, texto: 'Espera: 2 en camino' })
    expect(a.mejorador.activo).toBe(true)
    expect(estadoAgentes(tanda, true).find((x) => x.id === 'mejorador')?.activo).toBe(false)
    const quieta = estadoAgentes({ ...datos.tandas[0], n: 1, videos: [{ id: '48-faro', paso: 'listo' }] } as never, false)
    expect(quieta.every((x) => !x.activo)).toBe(true)
    expect(quieta[0].texto).toBe('Tanda terminada · 1 aprobado')
  })

  it('mientras el cazador busca temas (aún sin vídeos) la tanda está en marcha; parada si lleva 3 h quieta', () => {
    const buscando = { ...datos.tandas[0], paso: 'temas', videos: [], actualizado: Date.now() }
    expect(tandaEnMarcha(buscando)).toBe(true)
    const a = Object.fromEntries(estadoAgentes(buscando, true).map((x) => [x.id, x]))
    expect(a.cazador).toMatchObject({ activo: true, texto: 'Buscando 1 temas top' })
    expect(a.jefe).toMatchObject({ activo: true, texto: 'Preparando la tanda de hoy' })
    expect(a.guionista).toMatchObject({ activo: false, texto: 'Espera los temas' })
    expect(tandaEnMarcha({ ...buscando, actualizado: Date.now() - 4 * 3600_000 })).toBe(false)
    expect(tandaEnMarcha({ ...buscando, paso: 'fin' })).toBe(false)
    expect(tandaEnMarcha({ ...buscando, paso: '' })).toBe(false)
  })
})
