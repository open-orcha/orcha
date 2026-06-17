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

## Dev-mode caveats

- The macOS app-menu title says "Electron" — it comes from the dev binary's
  Info.plist and becomes "Orcha" in the packaged build (see below).

## Packaging a distributable Mac app

Packaging is driven by [electron-builder](https://www.electron.build/),
configured in `electron-builder.yml` (appId `io.openorcha.desktop`,
productName `Orcha`, the `orcha://` deep-link protocol, and the app icon).

```bash
npm install
npm run dist:mac          # universal (Intel + Apple Silicon) .dmg + .zip
# or, for a faster local build that only targets this machine's arch:
npm run dist:mac:arm64
```

Outputs land in `desktop/dist/` (gitignored):

- `Orcha-<version>-universal.dmg` — drag-to-Applications installer
- `Orcha-<version>-universal-mac.zip` — zip of `Orcha.app` (used by the
  Homebrew cask/formula)

The version comes from `package.json`'s `version` field — bump it there before
a release and tag the matching `vX.Y.Z` on the GitHub Release.

**Signing:** builds are currently **ad-hoc (unsigned)** — `mac.identity` is
`null` in `electron-builder.yml`, so no Apple Developer ID is required.
Gatekeeper will warn on first open; users either right-click the app →
**Open**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Orcha.app
```

When a Developer ID certificate is available, set the identity in
`electron-builder.yml` and add notarization to ship a Gatekeeper-clean build.

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
