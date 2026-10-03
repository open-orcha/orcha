import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Build lands in ../static/dist so the EXISTING FastAPI /assets mount
// (main.py: app.mount("/assets", StaticFiles(static/))) serves the bundle at
// /assets/dist/* with zero backend changes — the strangler-fig seam of the
// React migration (docs/orcha-portal-react-migration-plan.md).
// dev-only: serve the SPA shell at the portal's clean page routes, mirroring
// the FastAPI page routes (main.py) so BrowserRouter URLs work under `npm run dev`.
// Keep in sync with portal_backend/dashboard_routes.py (+ main.py /onboarding,
// device_token_routes.py /auth/device). GAP-09: the dev list used to omit
// several served routes; V2 adds /needs and /activity.
export const PAGE_ROUTES = [
  "/", "/tasks", "/agents", "/requests", "/settings", "/onboarding",
  "/projects", "/code", "/metrics", "/github", "/members", "/auth/device",
  "/needs", "/activity", "/org", "/routines",
];
const pageRoutesPlugin = () => ({
  name: "orcha-page-routes",
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      const [path, q] = (req.url || "").split("?");
      if (PAGE_ROUTES.includes(path)) req.url = "/assets/dist/index.html" + (q ? "?" + q : "");
      next();
    });
  },
});

// Inject the shared stylesheet as a render-blocking <link> into the BUILT
// shell. It must bypass Vite's base-prefixing (which is why main.tsx used
// runtime injection), so we string-insert post-transform.
// D6: preload the latin Inter file at the SAME URL static/styles/v2-tokens.css
// @font-face uses. Injected post-transform (like styles.css) so Vite dev never
// rebases it under /assets/dist/ (that made dev download the font twice).
export const FONT_PRELOAD =
  '<link rel="preload" href="/assets/fonts/inter-var-opsz-latin.woff2" as="font" type="font/woff2" crossorigin />';

// Favicons + the PWA manifest (Embodent icons) live in static/ (served at /assets/*). Injected post-transform for
// the same reason: a <link href="/assets/..."> in index.html is rebased under
// /assets/dist/ by Vite dev, where it 404s to the SPA shell.
export const FAVICON_LINKS = [
  '<link rel="icon" href="/assets/favicon.ico" sizes="48x48" />',
  '<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />',
  '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />',
  '<link rel="manifest" href="/assets/manifest.json" />',
];

const sharedCssPlugin = () => ({
  name: "orcha-shared-css",
  transformIndexHtml: {
    order: "post" as const,
    handler(html: string) {
      return html.replace(
        "</head>",
        FAVICON_LINKS.map((l) => "  " + l + "\n").join("") +
          "  " + FONT_PRELOAD + '\n  <link rel="stylesheet" href="/assets/styles.css" />\n  </head>',
      );
    },
  },
});

export default defineConfig({
  plugins: [react(), pageRoutesPlugin(), sharedCssPlugin()],
  base: "/assets/dist/",
  build: {
    outDir: "../static/dist",
    emptyOutDir: true,
  },
  server: {
    // dev-mode convenience: proxy API/SSE + the shared stylesheet to a locally
    // running portal (override with ORCHA_PORTAL=http://host:port). /assets/dist
    // is excluded — that's this app's own build output.
    proxy: {
      // ws: dictation streams audio over a WebSocket (/api/containers/{cid}/voice/stream)
      "/api": { target: process.env.ORCHA_PORTAL || "http://localhost:8000", ws: true },
      "^/assets/(?!dist/)": process.env.ORCHA_PORTAL || "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
