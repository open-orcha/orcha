/**
 * Minimal ambient types for the VENDORED xterm.js + fit addon
 * (static/vendor/xterm.js, served at /assets/vendor/xterm.js). The library is
 * loaded at runtime as a classic script that sets window.Terminal /
 * window.FitAddon — it is NOT an npm dependency, so we type only the surface
 * the OrchaTerm engine actually touches.
 */
interface XTermSize {
  cols: number;
  rows: number;
}

interface XTermTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
}

interface XTermOptions {
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  convertEol?: boolean;
  scrollback?: number;
  theme?: XTermTheme;
}

interface XTermTerminal {
  cols: number;
  rows: number;
  open(parent: HTMLElement): void;
  write(data: string): void;
  dispose(): void;
  loadAddon(addon: unknown): void;
  onData(handler: (data: string) => void): unknown;
  onResize(handler: (size: XTermSize) => void): unknown;
}

interface XTermFitAddon {
  fit(): void;
}

interface Window {
  Terminal?: new (options?: XTermOptions) => XTermTerminal;
  FitAddon?: { FitAddon: new () => XTermFitAddon };
}
