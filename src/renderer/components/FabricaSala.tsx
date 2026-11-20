import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { tandaEnMarcha, type FabricaPaso, type FabricaTanda } from '../../core/fabrica'

/**
 * «La sala» de la Fábrica (17-nov-2026, pedido por Juan con un reel de referencia): una sala redonda en 3D,
 * estilo atardecer de neón, con el jefe en el centro y cada agente en su mesa alrededor. Encima de cada uno, un
 * cartel con lo que está haciendo AHORA (sale de estado.json: el `paso` de cada vídeo) y una flecha que marca
 * a quien trabaja. No gasta nada de Claude: es solo dibujo. Se para cuando no se ve y, sin tanda, va a medio gas.
 */

export interface Agente {
  id: string
  nombre: string
  activo: boolean
  texto: string
}

const PUESTOS: { id: string; nombre: string; paso?: FabricaPaso; color: number; pelo: number }[] = [
  { id: 'cazador', nombre: 'Cazador de temas', paso: 'tema', color: 0xe24b4a, pelo: 0x3b2314 },
  { id: 'guionista', nombre: 'Guionista', paso: 'guion', color: 0x378add, pelo: 0x1d1d1d },
  { id: 'voz', nombre: 'Voz y música', paso: 'voz', color: 0x639922, pelo: 0x7a4a1c },
  { id: 'animador', nombre: 'Animador', paso: 'animacion', color: 0xba7517, pelo: 0x2a1a10 },
  { id: 'revisor', nombre: 'Revisor', paso: 'revision', color: 0x7f77dd, pelo: 0xd9c08a },
  { id: 'mejorador', nombre: 'Mejorador', color: 0x1d9e75, pelo: 0x101010 }
]
const ORDEN: FabricaPaso[] = ['tema', 'guion', 'voz', 'animacion', 'revision', 'listo']

/** Qué hace cada agente según la tanda (se exporta para las pruebas). */
export function estadoAgentes(tanda: FabricaTanda | null, mejoraHoy: boolean): Agente[] {
  const videos = tanda?.videos ?? []
  const enMarcha = !!tanda && tandaEnMarcha(tanda)
  const buscando = enMarcha && videos.length === 0
  const corto = (id: string) => id.replace(/^\d+-/, '')
  const agentes: Agente[] = PUESTOS.map((p) => {
    if (p.id === 'mejorador') {
      return enMarcha && !mejoraHoy
        ? { id: p.id, nombre: p.nombre, activo: true, texto: 'Mirando los virales de hoy' }
        : { id: p.id, nombre: p.nombre, activo: false, texto: mejoraHoy ? 'Informe de hoy hecho' : 'Espera a la próxima tanda' }
    }
    if (buscando && p.id === 'cazador') {
      return { id: p.id, nombre: p.nombre, activo: true, texto: `Buscando ${tanda?.n ?? 3} temas top` }
    }
    const aqui = videos.filter((v) => v.paso === p.paso)
    if (aqui.length) {
      return { id: p.id, nombre: p.nombre, activo: true, texto: `Trabajando: ${aqui.map((v) => corto(v.id)).join(', ')}` }
    }
    const i = ORDEN.indexOf(p.paso!)
    const pendientes = videos.filter((v) => v.paso !== 'tirado' && ORDEN.indexOf(v.paso) < i)
    return {
      id: p.id, nombre: p.nombre, activo: false,
      texto: !enMarcha ? 'Esperando a la próxima tanda' : buscando ? 'Espera los temas' : pendientes.length ? `Espera: ${pendientes.length} en camino` : 'Su parte, hecha'
    }
  })
  const listos = videos.filter((v) => v.paso === 'listo').length
  const jefe: Agente = enMarcha
    ? { id: 'jefe', nombre: 'Jefe', activo: true, texto: buscando ? 'Preparando la tanda de hoy' : `Coordinando · ${listos} de ${tanda?.n ?? videos.length} listos` }
    : { id: 'jefe', nombre: 'Jefe', activo: false, texto: tanda ? `Tanda terminada · ${listos} ${listos === 1 ? "aprobado" : "aprobados"}` : 'Sin tandas todavía' }
  return [jefe, ...agentes]
}

// ------------------------------------------------------------------------------------------------ escena

function cielo(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 16
  c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#1a0b2e')
  grad.addColorStop(0.45, '#5b1f6b')
  grad.addColorStop(0.7, '#c2477a')
  grad.addColorStop(0.88, '#f39a5b')
  grad.addColorStop(1, '#ffd08a')
  g.fillStyle = grad
  g.fillRect(0, 0, 16, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function suelo(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(256, 256, 20, 256, 256, 256)
  grad.addColorStop(0, '#6d2f86')
  grad.addColorStop(0.6, '#3a1650')
  grad.addColorStop(1, '#1c0a2a')
  g.fillStyle = grad
  g.fillRect(0, 0, 512, 512)
  g.strokeStyle = 'rgba(255,140,220,0.18)'
  g.lineWidth = 2
  for (let r = 60; r < 256; r += 48) {
    g.beginPath()
    g.arc(256, 256, r, 0, Math.PI * 2)
    g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

const neon = (color: number, radio: number, grosor = 0.035) =>
  new THREE.Mesh(new THREE.TorusGeometry(radio, grosor, 8, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }))

interface Puesto {
  grupo: THREE.Group
  cuerpo: THREE.Group
  anillos: THREE.Mesh[]
  pantalla: THREE.MeshStandardMaterial
  flecha: THREE.Mesh
  anclaje: THREE.Vector3
  fase: number
}

function persona(color: number, pelo: number, escala = 1): THREE.Group {
  const g = new THREE.Group()
  const piel = new THREE.MeshStandardMaterial({ color: 0xf1c7a1, roughness: 0.6 })
  const ropa = new THREE.MeshStandardMaterial({ color, roughness: 0.5 })
  const cuerpo = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.7, 0.4), ropa)
  cuerpo.position.y = 0.95
  const cabeza = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.44), piel)
  cabeza.position.y = 1.55
  const gorro = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.48), new THREE.MeshStandardMaterial({ color: pelo, roughness: 0.8 }))
  gorro.position.y = 1.82
  const ojos = new THREE.MeshBasicMaterial({ color: 0x1b1b1b })
  for (const x of [-0.1, 0.1]) {
    const o = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.02), ojos)
    o.position.set(x, 1.58, 0.225)
    g.add(o)
  }
  for (const x of [-0.38, 0.38]) {
    const brazo = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.18), ropa)
    brazo.position.set(x, 0.98, 0.12)
    brazo.rotation.x = -0.7
    g.add(brazo)
  }
  g.add(cuerpo, cabeza, gorro)
  g.scale.setScalar(escala)
  return g
}

function mesa(pantallaColor: number): { g: THREE.Group; pantalla: THREE.MeshStandardMaterial } {
  const g = new THREE.Group()
  const blanco = new THREE.MeshStandardMaterial({ color: 0xf4eefa, roughness: 0.35 })
  const tablero = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.75), blanco)
  tablero.position.y = 0.78
  const frente = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 0.06), new THREE.MeshStandardMaterial({ color: 0x2a1838, roughness: 0.5 }))
  frente.position.set(0, 0.42, 0.34)
  const pantalla = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: pantallaColor, emissiveIntensity: 0.6 })
  const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.4, 0.05), [
    new THREE.MeshStandardMaterial({ color: 0x151515 }), new THREE.MeshStandardMaterial({ color: 0x151515 }),
    new THREE.MeshStandardMaterial({ color: 0x151515 }), new THREE.MeshStandardMaterial({ color: 0x151515 }),
    new THREE.MeshStandardMaterial({ color: 0x151515 }), pantalla
  ])
  monitor.position.set(0, 1.08, 0.12)
  g.add(tablero, frente, monitor)
  return { g, pantalla }
}

function crearPuesto(color: number, pelo: number, x: number, z: number, central: boolean): Puesto {
  const grupo = new THREE.Group()
  grupo.position.set(x, 0, z)
  grupo.lookAt(0, 0, 0)
  if (central) grupo.rotation.y = 0
  const radio = central ? 2.2 : 1.3
  const base = new THREE.Mesh(new THREE.CylinderGeometry(radio, radio + 0.08, central ? 0.5 : 0.2, 48),
    new THREE.MeshStandardMaterial({ color: 0x2b1240, roughness: 0.3, metalness: 0.3 }))
  base.position.y = central ? 0.25 : 0.1
  grupo.add(base)
  const anillos: THREE.Mesh[] = []
  const tonos = central ? [0xff5fd2, 0xffd166, 0x5ee7ff] : [0x5ee7ff, 0xff5fd2]
  tonos.forEach((c, i) => {
    const a = neon(c, radio + 0.15 + i * (central ? 0.45 : 0.3), central ? 0.05 : 0.035)
    a.rotation.x = Math.PI / 2
    a.position.y = 0.04 + (central ? 0.02 * i : 0)
    grupo.add(a)
    anillos.push(a)
  })
  if (central) {
    const peana = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.4, 0.35, 48), new THREE.MeshStandardMaterial({ color: 0x3d1a5a, roughness: 0.3 }))
    peana.position.y = 0.67
    grupo.add(peana)
    const tope = neon(0x5ee7ff, 1.35, 0.04)
    tope.rotation.x = Math.PI / 2
    tope.position.y = 0.86
    grupo.add(tope)
    anillos.push(tope)
  }
  const alto = central ? 0.85 : 0.2
  const { g: m, pantalla } = mesa(color)
  m.position.set(0, alto, 0.15)
  grupo.add(m)
  const cuerpo = persona(color, pelo, central ? 1.15 : 1)
  cuerpo.position.set(0, alto, -0.45)
  grupo.add(cuerpo)
  const flecha = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.4, 3), new THREE.MeshBasicMaterial({ color: 0x5ee7ff }))
  flecha.rotation.x = Math.PI
  flecha.position.set(0, alto + 2.6, -0.3)
  grupo.add(flecha)
  return { grupo, cuerpo, anillos, pantalla, flecha, anclaje: new THREE.Vector3(x, alto + 3.1, z), fase: Math.random() * 6 }
}

export function FabricaSala({ agentes, enMarcha }: { agentes: Agente[]; enMarcha: boolean }) {
  const caja = useRef<HTMLDivElement>(null)
  const etiquetas = useRef<(HTMLDivElement | null)[]>([])
  const estado = useRef({ agentes, enMarcha })
  estado.current = { agentes, enMarcha }
  const [sinWebgl, setSinWebgl] = useState(false)

  useEffect(() => {
    const el = caja.current
    if (!el) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' })
    } catch {
      setSinWebgl(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.className = 'fab-sala-canvas'
    el.prepend(renderer.domElement)

    const escena = new THREE.Scene()
    escena.background = cielo()
    escena.fog = new THREE.Fog(0x7a2f6e, 26, 70)
    const camara = new THREE.PerspectiveCamera(42, 2, 0.1, 100)

    escena.add(new THREE.HemisphereLight(0xffd6f2, 0x3a1650, 2))
    const sol = new THREE.DirectionalLight(0xffb27a, 1.6)
    sol.position.set(-6, 10, -8)
    escena.add(sol)
    const rosa = new THREE.PointLight(0xff4fc3, 30, 20)
    rosa.position.set(0, 4, 0)
    escena.add(rosa)

    const piso = new THREE.Mesh(new THREE.CircleGeometry(10.5, 96), new THREE.MeshStandardMaterial({ map: suelo(), roughness: 0.25, metalness: 0.4 }))
    piso.rotation.x = -Math.PI / 2
    escena.add(piso)
    const borde = neon(0xff5fd2, 10.5, 0.07)
    borde.rotation.x = Math.PI / 2
    escena.add(borde)
    const borde2 = neon(0x5ee7ff, 9.9, 0.03)
    borde2.rotation.x = Math.PI / 2
    escena.add(borde2)
    // cristalera alrededor
    const cristal = new THREE.Mesh(new THREE.CylinderGeometry(10.6, 10.6, 5, 64, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffb3e6, transparent: true, opacity: 0.07, side: THREE.DoubleSide }))
    cristal.position.y = 2.5
    escena.add(cristal)
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const barra = new THREE.Mesh(new THREE.BoxGeometry(0.05, 5, 0.05), new THREE.MeshBasicMaterial({ color: 0xb05aa8, transparent: true, opacity: 0.55 }))
      barra.position.set(Math.cos(a) * 10.6, 2.5, Math.sin(a) * 10.6)
      escena.add(barra)
    }
    // sol del atardecer y siluetas de la ciudad, fuera de la cristalera
    const cs = document.createElement('canvas')
    cs.width = cs.height = 128
    const gs = cs.getContext('2d')!
    const rs = gs.createRadialGradient(64, 64, 4, 64, 64, 64)
    rs.addColorStop(0, 'rgba(255,240,200,1)')
    rs.addColorStop(0.35, 'rgba(255,170,90,0.9)')
    rs.addColorStop(1, 'rgba(255,90,120,0)')
    gs.fillStyle = rs
    gs.fillRect(0, 0, 128, 128)
    const texSol = new THREE.CanvasTexture(cs)
    const astro = new THREE.Sprite(new THREE.SpriteMaterial({ map: texSol, transparent: true, depthWrite: false, fog: false }))
    astro.scale.set(16, 16, 1)
    astro.position.set(-14, 4.5, -38)
    escena.add(astro)
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + Math.random() * 0.05
      const h = 1.5 + Math.random() * 6
      const edificio = new THREE.Mesh(new THREE.BoxGeometry(1.6 + Math.random() * 2, h, 1.6),
        new THREE.MeshBasicMaterial({ color: 0x3a1450, transparent: true, opacity: 0.85 }))
      const r = 30 + Math.random() * 8
      edificio.position.set(Math.cos(a) * r, h / 2 - 0.5, Math.sin(a) * r)
      edificio.lookAt(0, h / 2, 0)
      escena.add(edificio)
    }
    const mar = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshBasicMaterial({ color: 0x8a3c7c }))
    mar.rotation.x = -Math.PI / 2
    mar.position.y = -0.6
    escena.add(mar)

    // partículas
    const n = 260
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = Math.random() * 10
      const a = Math.random() * Math.PI * 2
      pos.set([Math.cos(a) * r, Math.random() * 5 + 0.2, Math.sin(a) * r], i * 3)
    }
    const geoP = new THREE.BufferGeometry()
    geoP.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const chispas = new THREE.Points(geoP, new THREE.PointsMaterial({ color: 0xffe3a3, size: 0.06, transparent: true, opacity: 0.8 }))
    escena.add(chispas)

    // puestos: el jefe en el centro y los demás en círculo
    const puestos: Puesto[] = [crearPuesto(0x8e3fbf, 0x5a2a12, 0, 0, true)]
    PUESTOS.forEach((p, i) => {
      const a = (i / PUESTOS.length) * Math.PI * 2 + Math.PI / 2
      puestos.push(crearPuesto(p.color, p.pelo, Math.cos(a) * 6.3, Math.sin(a) * 6.3, false))
    })
    for (const p of puestos) escena.add(p.grupo)

    const tamaño = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camara.aspect = w / h
      camara.updateProjectionMatrix()
    }
    tamaño()
    const ro = new ResizeObserver(tamaño)
    ro.observe(el)

    let visible = true
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting })
    io.observe(el)
    const quieto = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    const v = new THREE.Vector3()
    const reloj = new THREE.Clock()
    let ultimo = 0
    let raf = 0
    const dibujar = () => {
      raf = requestAnimationFrame(dibujar)
      const t = reloj.getElapsedTime()
      const { agentes: ag, enMarcha: vivo } = estado.current
      const fps = vivo ? 30 : 12
      if (!visible || document.hidden || t - ultimo < 1 / fps) return
      ultimo = t
      const giro = quieto ? 0.6 : t * (vivo ? 0.06 : 0.03)
      camara.position.set(Math.sin(giro) * 16.5, 7, Math.cos(giro) * 16.5)
      camara.lookAt(0, 1.6, 0)
      puestos.forEach((p, i) => {
        const a = ag[i]
        const on = !!a?.activo
        const pulso = 0.5 + 0.5 * Math.sin(t * 3 + p.fase)
        p.anillos.forEach((r, k) => {
          const m = r.material as THREE.MeshBasicMaterial
          m.opacity = on ? 0.55 + 0.45 * Math.sin(t * 2.4 + k + p.fase) ** 2 : 0.25
          if (on && !quieto) r.rotation.z = t * (k % 2 ? -0.4 : 0.4)
        })
        p.flecha.visible = on
        p.flecha.position.y = (i === 0 ? 0.85 : 0.2) + 2.6 + (on && !quieto ? Math.sin(t * 3 + p.fase) * 0.12 : 0)
        p.flecha.rotation.y = t * 1.5
        p.pantalla.emissiveIntensity = on ? 0.7 + 0.5 * pulso : 0.15
        p.cuerpo.position.y = (i === 0 ? 0.85 : 0.2) + (on && !quieto ? Math.abs(Math.sin(t * 6 + p.fase)) * 0.04 : 0)
        p.cuerpo.rotation.y = on && !quieto ? Math.sin(t * 1.3 + p.fase) * 0.15 : 0
        // cartel encima
        const e = etiquetas.current[i]
        if (e) {
          v.copy(p.anclaje).project(camara)
          const x = (v.x * 0.5 + 0.5) * el.clientWidth
          const y = (-v.y * 0.5 + 0.5) * el.clientHeight
          e.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
          e.style.zIndex = String(Math.round((1 - v.z) * 1000) + (a?.activo ? 2000 : 0))
        }
      })
      chispas.rotation.y = quieto ? 0 : t * 0.02
      renderer.render(escena, camara)
    }
    dibujar()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      escena.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []
        for (const mat of mats) {
          ;(mat as THREE.MeshStandardMaterial).map?.dispose()
          mat.dispose()
        }
      })
      ;(escena.background as THREE.Texture | null)?.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  const lista = useMemo(() => agentes, [agentes])
  if (sinWebgl) return null
  return (
    <div className="fab-sala" ref={caja} data-test="fab-sala">
      {lista.map((a, i) => (
        <div key={a.id} ref={(n) => { etiquetas.current[i] = n }} className={`fab-cartel${a.activo ? ' on' : ''}${a.id === 'jefe' ? ' jefe' : ''}`}
          data-test="fab-agente" data-agente={a.id} data-activo={a.activo ? '1' : '0'}>
          <b>{a.nombre}</b>
          <span>{a.texto}</span>
        </div>
      ))}
    </div>
  )
}
