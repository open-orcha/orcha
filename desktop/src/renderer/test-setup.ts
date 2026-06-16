import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// RTL only auto-registers cleanup when vitest exposes a global afterEach
// (globals: true). This project uses explicit imports, so register it here;
// cleanup() is a no-op for node-environment (main process) tests.
afterEach(() => {
  cleanup()
})
