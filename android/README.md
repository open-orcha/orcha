# Orcha Android

Native Android companion for a local Orcha stack.

This first slice is intentionally read-only and uses only endpoints that exist in
the running Orcha `/openapi.json`:

- `GET /api/containers`
- `GET /api/containers/{cid}`
- `GET /api/tasks/{tid}/messages`

QR pairing, auth, and write actions are not faked here. They should land only
after the server exposes those contracts.

## Build

```bash
cd android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

The debug APK is written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```
