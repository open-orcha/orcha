import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['./src/renderer/test-setup.ts'],
    // resources/ holds build outputs (the bundled orcha-runtime, and on older checkouts a
    // stale orcha-templates copy whose portal tests must never run in the desktop's node env).
    exclude: [...configDefaults.exclude, 'resources/**', 'dist/**']
  }
})
