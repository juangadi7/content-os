import { defineConfig } from 'vitest/config'

const real = process.env.CONTENT_OS_REAL === '1'

export default defineConfig({
  test: {
    environment: 'node',
    include: real ? ['tests/real/**/*.test.ts'] : ['tests/*.test.ts'],
    pool: 'forks',
    testTimeout: real ? 600_000 : 30_000,
    hookTimeout: 60_000
  }
})
