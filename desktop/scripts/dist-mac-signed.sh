#!/usr/bin/env bash
#
# Build a SIGNED + NOTARIZED universal Orcha .dmg/.zip.
#
# Signing and notarization credentials are read from environment variables that
# this script loads from `.env.signing.local` (gitignored). Copy
# `.env.signing.example` to `.env.signing.local`, fill it in, then run:
#
#   ./scripts/dist-mac-signed.sh
#
# Notarization uploads the app to Apple and waits for their malware scan, so a
# clean run takes a few minutes and needs network access.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${SIGN_ENV_FILE:-.env.signing.local}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found." >&2
  echo "Copy .env.signing.example to .env.signing.local and fill in your credentials." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Sanity-check that the credential files actually exist before a long build.
for var in CSC_LINK APPLE_API_KEY; do
  path="${!var:-}"
  if [[ -z "$path" || ! -f "$path" ]]; then
    echo "error: $var points to a missing file: '${path:-<unset>}'" >&2
    exit 1
  fi
done

echo "Building signed + notarized universal Orcha app…"
npm run dist:mac

# --- Sign + notarize + staple the DMG itself --------------------------------
# electron-builder signs and notarizes the .app (and the .app inside the .zip),
# but it does NOT code-sign, notarize, or staple the .dmg *container*. Without
# this, a freshly-downloaded .dmg still trips Gatekeeper on mount ("Apple could
# not verify…") even though the app inside is fine. So we finish the DMG here.
DMG="$(ls -t dist/Orcha-*-universal.dmg 2>/dev/null | head -1)"
if [[ -z "$DMG" ]]; then
  echo "error: no universal .dmg found in dist/ after build." >&2
  exit 1
fi

# Discover the Developer ID Application identity from the keychain (don't hardcode).
SIGN_ID="$(security find-identity -v -p codesigning \
  | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
if [[ -z "$SIGN_ID" ]]; then
  echo "error: no 'Developer ID Application' identity in the keychain." >&2
  echo "Import the .p12 first:  security import \"\$CSC_LINK\" -P \"\$CSC_KEY_PASSWORD\"" >&2
  exit 1
fi

echo "Code-signing the DMG with: $SIGN_ID"
codesign --sign "$SIGN_ID" --timestamp "$DMG"

echo "Notarizing the DMG (waits for Apple's scan)…"
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" \
  --wait

echo "Stapling the notarization ticket to the DMG…"
xcrun stapler staple "$DMG"

echo ""
echo "Verifying Gatekeeper acceptance…"
spctl -a -vvv -t open --context context:primary-signature "$DMG"

echo ""
echo "Done. Signed + notarized artifacts in dist/:"
ls -1 dist/Orcha-*-universal.dmg dist/Orcha-*-universal-mac.zip 2>/dev/null
echo ""
echo "sha256 (for the Homebrew formula / release notes):"
shasum -a 256 dist/Orcha-*-universal.dmg dist/Orcha-*-universal-mac.zip 2>/dev/null
