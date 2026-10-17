# Portal fonts

Self-hosted, subset/variable woff2 files served from `/assets/fonts/`. No
third-party font requests at runtime (offline/air-gapped friendly, no
render-blocking cross-origin round trip).

| File(s) | Family | Used by | License |
|---|---|---|---|
| `inter-var-opsz-latin.woff2`, `inter-var-opsz-latin-ext.woff2`, `inter-var-opsz-latin-italic.woff2` | **Inter Variable** (wght 100–900 + opsz 14–32) | Orcha V2 UI (`--v2-font-sans`, @font-face in `styles/v2-tokens.css`; latin preloaded in `frontend/index.html`) | SIL OFL 1.1 — see `OFL-inter.txt` |
| `inter-latin.woff2`, `inter-latin-ext.woff2` | Inter (wght only) | legacy fallback family `"Inter"` (fonts.css) | SIL OFL 1.1 — see `OFL-inter.txt` |
| `jetbrains-mono-latin.woff2`, `jetbrains-mono-latin-ext.woff2` | JetBrains Mono | code / terminal / ids, all skins | Apache 2.0 |
| `space-grotesk-latin.woff2`, `space-grotesk-latin-ext.woff2` | Space Grotesk | `[data-skin="swiss"]` body text | SIL OFL 1.1 |
| `hanken-grotesk-var.woff2` | Hanken Grotesk | `[data-skin="minimal"]` body text | SIL OFL 1.1 — see `OFL-hanken-grotesk.txt` |

`hanken-grotesk-var.woff2` is the same variable instance already shipped for
the marketing welcome page (`deploy/auth/welcome/fonts/hanken-var.woff2`),
copied here so the portal app can self-host it independently of that page's
build. Full license text: `OFL-hanken-grotesk.txt`.

`inter-var-opsz-*.woff2` are the unmodified `files/inter-{latin,latin-ext}-opsz-normal.woff2`
and `files/inter-latin-opsz-italic.woff2` from `@fontsource-variable/inter@5.3.0` (rsms Inter
4.x, opsz build). Update by `npm pack @fontsource-variable/inter` and copying the same three
files; keep the names (index.html preloads the latin one). Full license: `OFL-inter.txt`.
The desktop renderer should load these same files (D6).
