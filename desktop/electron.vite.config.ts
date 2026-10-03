import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two preloads: index (manager window + tray popover → window.orchaDesktop) and
        // portal (embedded portal WebContentsViews only → window.orchaHost, arch §7.2).
        // Both run sandboxed, so neither may import a shared runtime chunk: index.ts imports
        // shared/* for TYPES only; portal.ts is the only runtime consumer of shared/embed.ts.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          portal: resolve(__dirname, 'src/preload/portal.ts')
        }
      }
    }
  },
  renderer: { plugins: [react(), tailwindcss()] }
})
