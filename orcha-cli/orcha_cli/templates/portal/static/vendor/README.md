# Vendored front-end libraries

Pinned, committed third-party assets served by the portal (CSP/offline-safe — no runtime CDN).
Used by the S3 embedded terminal panel (`terminal.js`).

| File | Package | Version | Source | License |
|---|---|---|---|---|
| `xterm.js` | `@xterm/xterm` | 5.5.0 | https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js | MIT |
| `xterm.css` | `@xterm/xterm` | 5.5.0 | https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css | MIT |
| `addon-fit.js` | `@xterm/addon-fit` | 0.10.0 | https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js | MIT |

UMD bundles — loaded via `<script src="/assets/vendor/...">` they expose `window.Terminal`
and `window.FitAddon.FitAddon`. To upgrade: re-fetch the pinned URL above, bump the version,
and re-test the terminal panel. New static files require `orcha upgrade` (not just `orcha up`)
to deploy.
