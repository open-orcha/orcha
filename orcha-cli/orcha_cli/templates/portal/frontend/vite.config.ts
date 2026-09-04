import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Build lands in ../static/dist so the EXISTING FastAPI /assets mount
// (main.py: app.mount("/assets", StaticFiles(static/))) serves the bundle at
// /assets/dist/* with zero backend changes — the strangler-fig seam of the
// React migration (docs/orcha-portal-react-migration-plan.md).
// dev-only: serve the SPA shell at the portal's clean page routes, mirroring
// the FastAPI page routes (main.py) so BrowserRouter URLs work under `npm run dev`.
const PAGE_ROUTES = ["/", "/tasks", "/agents", "/requests", "/settings", "/onboarding"];
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
const sharedCssPlugin = () => ({
  name: "orcha-shared-css",
  transformIndexHtml: {
    order: "post" as const,
    handler(html: string) {
      return html.replace("</head>", '  <link rel="stylesheet" href="/assets/styles.css" />\n  </head>');
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
      "/api": process.env.ORCHA_PORTAL || "http://localhost:8000",
      "^/assets/(?!dist/)": process.env.ORCHA_PORTAL || "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
