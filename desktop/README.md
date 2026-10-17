# Orcha Desktop

Electron + React + TypeScript manager for the Orcha projects on this Mac: see
every project (running or stopped), start/stop it, open its portal in an app
window, and get tray + Notification Center alerts when something needs the human
(plan approvals, `needs_verification` tasks, requests open to a human or
escalated, projects going down). Since GH #258 projects run **natively** (no
Docker, no Postgres): the app brings its own Python + `orcha` CLI and drives the
CLI for everything. Older Docker projects still show up (when Docker is running)
and can be moved off Docker from Home.

Design spec: `../docs/superpowers/specs/2026-06-11-desktop-app-design.md`
(§9 covers the tray/notifications addendum). Tracking: Orcha#237.

## Dev quickstart

```bash
npm install
# If Electron fails to start with "Electron uninstall", the binary download
# was skipped during install:
node node_modules/electron/install.js
# Re-signs the dev Electron binary and brands it with the Embodent icon — needed
# for notifications and the dock/banner icon in dev (re-run after any npm
# install that touches electron):
./scripts/sign-dev-electron.sh
npm run dev            # add "-- --watch" to hot-restart main-process changes
```

`npm test` (vitest), `npm run typecheck`, `npm run build`.

## Window layout (Orcha V2)

The window has a persistent host-owned **left sidebar** (every local project across all
stacks, "Needs you", the open project's sections and live agents, stack start/stop) with the
open project's portal in a native `WebContentsView` to its right. Portals get a dedicated,
origin-checked preload (`src/preload/portal.ts` → `window.orchaHost`) and a typed message
contract (`src/shared/embed.ts`); a V2 portal answers `ready` and renders header + content
only. An older portal that doesn't answer within 3 s gets the pre-V2 layout (slim top bar,
no host sidebar). Details: `../docs/orcha-v2-architecture.md` → "Desktop host (Agent C)".

"Needs you" counts decisions only — plan approvals (autonomy `plan`), verifications (unless
autonomy `full`) and requests open to a human or escalated. Follow-ups (answered requests you
raised) are listed in the tray but never counted.

## Onboarding & New Project

On first launch with no projects the onboarding wizard opens; otherwise use
**File → New Project** (Cmd+N) or **Create your first project** on Home. Setup
needs only an AI coding agent (Claude Code or Codex) — no Homebrew, no Docker, no
Python: the `orcha` helper ships inside the app.

**How the app finds `orcha`** (`src/main/hostWorker.ts` `resolveOrcha`):
1. the bundled runtime, `Orcha.app/Contents/Resources/orcha-runtime/bin/orcha`;
2. `~/.local/bin/orcha`;
3. `orcha` on the host-tool PATH (dev builds).

On launch a packaged app links `~/.local/bin/orcha` to the bundled launcher
(`src/main/orchaLink.ts`) unless a different `orcha` is already there, so
developers get the same CLI in Terminal. `orcha update` inside the bundled
runtime only says to update the app — an app update is a CLI update.

**Provisioning is the CLI's job.** `src/main/initEngine.ts` is a thin driver:
- new project → `orcha init --runtime native --progress-json …`, whose JSON
  progress lines become the wizard's steps;
- reconnect an existing project → `orcha up`;
- "Move this project off Docker" (Home card) → `orcha migrate-runtime --json`
  (Docker must be on once, to copy the data out; the Docker copy is kept).

Project discovery (`src/main/nativeStacks.ts` + `discovery.ts`) reads the CLI's
registry (`~/.orcha/stacks.json`) and each project's `.orcha/state.json`, plus
`<userData>/native-projects.json` so a project stopped with `orcha down` stays
listed. `docker ps` is only asked about older Docker projects; a Mac without
Docker never hears about it. Reset = `orcha down -v --yes` + `orcha service
uninstall` (`src/main/resetEngine.ts`).

### Manual smoke checklist (packaged arm64 build)

CI cannot see these. Run them on the signed DMG and record the result in the PR:

1. `spctl -a -vv /Applications/Orcha.app` → `accepted`, `source=Notarized
   Developer ID`; `xcrun stapler validate` on the DMG passes.
2. `codesign -dv --verbose=4` on
   `Orcha.app/Contents/Resources/orcha-runtime/bin/python3` and on one `.so`
   under `lib/python3.*/site-packages` → `flags=0x10000(runtime)` (hardened).
3. `Orcha.app/Contents/Resources/orcha-runtime/bin/orcha --version` runs with an
   empty `PATH` (no system Python needed).
4. **Clean macOS account** (no Homebrew, Docker or Python): first open shows one
   Gatekeeper "downloaded from the internet" dialog, nothing else. The wizard asks
   only for an AI agent; pick an empty folder → Create project → the portal opens.
5. After that first launch, `~/.local/bin/orcha` points into `Orcha.app`, and
   `orcha status` in Terminal lists the project.
6. Quit the app → the project's portal still answers (agents keep running under
   the project's launchd service). Reboot → it is back without opening the app.
7. Stop / Start the project from Home → it stays listed while stopped.
8. With a Docker project and Docker running → Home shows "Move … off Docker";
   do it on a **throwaway copy** → the project comes back native with its data.
9. Reset a throwaway native project → its `.orcha/` data and service are gone,
   your own files are untouched.

## Dev-mode caveats

- The macOS app-menu title says "Electron" — it comes from the dev binary's
  Info.plist and becomes "Orcha" in the packaged build (see below).

## Packaging a distributable Mac app

Packaging is driven by [electron-builder](https://www.electron.build/),
configured in `electron-builder.yml` (appId `io.openorcha.desktop`,
productName `Orcha`, the `orcha://` deep-link protocol, and the app icon). The
release build is **Apple Silicon only** (GH #258; Intel later).

```bash
npm install
./scripts/dist-mac-signed.sh          # signed + notarized arm64 .dmg + .zip
# unsigned local build for this machine:
npm run dist:mac:arm64
```

`predist:mac:arm64` runs `scripts/build-orcha-runtime.mjs`: it downloads a
pinned `python-build-standalone` (URL + sha256 in the script), pip-installs the
repo's `orcha-cli` into it, strips what a runtime doesn't need, and writes the
`bin/orcha` launcher (`ORCHA_SIDECAR=1`) into `resources/orcha-runtime/`
(gitignored). electron-builder ships it as `Contents/Resources/orcha-runtime`
(`extraResources`) and signs every nested Mach-O with the hardened runtime.
`npm run dist:mac` (universal) still exists for a future Intel build but carries
no runtime — that build needs `orcha` from elsewhere.

`dist-mac-signed.sh` loads signing credentials from `.env.signing.local`, runs
the build, then signs the DMG. Outputs land in `desktop/dist/` (gitignored):

- `Orcha-<version>-arm64.dmg` — drag-to-Applications installer
- `Orcha-<version>-arm64-mac.zip` — zip of `Orcha.app`

The version comes from `package.json`'s `version` field — bump it in the same PR
as the feature.

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
app to Apple's notary service and waits for the malware scan (about 4 minutes
for the app and 3–4 for the DMG with the runtime inside), so it needs network
access.

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
