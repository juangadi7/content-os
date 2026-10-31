/** Biblioteca: ordenar y filtrar clips sin cambiar los datos. */
import { describe, expect, it } from 'vitest'
import { CLIP_STATES, clipStateKey, filterClips, filterLibrary, groupPublished, sortClips, sortPublished } from '../src/core/format'

const clip = (id: string, title: string | null, createdAt: string | null, extra: Record<string, unknown> = {}) =>
  ({ clipId: id, title, filename: `${id}.mp4`, createdAt, published: [] as string[], presentInSource: true, campaignClosed: false, ...extra })

describe('publicados: una tarjeta por clip', () => {
  const k = (id: string, title: string, score: number | null) => ({ clipId: id, title, filename: id + '.mp4', score })
  const A = k('a', 'Zeta', 80), B = k('b', 'alfa', 95), C = k('c', 'Medio', null)
  const pub = (id: number, platform: string, account: string, publishedAt: string | null, views: number | null | undefined) =>
    ({ id, platform, account, url: 'https://x/' + id, publishedAt, latest: views === undefined ? null : { views } })
  // como llegan de la base: una fila por publicación, la más reciente primero
  const filas = [
    { publication: pub(4, 'instagram', '@ig', '2026-10-09T10:00:00.000Z', undefined), clip: A },
    { publication: pub(3, 'youtube', '@yt', '2026-10-08T10:00:00.000Z', 0), clip: B },
    { publication: pub(2, 'tiktok', '@tk', '2026-10-07T10:00:00.000Z', 1200), clip: A },
    { publication: pub(1, 'youtube', '@yt', null, undefined), clip: C },
    { publication: pub(5, 'youtube', '@yt2', '2026-10-06T10:00:00.000Z', 300), clip: A }
  ]

  it('junta las publicaciones de cada clip sin perder ninguna', () => {
    const g = groupPublished(filas)
    expect(g.map((x) => [x.clip.clipId, x.publications.map((p) => p.id)])).toEqual([['a', [4, 2, 5]], ['b', [3]], ['c', [1]]])
    expect(g.reduce((n, x) => n + x.publications.length, 0)).toBe(filas.length)
    // cada publicación conserva su cuenta, su URL y su fecha
    expect(g[0].publications[1]).toMatchObject({ platform: 'tiktok', account: '@tk', url: 'https://x/2', publishedAt: '2026-10-07T10:00:00.000Z' })
  })

  it('suma solo las visitas medidas y distingue cero real de sin medir', () => {
    const [a, b, c] = groupPublished(filas)
    expect(a).toMatchObject({ views: 1500, measured: 2, lastPublishedAt: '2026-10-09T10:00:00.000Z' }) // Instagram no tiene cifras: no cuenta como 0
    expect(b).toMatchObject({ views: 0, measured: 1 }) // cero real
    expect(c).toMatchObject({ views: null, measured: 0, lastPublishedAt: null }) // sin medir
    expect(groupPublished([])).toEqual([])
  })

  it('ordena por recientes, visitas, puntuación y nombre, con los que no tienen dato al final', () => {
    const g = groupPublished(filas)
    const ids = (s: Parameters<typeof sortPublished>[1]) => sortPublished(g, s).map((x) => x.clip.clipId)
    expect(sortPublished(g, 'recent')).toBe(g)
    expect(ids('views')).toEqual(['a', 'b', 'c'])
    expect(ids('score')).toEqual(['b', 'a', 'c'])
    expect(ids('name')).toEqual(['b', 'c', 'a'])
    expect(g.map((x) => x.clip.clipId)).toEqual(['a', 'b', 'c']) // la lista original no cambia
  })
})

describe('todos los clips: estados y filtros', () => {
  const c = (id: string, extra: Record<string, unknown> = {}) =>
    ({ clipId: id, campaignId: 'c1', title: 'Clip ' + id, filename: id + '.mp4', presentInSource: true, fileState: 'ok', published: [] as string[], campaignClosed: false, ...extra })
  const lista = [
    c('pend'),
    c('yt', { published: ['youtube'] }),
    c('dos', { published: ['youtube', 'tiktok'], campaignId: 'c2' }), // en dos plataformas: sigue siendo UN clip
    c('cerr', { campaignClosed: true, campaignId: 'c2' }),
    c('pubcerr', { campaignClosed: true, published: ['tiktok'] }),
    c('falta', { fileState: 'missing' }),
    c('ret', { presentInSource: false, published: ['youtube'] })
  ]

  it('cada clip tiene exactamente un estado', () => {
    expect(lista.map((k) => [k.clipId, clipStateKey(k)])).toEqual([
      ['pend', 'pending'], ['yt', 'published'], ['dos', 'published'], ['cerr', 'closed'], ['pubcerr', 'published'], ['falta', 'missing'], ['ret', 'retired']
    ])
    expect(lista.every((k) => (CLIP_STATES as readonly string[]).includes(clipStateKey(k)))).toBe(true)
    // «pendiente» coincide con el filtro de siempre
    expect(lista.filter((k) => clipStateKey(k) === 'pending').map((k) => k.clipId)).toEqual(filterClips(lista, 'pending').filter((k) => k.fileState !== 'missing').map((k) => k.clipId))
  })

  it('sin filtros devuelve todos, una vez cada uno', () => {
    const r = filterLibrary(lista, {})
    expect(r.map((k) => k.clipId)).toEqual(lista.map((k) => k.clipId))
    expect(new Set(r.map((k) => k.clipId)).size).toBe(r.length)
  })

  it('por plataforma: un clip en dos plataformas sale una sola vez en cada filtro', () => {
    expect(filterLibrary(lista, { platform: 'youtube' }).map((k) => k.clipId)).toEqual(['yt', 'dos', 'ret'])
    expect(filterLibrary(lista, { platform: 'tiktok' }).map((k) => k.clipId)).toEqual(['dos', 'pubcerr'])
    expect(filterLibrary(lista, { platform: 'instagram' })).toEqual([])
  })

  it('por estado, campaña y búsqueda, y combinados', () => {
    expect(filterLibrary(lista, { state: 'published' }).map((k) => k.clipId)).toEqual(['yt', 'dos', 'pubcerr'])
    expect(filterLibrary(lista, { state: 'closed' }).map((k) => k.clipId)).toEqual(['cerr'])
    expect(filterLibrary(lista, { campaignId: 'c2' }).map((k) => k.clipId)).toEqual(['dos', 'cerr'])
    expect(filterLibrary(lista, { campaignId: 'c2', state: 'published', platform: 'tiktok' }).map((k) => k.clipId)).toEqual(['dos'])
    expect(filterLibrary(lista, { search: '  CLIP P ' }).map((k) => k.clipId)).toEqual(['pend', 'pubcerr'])
    expect(filterLibrary(lista, { state: 'pending', platform: 'youtube' })).toEqual([]) // un pendiente no está en ninguna plataforma
  })

  it('no modifica la lista original', () => {
    const antes = JSON.stringify(lista)
    filterLibrary(lista, { state: 'published', platform: 'youtube', search: 'x' })
    expect(JSON.stringify(lista)).toBe(antes)
  })
})

describe('ordenar clips', () => {
  const lista = [
    clip('a', "'You thought he kidnapped me'", '2026-10-08T14:00:00+02:00'),
    clip('b', 'Dating at 52', '2026-10-09T09:00:00+02:00'),
    clip('c', null, null),
    clip('d', 'álbum de fotos', '2026-10-07T10:00:00+02:00'),
    clip('e', '$2 million for 5%', '2026-10-09T08:00:00+02:00')
  ]

  it('por puntuación deja el orden de calidad con el que llega', () => {
    expect(sortClips(lista, 'score')).toBe(lista)
  })

  it('por fecha: los más recientes primero y los que no tienen fecha al final', () => {
    expect(sortClips(lista, 'date').map((k) => k.clipId)).toEqual(['b', 'e', 'a', 'd', 'c'])
  })

  it('por nombre: alfabético sin contar comillas ni símbolos iniciales, ni mayúsculas o acentos', () => {
    // «2 million», «álbum», «c.mp4» (sin título: su archivo), «Dating», «You thought»
    expect(sortClips(lista, 'name').map((k) => k.clipId)).toEqual(['e', 'd', 'c', 'b', 'a'])
  })

  it('no modifica la lista original', () => {
    const antes = lista.map((k) => k.clipId)
    sortClips(lista, 'name')
    sortClips(lista, 'date')
    expect(lista.map((k) => k.clipId)).toEqual(antes)
  })

  it('pendiente sigue significando lo mismo: sin publicar, presente y con la campaña abierta', () => {
    const mezcla = [
      clip('p', 'Pendiente', null),
      clip('x', 'Publicado', null, { published: ['youtube'] }),
      clip('z', 'Campaña cerrada', null, { campaignClosed: true }),
      clip('r', 'Retirado', null, { presentInSource: false })
    ]
    expect(filterClips(mezcla, 'pending').map((k) => k.clipId)).toEqual(['p'])
    expect(sortClips(filterClips(mezcla, 'pending', 'pend'), 'name').map((k) => k.clipId)).toEqual(['p'])
  })
})
