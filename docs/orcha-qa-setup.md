# Orcha QA: setup (iOS, Android and web)

Orcha QA lets a project's agents map an app, explore it, draft QA scenarios and check approved
ones on an iOS simulator, an Android emulator or a headless Chromium browser. Nothing else to
install beyond the table below. Design and contract: `docs/orcha-qa-plan.md`.

| Part | Needed for | Install |
|---|---|---|
| `orcha-cli[qa]` | the tool server (`orcha qa mcp`), device drivers | `uv tool install --force --reinstall --no-cache './orcha-cli[qa]'` |
| Xcode + a booted simulator | iOS | Xcode from the App Store; boot one in Simulator |
| `idb_companion` | iOS | `brew tap facebook/fb && brew install facebook/fb/idb-companion` |
| Android SDK `adb` + a running emulator | Android | Android Studio, or `brew install --cask android-platform-tools` |
| Playwright Chromium | web | `playwright install chromium` with the `orcha` tool's Python (`orcha qa doctor` prints the exact command) |
| The project upgraded | the QA routes and tables (migration 093) | `orcha backup && orcha upgrade` in the project |

## 1. Turn it on for a project

```bash
cd <project>
orcha qa doctor          # what is installed, which devices are up, whether the portal answers
orcha qa enable          # agents of this project get the orcha-qa tools from their next run
orcha qa targets --platform ios --app-id com.example.app --device "iPhone 17 Pro"   # as a person
orcha qa map build --platform ios     # optional: read the app's code into the map now
```

`orcha qa enable` writes `.orcha/qa/mcp.json`. Claude workers then start with
`--mcp-config <that file>` and Codex workers with `-c mcp_servers.orcha-qa.*`; sandboxed workers
never get it (a container cannot reach the host's simulators). `orcha qa disable` turns it off.
`ORCHA_QA_TOOLS=off` in the notifier's environment turns it off for every project on the machine.

## 2. Devices

- iOS: an already booted simulator, by name (default `iPhone 17 Pro`, then the iPad). The tools
  never create, erase or boot a simulator and never download a runtime.
- Android: the first `adb devices` entry in state `device`, unless one is named.
- Web: a headless Chromium of its own per session, 1280×800 (`desktop`) or 390×844 (`mobile`).
  It stays on the target URL's origin; list other origins it may visit as an `Allowed:` line in
  the target's notes.
- One session drives one device. It claims `/tmp/claude-sim-lock-<device name>` (`mkdir`) first
  and removes it at the end; a lock older than 2 hours on a device that is no longer booted counts
  as stale.

## 3. Using it

Give an agent a task and the skill that fits:

| Skill | Does | Lands in the QA tab as |
|---|---|---|
| `/orcha-qa-map` | code pass, then a live crawl | screens seen / declared / blocked, features |
| `/orcha-qa-explore` | briefing and charter, walks the flow queue, findings | a session, findings, walks, draft scenarios |
| `/orcha-qa-draft` | drafts scenarios from code, map and walks | draft scenarios with evidence |
| `/orcha-qa-check` | runs validated scenarios, one verdict per criterion | verdicts, findings |
| `/orcha-qa-test-design` | the quality bar drafts must meet | — |

A person approves every draft (Scenarios › Approve) — agents can propose and revise drafts but
never validate them, and agent work still stops at `needs_verification`. A finding can be filed as
an Orcha task from the session view ("File as task").

In a workflow, a QA step is an ordinary task: give the step `pass`/`fail` outcomes and route
`fail` back to the build step; the explore and check skills report `failure` when there is a
blocker or major finding (explore) or a failed scenario (check).

## Troubleshooting

| Symptom | Check |
|---|---|
| The agent says the QA tools are not on | `orcha qa enable` in the project, then the agent's next run |
| `start_session` says no device | `xcrun simctl list devices booted` / `adb devices`; another session may hold the lock (`ls /tmp/claude-sim-lock-*`) |
| iOS actions fail at once | `idb_companion` installed? `orcha qa doctor` |
| The QA tab is empty after `map build` | the project's portal upgraded (`orcha upgrade`) and `orcha qa map build` printed counts |

## Handing work to QA, and QA in workflows

Pick the project's QA agent in QA > Settings (`PUT .../qa/settings`); with none set, the agent whose role
says QA is used. Then:

- **Send to QA**: from a task, or `orcha qa request --task <id> --kind check --platform ios --focus "..."`, or
  the `orcha-qa-request` skill. No device or QA extra is needed to ask. The QA agent gets a linked task;
  the result comes back on the task's thread and proves its lines in the evidence pack. A person's click
  approves the run's plan. A result never verifies a task: a person does.
- **Trigger**: `trigger` is `manual`, `ui_changes` or `always`. With `on_fail: reopen`, a failure sends the task
  back with the findings and QA runs again when it finishes, up to `max_rounds`.
- **Workflows**: a step with `qa: {kind, ...}` is a QA step. Start from `GET .../qa/workflow-presets`: "Build, QA,
  fix", or "Build, QA, triage, fix", where a failure is diagnosed before anyone fixes it. A person accepts each step.
- **Triage**: `orcha-qa-triage` re-runs a failure at least three times, finds the root cause and records
  `triage_finding`. Only confirmed blockers and majors go to a fix. `auto_triage` (`off`, `critical`, `all`, off by
  default) does it outside a workflow, at most `max_per_run` findings a run; each run holds a device and spends model
  time. A person's "not a bug" is remembered, and agents read it from `list_project`.

An existing project picks all this up with `orcha backup && orcha upgrade` (migration 096). Its
`docs/orcha-project-preferences.md` keeps its own text: only a new project gets the handoff section.

## Android emulator

Start an existing AVD with `emulator -avd <name> -no-window -no-audio`. Do not add a software `-gpu` flag. A
Flutter app draws black on a headless emulator's software renderer (SwiftShader): the agent can still read the
screen, but the live view and screenshots stay black. Native Android apps draw normally. Test a Flutter app on an
emulator with a window and a hardware GPU, or on a real device.

## Physical phones

The device picker lists every phone this Mac knows: connected ones first, then paired ones that are not connected, each with what it needs. Simulators and emulators that are stopped are listed too, and boot when a run is sent to them. Orcha never creates a device.

**iPhone or iPad.** Plug it in, unlock it, tap Trust, and turn on Developer Mode (Settings > Privacy & Security). The app must already be on the phone: Orcha never installs, removes or clears anything on it. Build it for a device and install it:

```bash
xcodebuild -scheme <scheme> -destination generic/platform=iOS -allowProvisioningUpdates build
xcrun devicectl device install app --device <udid> <path to the .app>
```

Physical iPhones run on Appium with its XCUITest driver, pinned and kept in `~/.orcha/tools/appium` (`orcha qa phone-tools` installs them; a run on a phone does so if they are missing). The first run on a phone builds and signs WebDriverAgent, one to three minutes; later runs reuse it. Signing uses `DEVELOPMENT_TEAM` from the project's Xcode project, else this Mac's Apple Development certificate. `ORCHA_IOS_TEAM_ID` overrides it.

A phone cannot clear an app's data, so a scenario that needs a fresh install is reported as blocked there, never judged on old data. Run it on a simulator, or give it `Fresh: no`. Permissions cannot be granted ahead: Orcha taps Allow when the app asks.

**Android phone.** Turn on USB debugging (Settings > Developer options), plug it in and allow this computer. Over Wi-Fi: `adb connect <phone-ip>:5555`.
