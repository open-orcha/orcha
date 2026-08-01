# Vendored fonts (self-hosted, seamless-nav)

Pinned, committed woff2 font binaries served by the portal — replaces the render-blocking
`fonts.googleapis.com`/`fonts.gstatic.com` cross-origin stylesheet round trip with same-origin,
offline/CSP-safe assets (see `styles/fonts.css`). Same vendoring convention as
`static/vendor/README.md`.

All three families are licensed under the **SIL Open Font License 1.1** — the full license
text plus each family's copyright notice is in `OFL.txt` alongside this file. Per OFL §2, that
notice + license text must travel with the font files; see also the credit line at the top of
`styles/fonts.css`.

| File | Family | Subset | Weight range | Designer | Source | License |
|---|---|---|---|---|---|---|
| `inter-latin.woff2` | Inter | latin | 400–800 (variable) | Rasmus Andersson | `https://fonts.googleapis.com/css2?family=Inter:wght@400..800` (css2 API, latin subset) | OFL-1.1 |
| `inter-latin-ext.woff2` | Inter | latin-ext | 400–800 (variable) | Rasmus Andersson | `https://fonts.googleapis.com/css2?family=Inter:wght@400..800` (css2 API, latin-ext subset) | OFL-1.1 |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | latin | 400–700 (variable) | JetBrains s.r.o. | `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..700` (css2 API, latin subset) | OFL-1.1 |
| `jetbrains-mono-latin-ext.woff2` | JetBrains Mono | latin-ext | 400–700 (variable) | JetBrains s.r.o. | `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..700` (css2 API, latin-ext subset) | OFL-1.1 |
| `space-grotesk-latin.woff2` | Space Grotesk | latin | 400–700 (variable) | Florian Karsten | `https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400..700` (css2 API, latin subset) | OFL-1.1 |
| `space-grotesk-latin-ext.woff2` | Space Grotesk | latin-ext | 400–700 (variable) | Florian Karsten | `https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400..700` (css2 API, latin-ext subset) | OFL-1.1 |

Each file is a genuine variable-font instance (verified against its `fvar` table) covering the
weight range `styles/fonts.css` declares — no synthetic-bold risk from a wrong-UA css2 fetch
silently yielding a static 400 weight.

**Upstream project repos** (for future re-fetch / version bump):
- Inter — https://github.com/rsms/inter
- JetBrains Mono — https://github.com/JetBrains/JetBrainsMono
- Space Grotesk — https://github.com/floriankarsten/space-grotesk

**To upgrade:** re-fetch each subset from the pinned css2 URL above with a modern-browser UA
(a stale/bot UA gets a non-variable fallback), verify the `fvar` axis still covers the declared
weight range, replace the file, and re-test the portal's font rendering (Inter body text,
JetBrains Mono `code`/`.mono`, Space Grotesk under the Swiss skin). New static files require
`orcha upgrade` (not just `orcha up`) to deploy — same as `static/vendor/README.md`'s note.
