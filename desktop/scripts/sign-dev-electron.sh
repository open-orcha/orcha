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
PLIST="$APP/Contents/Info.plist"
if [ -f "$ICNS_SRC" ]; then
  # resources/icon.icns is pre-built (iconutil from an iconset rendered off icon.svg),
  # so copy it rather than converting icon.png here. It ships under its own name (not
  # electron.icns): macOS icon services cache by bundle + icon file, and a stale cached
  # Electron atom for electron.icns survives a content swap. The name carries the icns
  # hash so a future mark change is a new file again.
  ICNS_NAME="embodent-$(md5 -q "$ICNS_SRC" | cut -c1-8).icns"
  rm -f "$APP"/Contents/Resources/embodent-*.icns
  cp "$ICNS_SRC" "$APP/Contents/Resources/$ICNS_NAME"
  cp "$ICNS_SRC" "$APP/Contents/Resources/electron.icns"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile $ICNS_NAME" "$PLIST"
  echo "branded $APP with the Embodent mark ($ICNS_NAME)"
fi

# The bold macOS app-menu title reads CFBundleName from Info.plist at launch —
# app.setName() can't reach it. Patch it (also sealed by the signature below).
# (Only the display name changes; the dev app's userData stays <appData>/Orcha —
# src/main/userDataPath.ts pins it.)
/usr/libexec/PlistBuddy -c "Set :CFBundleName Embodent" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Embodent" "$PLIST" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Embodent" "$PLIST"
echo "patched CFBundleName/CFBundleDisplayName -> Embodent"

# Give the dev bundle (and its helpers) its own bundle id. Notification Center keys an
# app's icon by bundle id, and every npm Electron.app on this Mac shares
# com.github.Electron — so notifications kept showing whatever icon was cached for that
# id (another project's, or an old Embodent mark) no matter what icns we ship.
# Keychain side effect: the new id + signature is a different app identity to macOS, so the
# existing "Embodent Safe Storage" item (Settings › API keys) no longer trusts it. The first
# save/apply of an API key after an identity change asks for your LOGIN PASSWORD (not just
# Allow) — once per identity change. Enter it and choose "Always Allow" and it won't ask again.
DEV_ID="io.openorcha.desktop.dev"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $DEV_ID" "$PLIST"
for HP in "$APP"/Contents/Frameworks/*.app/Contents/Info.plist; do
  OLD_ID="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$HP")"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${OLD_ID/com.github.Electron/$DEV_ID}" "$HP"
done
echo "patched CFBundleIdentifier -> $DEV_ID (+ helpers)"

echo "signing $APP with: $IDENTITY"
codesign --force --deep --sign "$IDENTITY" "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Authority|Signature" | head -3

# Register the re-identified bundle, then nudge the icon caches (all respawn instantly;
# usernoted is the daemon that caches each app's notification icon).
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" || true
killall Dock 2>/dev/null || true
killall NotificationCenter 2>/dev/null || true
killall usernoted 2>/dev/null || true
killall iconservicesagent 2>/dev/null || true
