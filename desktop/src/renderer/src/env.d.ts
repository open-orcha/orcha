/// <reference types="vite/client" />
import type { OrchaDesktopApi } from '../../shared/types'

declare global {
  interface Window {
    orchaDesktop: OrchaDesktopApi
  }
}

export {}
