/**
 * Runtime loader for the vendored xterm assets. The portal already ships
 * /assets/vendor/xterm.js + addon-fit.js + xterm.css (the same FastAPI
 * /assets mount the vanilla pages used), so instead of bundling a SECOND copy
 * of xterm into the SPA we inject the vendored scripts once, promise-cached,
 * exactly as the vanilla <script src="/assets/vendor/…"> tags did — they set
 * window.Terminal / window.FitAddon (typed in ./xterm.d.ts).
 */

let loading: Promise<boolean> | null = null;

export function libsReady(): boolean {
  return typeof window.Terminal === "function";
}

// vanilla agents.html: <link rel="stylesheet" href="/assets/vendor/xterm.css">
function injectCss(): void {
  if (document.querySelector("link[data-orcha-xterm-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/assets/vendor/xterm.css";
  l.setAttribute("data-orcha-xterm-css", "1");
  document.head.appendChild(l);
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false; // preserve xterm.js -> addon-fit.js order
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

export function loadXtermAssets(): Promise<boolean> {
  // already loaded (or a test pre-stubbed window.Terminal) — nothing to fetch.
  if (libsReady()) {
    injectCss();
    return Promise.resolve(true);
  }
  if (!loading) {
    loading = (async () => {
      injectCss();
      try {
        await injectScript("/assets/vendor/xterm.js");
        // the fit addon is optional at runtime — the engine guards on
        // window.FitAddon just like vanilla terminal.js did.
        await injectScript("/assets/vendor/addon-fit.js");
      } catch {
        /* fall through to the readiness check */
      }
      const ok = libsReady();
      if (!ok) loading = null; // a later pair click retries instead of caching the failure
      return ok;
    })();
  }
  return loading;
}
