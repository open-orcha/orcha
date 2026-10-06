/** The theme the renderer is painting right now — 'light' | 'dark' — read from
 *  `prefers-color-scheme`, which main keeps equal to Settings › Appearance via
 *  nativeTheme.themeSource (System follows macOS live). CSS needs none of this (styles.css
 *  switches on the media query); it is for the few things painted from JS, like xterm. */
import { useEffect, useState } from 'react'
import type { ResolvedTheme } from '../../../shared/theme'

const QUERY = '(prefers-color-scheme: light)'

export function currentResolvedTheme(): ResolvedTheme {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
      ? 'light'
      : 'dark'
  } catch {
    return 'dark'
  }
}

export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(currentResolvedTheme)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(QUERY)
    const onChange = (): void => setTheme(mq.matches ? 'light' : 'dark')
    onChange()
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return theme
}
