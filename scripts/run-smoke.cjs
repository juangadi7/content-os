// Prueba de humo real: arranca la aplicación compilada con una carpeta de datos TEMPORAL,
// la maneja con clics de verdad y deja capturas e informe en docs/smoke-ui.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const raiz = path.resolve(__dirname, '..')
const salida = path.join(raiz, 'docs', 'smoke-ui')
const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'cos_smoke_'))
fs.rmSync(salida, { recursive: true, force: true })

const r = spawnSync(require('electron'), ['.'], {
  cwd: raiz,
  stdio: 'inherit',
  env: { ...process.env, CONTENT_OS_SMOKE: salida, CONTENT_OS_DATA_DIR: datos }
})
let informe = { ok: false, error: 'la aplicación no dejó informe', pasos: [] }
try {
  informe = JSON.parse(fs.readFileSync(path.join(salida, 'humo.json'), 'utf8'))
} catch {}
for (const p of informe.pasos) console.log(`${p.ok ? 'PASS' : 'FAIL'}  ${p.paso}`)
if (informe.error) console.log('ERROR:', informe.error)
console.log(`\n${informe.pasos.filter((p) => p.ok).length}/${informe.pasos.length} pasos correctos · salida ${r.status} · datos temporales borrados`)
fs.rmSync(datos, { recursive: true, force: true })
process.exit(informe.ok && r.status === 0 ? 0 : 1)
