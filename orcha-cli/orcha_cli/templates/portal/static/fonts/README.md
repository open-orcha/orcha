# Portal fonts

Self-hosted, subset/variable woff2 files served from `/assets/fonts/`. No
third-party font requests at runtime (offline/air-gapped friendly, no
render-blocking cross-origin round trip).

| File(s) | Family | Used by | License |
|---|---|---|---|
| `inter-latin.woff2`, `inter-latin-ext.woff2` | Inter | default (classic) skin body text | SIL OFL 1.1 |
| `jetbrains-mono-latin.woff2`, `jetbrains-mono-latin-ext.woff2` | JetBrains Mono | code / terminal / ids, all skins | Apache 2.0 |
| `space-grotesk-latin.woff2`, `space-grotesk-latin-ext.woff2` | Space Grotesk | `[data-skin="swiss"]` body text | SIL OFL 1.1 |
| `hanken-grotesk-var.woff2` | Hanken Grotesk | `[data-skin="minimal"]` body text | SIL OFL 1.1 — see `OFL-hanken-grotesk.txt` |

`hanken-grotesk-var.woff2` is the same variable instance already shipped for
the marketing welcome page (`deploy/auth/welcome/fonts/hanken-var.woff2`),
copied here so the portal app can self-host it independently of that page's
build. Full license text: `OFL-hanken-grotesk.txt`.
