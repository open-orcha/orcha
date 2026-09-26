# Orcha portal — React frontend

React 18 + TypeScript + Vite rewrite of the portal pages (strangler-fig plan:
`docs/orcha-portal-react-migration-plan.md`). The FastAPI backend is untouched;
this app consumes the same `/api` contract the vanilla pages use.

## This IS the portal

Since Phase 7 (see the plan doc) the FastAPI page routes (`/`, `/tasks`,
`/agents`, `/requests`, `/settings`, `/onboarding`) serve this app's built
shell from `../static/dist/` — BrowserRouter owns the paths client-side, so
every classic deep link (`/tasks?task=<id>`…) keeps its exact URL. The old
vanilla pages are deleted; `../static/styles.css` (the shared token layer)
and `../static/vendor/` (xterm) still ship as-is.

## Develop

```bash
npm install
npm run dev        # Vite dev server with HMR at the same clean page routes;
                   # proxies /api + /assets to a running portal
                   # (default http://localhost:8000, override ORCHA_PORTAL=)
npm test           # Vitest + @testing-library
npm run build      # typecheck + build → ../static/dist (commit the output:
                   # the template ships pre-built so image builds need no node)
```

After rebuilding, redeploy the portal image as usual (`docker compose build
portal && up -d` — the image bakes static files).
