# Orcha Desktop

Electron + React + TypeScript stack manager for `orcha-*` Docker stacks:
see every stack on the machine (running or stopped), start/stop them, open
each stack's portal in an app window, and get tray + Notification Center
alerts when something needs the human (open requests, `needs_verification`
tasks, stacks going down).

Design spec: `../docs/superpowers/specs/2026-06-11-desktop-app-design.md`
(§9 covers the tray/notifications addendum). Tracking: Orcha#237.

## Dev quickstart

```bash
npm install
# If Electron fails to start with "Electron uninstall", the binary download
# was skipped during install:
node node_modules/electron/install.js
# Re-signs the dev Electron binary and brands it with the Orcha icon — needed
# for notifications and the dock/banner icon in dev (re-run after any npm
# install that touches electron):
./scripts/sign-dev-electron.sh
npm run dev            # add "-- --watch" to hot-restart main-process changes
```

`npm test` (vitest), `npm run typecheck`, `npm run build`.

## Onboarding & New Project

The app can provision a brand-new Orcha project end-to-end — no terminal, no
Homebrew, no `orcha` CLI. On first launch with **zero** `orcha-*` stacks the
onboarding wizard opens automatically; otherwise use **File → New Project**
(Cmd+N) or the **Create your first project** button on the empty manager.

The wizard runs Docker **preflight** (detects the daemon, auto-starts Docker
Desktop and polls if it's down), lets you pick a folder, then **provisions
natively** — it reimplements `orcha init`'s orchestration in the main process
(`src/main/initEngine.ts`) over template assets copied from the CLI at build
time into `resources/orcha-templates/` (`scripts/copy-orcha-templates.mjs`, run
by the `prebuild`/`predist` hooks; byte-parity enforced by
`templates.parity.test.ts`). It renders the compose file, lays down
migrations/portal/skills + a `.orcha/.env` secret, runs `docker compose up -d
--build`, waits for the portal, creates the container and registers the first
human, then hands off to the portal's `/onboarding` roster wizard. Host
notifier/bridge daemons are **not** started by the app (run `orcha up` in a
terminal if you need them). The same engine powers upgrade (ports preserved, no
data wipe) and reset-data (explicit `down -v` first).

### Onboarding (manual smoke — requires real Docker)

These cannot run in CI (they need a real Docker daemon and a packaged build):

1. With Docker running and zero `orcha-*` stacks, `npm run dev` → the wizard
   opens automatically. Preflight shows Docker ok → Continue → choose an empty
   folder → Create project. Watch the streamed compose-up log; on success the
   portal `/onboarding` window opens.
2. Stop Docker; relaunch `npm run dev` → preflight reports the daemon down and
   attempts to auto-start Docker, polling up to ~60s.
3. File → New Project (Cmd+N) on a folder that already has `.orcha/` →
   `inspectFolder` reports it initialized (no clobber).
4. `npm run dist:mac` → install the DMG → first launch with no stacks opens the
   wizard end-to-end (the bundled `orcha-templates` ship via `extraResources`).

## Dev-mode caveats

- The macOS app-menu title says "Electron" — it comes from the dev binary's
  Info.plist and becomes "Orcha" in the packaged build (see below).

## Packaging a distributable Mac app

Packaging is driven by [electron-builder](https://www.electron.build/),
configured in `electron-builder.yml` (appId `io.openorcha.desktop`,
productName `Orcha`, the `orcha://` deep-link protocol, and the app icon).

```bash
npm install
./scripts/dist-mac-signed.sh   # signed + notarized universal .dmg + .zip
# or, for a faster local build that only targets this machine's arch:
npm run dist:mac:arm64
```

`dist-mac-signed.sh` loads signing credentials from `.env.signing.local` and
then runs `npm run dist:mac` (universal Intel + Apple Silicon). Running
`npm run dist:mac` directly works too, but only signs/notarizes if those
environment variables are already set.

Outputs land in `desktop/dist/` (gitignored):

- `Orcha-<version>-universal.dmg` — drag-to-Applications installer
- `Orcha-<version>-universal-mac.zip` — zip of `Orcha.app` (used by the
  Homebrew cask/formula)

The version comes from `package.json`'s `version` field — bump it there before
a release and tag the matching `vX.Y.Z` on the GitHub Release.

**Signing & notarization:** release builds are **signed with a Developer ID
Application certificate and notarized by Apple**, so Gatekeeper opens the app on
a normal double-click — no right-click→Open and no `xattr` quarantine
workaround. This is configured in `electron-builder.yml` (`hardenedRuntime`,
`entitlements`, `notarize: true`).

Credentials are supplied through environment variables and are **never
committed**:

- `CSC_LINK` / `CSC_KEY_PASSWORD` — the Developer ID `.p12` and its password.
- `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` — an App Store
  Connect API key used by `notarytool`.

Copy `.env.signing.example` to `.env.signing.local` (gitignored), fill in the
paths, and build via `./scripts/dist-mac-signed.sh`. Notarization uploads the
app to Apple's notary service and waits for the malware scan, so a clean build
takes a few minutes and needs network access.

## Desktop widget

`widget/` is a native macOS WidgetKit widget (systemSmall + systemMedium)
showing per-stack attention counts on the desktop / Notification Center. It is
an XcodeGen project: a tiny SwiftUI host app (`OrchaWidgets.app`) embedding the
`OrchaStatusWidget` extension.

Build + install (requires Xcode and an Apple Development identity for the
team in `project.yml`'s `DEVELOPMENT_TEAM` in the keychain):

```bash
cd widget
xcodegen generate
xcodebuild -project OrchaWidgets.xcodeproj -scheme OrchaWidgets \
  -configuration Release -derivedDataPath build \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Development" build
mkdir -p ~/Applications
rm -rf ~/Applications/OrchaWidgets.app
ditto build/Build/Products/Release/OrchaWidgets.app ~/Applications/OrchaWidgets.app
open ~/Applications/OrchaWidgets.app   # launch once so the widget registers
```

(If "Apple Development" is ambiguous because the keychain holds identities for
several teams, pass the team's certificate SHA-1 from
`security find-identity -v -p codesigning` as `CODE_SIGN_IDENTITY` instead.)

Then add it from the gallery: right-click the desktop → Edit Widgets → search
"Orcha".

**Data bridge:** the Electron app's attention poller writes
`~/Library/Group Containers/N2597TV587.orcha/status.json` (schema v3:
stacks with agent rosters incl. model + current task, pipeline task counts,
and the attention item list — see `src/main/statusFile.ts`);
the sandboxed widget reads it via the shared app group `N2597TV587.orcha`.
macOS requires the group id to be prefixed with the signing cert's REAL
TeamIdentifier (the certificate's OU field) — note this can differ from the
team id the cert's display name shows, which cost us a debugging session.
Keep the Orcha desktop app running — the widget shows OFFLINE when the file is
older than 2 minutes.

**Caveats:** WidgetKit refreshes the timeline roughly every 5 minutes, so the
widget can lag the tray by a few minutes. The build is dev-signed (Apple
Development); proper Developer ID signing lands with the packaging pipeline
(#238).
