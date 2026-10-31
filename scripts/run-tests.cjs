// Ejecuta vitest DENTRO del runtime de Electron (como Node), para probar el mismo
// binario de SQLite que usa la aplicación.  --real: sync de solo lectura sobre CAMPAIGNS reales.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const electron = require('electron')
const real = process.argv.includes('--real')
const r = spawnSync(electron, [path.join('node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=verbose'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CONTENT_OS_REAL: real ? '1' : '0' }
})
process.exit(r.status ?? 1)
