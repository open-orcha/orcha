# Flow 03 — QR Pairing (portal → phone)

Mockups: [`../mockups/03-pairing.html`](../mockups/03-pairing.html)

> **Status: requires NEW backend + portal work.** Nothing in `/openapi.json` today serves pairing —
> no QR endpoint, no mobile token issuance, no auth on the API at all. Every new ask is consolidated
> in [doc 13](../13-api-asks.md); this spec defines the UX contract both sides build to.

## 1. Story

The portal (running on the laptop) shows a QR code for the live container. The QR encodes the
container's **reachable** base URL — the laptop's LAN IP, never `localhost` — plus enough for the
phone to authenticate. The user scans it from the app; the container appears on the phone's
Containers home; from then on the phone sees everything in that container.

## 2. Portal side (new portal work)

**Entry point:** a "Pair phone" button in the portal header (next to the theme toggle) and a row in
portal Settings → shows a modal.

Modal spec (see mockup, frame P1):
- Title "Pair your phone", subtitle explaining: *scan with the Orcha app on the same Wi-Fi network*.
- QR code (≥280×280 px, quiet zone, `M` error correction) rendering the payload below.
- Under the QR: the human-readable URL it encodes (e.g. `http://192.168.1.24:8001`) so users can
  debug connectivity, and the pairing-code expiry countdown ("expires in 4:58 — regenerates
  automatically").
- Footnote: "Your phone talks directly to this computer on your network. Nothing goes through the
  cloud."
- If the server cannot determine a LAN IP (or is bound to localhost only) the modal shows the
  warn state (frame P2): explanation + "use `orcha up --host 0.0.0.0`"-style remedy from the CLI docs.

**Payload (proposed, final shape owned by backend — doc 13, ask A1/A2):**

```json
{
  "v": 1,
  "kind": "orcha-pair",
  "baseUrl": "http://192.168.1.24:8001",
  "containerId": "e720c233-…",
  "containerName": "openorcha",
  "humanAgentId": "98cda2bc-…",
  "token": "<short-lived pairing secret, exchanged for a long-lived device token>",
  "expiresAt": "2026-07-01T21:40:00Z"
}
```

`humanAgentId` is required because every mutating API call carries an actor id — the phone acts as
the paired human. If multiple humans are registered the modal shows a "pair as" picker first.

## 3. App side

### Screens & states (mockup frames)

| Frame | Screen | Notes |
|---|---|---|
| A1/I1 | Scanner (Android/iOS) | full-screen camera, viewfinder bracket, torch toggle, "Scan the QR from your Orcha portal" hint, manual-entry fallback link |
| A2/I2 | Camera permission denied | state layout with "Open Settings" action + manual entry fallback |
| I3 | Confirm screen | parsed payload → container name, host, "pair as <human name>"; big **Connect** button. Probes the server before enabling (spinner → reachable ✓ / unreachable ✕) |
| I4 | Success | checkmark moment, then auto-push to the new container workspace (Home tab) |
| A3 | Failure: unreachable | phone can't reach `baseUrl` (different Wi-Fi, firewall): explanation + "Both devices on the same Wi-Fi?" checklist + Retry |
| I5 | Failure: expired/invalid QR | re-scan CTA |
| A4 | Manual entry | fallback: URL + pairing code fields (same validation path) |
| — | iOS: local-network permission denied | distinct from A3 (see Platform notes) — copy names the OS permission and deep-links to app Settings; no mockup frame yet, same `.state` layout as A2/I2 |

### Behavior

- **Scan → parse:** reject payloads without `kind:"orcha-pair"` (frame I5 copy: "That's not an
  Orcha pairing code").
- **Probe:** `GET {baseUrl}/api/containers/{containerId}` with 3s timeout. v1 ships against the
  current unauthenticated API; when ask A2 (token exchange) lands, this becomes
  `POST {baseUrl}/api/pair` with the pairing token → device token. The confirm screen's Connect
  button is disabled until the probe succeeds.
- **Store:** container record `{baseUrl, containerId, name, humanAgentId, deviceToken?}` in
  Keychain (iOS) / EncryptedSharedPreferences (Android). Re-pairing an already-paired container
  updates it in place (no duplicates; match on `containerId`).
- **Multi-container:** repeat from Containers home → Add. Each container is fully independent
  (own base URL, own SSE connection when open).

### Platform notes

- **Android:** scanner is a full-screen destination (predictive back to Containers home); ML Kit
  barcode scanning; permission flow uses the M3 rationale dialog. Manual entry is a plain screen.
- **iOS:** scanner presented as a full-height **sheet** over Containers home (`DataScannerViewController`
  / AVFoundation); confirm is a pushed step inside the sheet's own navigation; success dismisses the
  sheet and the new container card animates in. Permission denial deep-links to app Settings.
- **iOS local-network prompt:** the confirm screen's first probe of a LAN IP triggers the iOS 14+
  "allow local network access" system prompt. The flow must expect it: confirm-screen copy warns
  "iOS will ask for local network access — tap Allow", the app ships
  `NSLocalNetworkUsageDescription` copy, and a denial surfaces as its own failure state (table row
  above) — **not** A3 "unreachable" — because every container call fails identically after a deny
  and it would otherwise masquerade as a Wi-Fi/firewall problem. Recovery is Settings deep-link,
  not Retry.

## 4. Security callouts (design position — decisions belong to the team, doc 13)

- The QR ferries a **secret**; the portal modal must only render it on explicit user action (never
  auto-open), and regenerating invalidates prior codes.
- v1 reality check: today the API has **no auth layer at all**, so the token field is forward-looking.
  Shipping the app against an unauthenticated LAN API is a real security decision that needs an
  explicit team call — flagged as **A2** in doc 13, together with HTTPS/self-signed-cert questions
  (plain HTTP on LAN vs. provisioning a cert).
- The HTTP-vs-TLS choice is **one decision with the transport exceptions both apps must ship**:
  the base URL is a runtime LAN IP (no fixed domain), so iOS needs `NSAllowsLocalNetworking`
  (or broader) in ATS and Android needs a cleartext-traffic allowance in its network security
  config (scoped narrowly, not app-wide). Detailed in doc 13 §A2.

## 5. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| Validate/probe after scan | `GET /api/containers/{cid}` | exists |
| Pairing QR content + token issue | `GET /api/containers/{cid}/pairing` (proposed) | **NEW — ask A1** |
| Token exchange (device auth) | `POST /api/pair` (proposed) | **NEW — ask A2** |
| List humans for "pair as" picker | `GET /api/snapshot/{cid}` (agents where kind=human) | exists |
