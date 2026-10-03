#!/usr/bin/env bash
# Signs AND brands the dev Electron bundle.
# macOS refuses Notification Center registration for ad-hoc-signed binaries
# (UNErrorDomain error 1). The npm-distributed Electron.app is only
# linker/ad-hoc signed, so dev-mode notifications silently go nowhere until
# it's re-signed with a real identity. While we're at it, the bundle's icns
# is swapped for the Embodent icon (before signing — resources are sealed by
# the signature) so Dock + Notification Center show the Embodent icon in dev.
# Re-run after every npm install that touches the electron package. Packaged
# builds are signed properly and carry their own icon, so they don't need this.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../node_modules/electron/dist/Electron.app"

[ -d "$APP" ] || {
  echo "error: $APP not found — run npm install first (and" >&2
  echo "       'node node_modules/electron/install.js' if dist/ is missing)" >&2
  exit 1
}

IDENTITY="${1:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}')}"
[ -n "$IDENTITY" ] || {
  echo "error: no Apple Development codesigning identity found (pass one as \$1)" >&2
  exit 1
}

# Brand the dev bundle with the Embodent icon (resources are sealed by the
# signature, so this must happen BEFORE codesign). Gives Dock + Notification
# Center the Embodent icon in dev; packaged builds carry their own icon.
ICNS_SRC="$HERE/../resources/icon.icns"
ICNS_TARGET="$APP/Contents/Resources/electron.icns"
if [ -f "$ICNS_SRC" ] && [ -f "$ICNS_TARGET" ]; then
  # resources/icon.icns is pre-built (iconutil from an iconset rendered off icon.svg),
  # so copy it rather than converting icon.png here.
  cp "$ICNS_SRC" "$ICNS_TARGET"
  echo "branded $ICNS_TARGET with the Embodent mark"
fi

# The bold macOS app-menu title reads CFBundleName from Info.plist at launch —
# app.setName() can't reach it. Patch it (also sealed by the signature below).
PLIST="$APP/Contents/Info.plist"
# (Only the display name changes; the dev app's userData stays <appData>/Orcha —
# src/main/userDataPath.ts pins it.)
/usr/libexec/PlistBuddy -c "Set :CFBundleName Embodent" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Embodent" "$PLIST" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Embodent" "$PLIST"
echo "patched CFBundleName/CFBundleDisplayName -> Embodent"

echo "signing $APP with: $IDENTITY"
codesign --force --deep --sign "$IDENTITY" "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Authority|Signature" | head -3

# macOS caches app icons aggressively; nudge the caches (both respawn instantly).
killall Dock 2>/dev/null || true
killall NotificationCenter 2>/dev/null || true
