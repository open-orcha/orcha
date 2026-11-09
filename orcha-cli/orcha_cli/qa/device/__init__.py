"""The QA device layer: drive a booted iOS simulator (idb) or an Android emulator (uiautomator2).

- `tree`, `targets`, `locks`: standard library only.
- `screen`, `base`: PIL is imported inside the functions that need it.
- `ios`, `android` (and their drivers `ios_idb`, `android_u2`): need the `qa` extra
  (`orcha-cli[qa]`) when a session actually starts.

Nothing is imported here: `import orcha_cli.qa.device` stays free of heavy dependencies.
"""
