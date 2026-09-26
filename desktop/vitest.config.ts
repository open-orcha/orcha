import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['./src/renderer/test-setup.ts'],
    // resources/orcha-templates is a verbatim copy of the CLI templates (pretest hook);
    // the React portal inside it ships its own vitest suite that must only run in the
    // frontend's own project (jsdom env) — never in the desktop's node env.
    exclude: [...configDefaults.exclude, 'resources/**']
  }
})
