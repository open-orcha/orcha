# QA UI parity with Verdikt

The features moved to Orcha (onboarding, mapping and atlas, exploration, scenario drafting, scenario checking),
file by file, against Verdikt's `web/src`. Behaviour, layout, interaction, motion and wording follow the source;
only the styling tokens change. The name appears in this developer note and never in the product or its code.

## Summary

| Area | Rows | Ported | Replaced or left out, with a reason |
|---|---|---|---|
| Run page, theater and live | 74 | 51 | 23 |
| Embedded live device | 25 | 22 | 3 |
| Exploration | 80 | 73 | 7 |
| Drafting | 22 | 15 | 7 |
| Map and atlas | 67 | 61 | 6 |
| Scenarios and checking | 71 | 67 | 4 |
| Onboarding | 37 | 33 | 4 |
| **Total** | **376** | **322** | **54** |

Fidelity, measured: 211 source files have a ported twin, and 88.4% of their lines survive unchanged (whitespace,
imports and comments ignored). By area: exploration 98%, atlas 96%, app map 94%, recordings 93%, scenarios 89%,
explorations 85%, onboarding 81%, replay 80%, run theater 80%, live 77%. The lowest files are data loaders and
state wiring rewritten for Orcha's API (`coverage/types.ts`, `wizard/state.ts`, `use-live-run.ts`), not views.

## What is not ported, by reason

- **Not a moved feature:** recipes, suites, Ask, billing, mocks and stubs (including failure drafting and
  `generate-failures-dialog`), trackers, cloud devices, hardening and goldens, test-data pages (account and profile
  selects, data ledger; test data is shown read-only in onboarding), memory.
- **Replaced by Orcha's own flow:** queued requests and `run-accepted` (Run QA creates a task), the composer and
  `/runs/new` (the Run QA dialog), the runs list (the Sessions home), server loaders and pages.
- **Cannot apply:** `record-scenario-button` and `recording-suggestions` (a person-only recording with no agent and a
  synthesis step; Take over is ported), run archive tiers, the weekly Slack preview (no sender), web LCP and TTFB
  (not recorded; screens rank on settle), per-call waterfall timings. Video: no source, the player is built from frames.

## Verified live

Walked end to end against a real portal on a scratch database, in Chromium, with a real local web app, and the
live and exploration parts again on the iPhone 17 Pro simulator. The agent was a script driving the real MCP tools,
not a model. Verified: onboarding, including a row in phase code_map with code_map pending reopening on We found and a
failed confirm returning there (the failure forced by a 500); the embedded live device and take-over; map, atlas,
Speed and Slowest screens; exploration, run page, replay, Performance tab; drafting; review, with an agent refused
403 by the human gate; check with chosen scenarios, verdicts and `type_secret`.

Not verified: Android on a real emulator (none exists here; unit tests only), a real model as the agent, the
notifier's task pickup, app reset and permission grants on a device. Verdikt's UI was not running, so no view was
compared side by side; fidelity comes from the source and the measure above.

## Data and backend

Schema: `095_qa_parity.sql` with its twin `sqlite/025_qa_parity.sql`, additive. New tables: `qa_app_models`, `qa_check_fix_dismissals`, `qa_coverage_baselines`, `qa_coverage_links`, `qa_coverage_points`, `qa_criterion_feedback`, `qa_data_variations`, `qa_example_secrets`, `qa_measured`, `qa_perf_settings`, `qa_scenario_files`, `qa_scenario_health_audits`, `qa_scenario_health_flags`, `qa_scenario_versions`, `qa_session_logs`, `qa_session_messages`, `qa_session_requests`.
Portal modules: `qa_atlas.py`, `qa_drafting.py`, `qa_drafting_routes.py`, `qa_examples.py`, `qa_explorations.py`, `qa_explorations_routes.py`, `qa_growth.py`, `qa_growth_compare.py`, `qa_growth_depth.py`, `qa_growth_measure.py`, `qa_growth_variations.py`, `qa_live_routes.py`, `qa_map.py`, `qa_map_cover.py`, `qa_map_routes.py`, `qa_onboarding.py`, `qa_onboarding_routes.py`, `qa_perf.py`, `qa_routes.py`, `qa_runs_routes.py`, `qa_scenario_health.py`, `qa_scenario_parity.py`, `qa_scenario_parity_routes.py`, `qa_scenarios.py`, `qa_store.py`, `qa_test_data_rules.py`.
One dependency: `@xyflow/react`. Example secrets are sealed with `secret_box`, and refused without `ORCHA_SECRET_KEY`.

## How the port is built

`src/pages/qa/map/kit/` holds the shared parts; `port.css` maps the source's token names to Orcha's `--v2-*` tokens
under `.qa-port`, so CSS modules copy unchanged; `utilities.css` is generated. After adding a class, re-run
`gen-utilities.mjs` (usage at its top) and restart Vite, which can serve a stale copy.

## Run page, theater and live

Port folder: FE/src/pages/qa/runs (replay/, theater/, check/ for components/live, live-wall/, lib/, parts/). Opened at `?view=sessions&session=<id>&sub=run`; the wall at `?view=sessions&sub=live`.

| Verdikt | Decision |
|---|---|
| components/runs/theater/run-theater.tsx | Ported. Fed one polled document instead of fetching inside; batch siblings, device matrix, prep strip and hand-off follower removed: fan-out batches and the worker queue are not moved. |
| components/runs/theater/theater-model.ts | Ported. |
| components/runs/theater/theater-overview.tsx | Ported. Ask entries removed: Ask is not moved. |
| components/runs/theater/theater-live.tsx | Ported. Phases read from steps (no worker timeline in a session); replay-cache chip and device-prep panel removed: cache, cloud and worker prep not moved. |
| components/runs/theater/timeline-groups.tsx | Ported. |
| components/runs/theater/theater.module.css | Ported. |
| components/runs/theater/types.ts | Ported, trimmed to what a session has. |
| components/runs/theater/load-theater.ts | Ported as runs/adapt.ts + `GET /api/qa/sessions/{id}/run` (qa_runs_routes.py). |
| components/runs/theater/use-live-run-extras.ts | Replaced by the polled document: logs, findings and evidence arrive in it. |
| components/runs/theater/run-files-from.tsx | Not ported: run archive and backup storage tiers do not exist; frames stay on the portal. |
| components/runs/live-wall/live-wall.tsx | Ported. Cloud notes, batch and source filters removed: cloud devices and batches not moved. Blue stage gradients made neutral. |
| components/runs/live-wall/wall-tile.tsx | Ported. Device-prep and provider link removed (cloud, worker prep not moved). Tiles show the newest stored step frame from the wall's poll; each opens the run page, which mounts LiveDeviceView. |
| components/runs/live-wall/use-live-wall.ts | Ported, polling `GET C/qa/live`. |
| components/runs/live-wall/live-wall-page.tsx | Ported as runs/QaLiveWall.tsx. |
| components/runs/live-wall/live-wall.module.css | Ported; `.dark` selector mapped to the portal's data-theme. |
| components/runs/run-accepted/run-accepted-bar.tsx | Not ported: follows a queued batch of requests. Run QA creates an Orcha task, so there is no request queue to follow. |
| components/runs/run-accepted/use-run-accepted.ts | Not ported: same. |
| components/runs/run-accepted/use-batch-live.ts | Not ported: same. |
| components/runs/run-accepted/use-project-targets.ts | Not ported: same. |
| components/runs/run-accepted/run-accepted.module.css | Not ported: same. |
| components/replay/replay.tsx | Ported. Cloud Watch-live button removed (cloud not moved). |
| components/replay/model.ts | Ported; `note` steps summarised in words and kept out of repro lists. |
| components/replay/run-video.tsx | Ported. Video has no source: FramePlayer inside the same frames plays stored frames at their timestamps, with play, seek, speed and full screen. Gaps cap at 3 s. Download gives the last frame. |
| components/replay/run-detail.tsx | Ported. Decisions (replay/judge provenance) and Data (ledger) tabs removed: replay cache and test data not moved. A running session's player is LiveDeviceView. |
| components/replay/run-detail-header.tsx | Ported. Cost, model, stub, build, environment, cloud, resumed-from chips removed: billing, mocks, cloud, recipes not moved. Agent and task chips added. |
| components/replay/run-detail-counters.tsx | Ported. |
| components/replay/steps-list.tsx | Ported. Replay origin chips, hand-off rows, Ask, and settle/guard/timing chips removed: Ask and replay not moved; steps record no settle data. |
| components/replay/logs-list.tsx | Ported. |
| components/replay/logs-model.ts | Ported. |
| components/replay/api-requests-panel.tsx | Ported. Stub-this, near-miss and stub chips removed: mocks not moved. Filters are All, API calls, Pages, Failed. New recording: qa_session_requests. Web only. |
| components/replay/report-view.tsx | Ported. |
| components/replay/abandoned-run-banner.tsx | Ported. Mark as failed removed: an abandoned session is already closed. |
| components/replay/criterion-checks.tsx | Ported. Check-repair cards removed: they edit recorded checks, which belong to hardening. |
| components/replay/scenario-results.tsx | Partly: judge chip and row type ported. The results table is only used by Decisions-era pages; the Scenarios tab is the source's own view of the same rows. |
| components/replay/rerun-href.ts | Replaced: Rerun opens Run QA on the run's kind, since a run starts as a task. It does not preselect scenarios. |
| components/replay/run-actions.tsx | Ported: Stop and Rerun, gated. Resume remaining and View as YAML are not ported. |
| components/replay/use-signed-url.ts | Ported; a frame path is its qa_frames id. |
| components/replay/use-measured-reserve.ts | Ported. |
| components/replay/frame-canvas.tsx | Ported. |
| components/replay/buffered-image.tsx | Ported. |
| components/replay/device-bezel.tsx | Ported. sessions/frames.tsx now wraps it and browser-frame. |
| components/replay/browser-frame.tsx | Ported. |
| components/replay/media-frame.ts | Ported. |
| components/replay/tabs.tsx | Ported. |
| components/replay/run-tabs.ts | Ported. |
| components/replay/data-ledger-panel.tsx | Not ported: test data not moved. |
| components/replay/freeze-golden-button.tsx | Not ported: goldens belong to hardening. |
| components/replay/stub-this-popover.tsx | Not ported: mocks not moved. |
| components/perf/run-perf-panel.tsx | Ported as the Performance tab, over `GET /api/qa/sessions/{id}/perf`, step timing and `qa_perf.py`; the comparison is map/perf's `buildRunScreens`. Sessions file no performance findings, so "Slower than usual or over budget" is derived per run from the project's rules (runs/perf/api.ts): no confidence, no Finding or Issue link, and `confirm_runs` is not applied. Call timing is web only. |
| components/perf/perf-waterfall.tsx | Ported. |
| components/explorations/exploration-way-back.tsx | ExplorationBackLink mounted above the run header where the source's top bar shows it, for map, explore and draft sessions (a check run keeps "Back to the session"). ExplorationChip mounted in the live band. Both from sessions/. |
| components/live/scenario-rail.tsx | Ported. |
| components/live/scenario-rail-model.ts | Ported. |
| components/live/criterion-card.tsx | Ported. Origin chip removed (replay cache). Fix prompt composed from the finding's fields. |
| components/live/criterion-feedback-actions.tsx | Ported, gated. New qa_criterion_feedback. "Not a bug · train" is "Not a bug": scenario memory is not moved, so nothing trains on it. |
| components/live/verdict-icon.tsx | Ported. |
| components/live/scenarios-panel.tsx | Ported, fed by qa_verdicts through the polled document. Provenance bar and replay diff removed; passed-earlier and status-skipped lists removed (resume and request scoping not moved). |
| components/live/scenario-rename.tsx | Ported, gated on an acting human. |
| components/live/rerun-criterion-button.tsx | Replaced: opens Run QA. |
| components/live/tracking-events-list.tsx | Ported; renders only if a criterion carries event rows, which sessions do not write yet. |
| components/live/live-badge.tsx | Ported. |
| components/live/use-live-run.ts | Ported as polling; useElapsedMs and useStaleMinutes unchanged. |
| components/live/use-run-counters.ts | Replaced by the polled document's steps. |
| components/live/use-live-refresh.ts | Replaced by the same poll. |
| app/(app)/runs/[id]/page.tsx | Ported as runs/QaRun.tsx, with `tab`, `step`, `action`, `finding`, `scenario` deep links. |
| app/(app)/runs/[id]/loading.tsx | Ported: TheaterSkeleton. |
| app/(app)/runs/live/page.tsx | Ported: `sub=live`. |
| app/(app)/runs/runs-view.tsx | Not ported: the Sessions home is that list, owned by the exploration workstream. The theater keeps its `pane` variant. |
| app/(app)/runs/page.tsx | Not ported: same. |
| app/(app)/runs/all/page.tsx | Not ported: same. |
| app/(app)/runs/all/loading.tsx | Not ported: same. |
| app/(app)/runs/loading.tsx | Not ported: same. |
| app/(app)/runs/new/page.tsx | Not ported: starting a run is the Run QA dialog. |
| app/(app)/runs/requests/[id]/page.tsx | Not ported: there are no queued requests. |

## Embedded live device

| Verdikt | Decision |
|---|---|
| web/src/components/recordings/use-live-frame.ts | Ported (runs/live/use-live-frame.ts); also returns the live state, since one poll carries both |
| web/src/components/recordings/recording-screen.tsx | Ported (runs/live/recording-screen.tsx); drawn inside the bezel via `framed`; the live frame comes as a prop from LiveDeviceView; tree-size lookup dropped because the tool server reports the screen size in every beat |
| web/src/components/recordings/recording-controls.tsx | Ported (runs/live/recording-controls.tsx); Finish is "Hand back", Cancel is "Stop session" |
| web/src/components/recordings/recording-commands.tsx | Ported (runs/live/recording-commands.tsx) |
| web/src/components/recordings/recording-view.tsx | Ported in part: heartbeat, ordered send queue, optimistic inputs and poll are in runs/live/use-live-drive.ts and LiveDeviceView.tsx. Left out: the worker queue line, notifications and the post-recording write-up, because Orcha's device only exists inside an agent's session, so there is no queue to wait in and no recording to synthesize |
| web/src/components/recordings/recording-suggestions.tsx | Not ported: reviews suggestions a recording's synthesis drafted; Take over has no synthesis step, and agent-drafted scenarios are reviewed in the scenarios workstream |
| web/src/components/recordings/record-scenario-button.tsx | Not ported: starts a worker-run recording with a person driving and no agent. Orcha has no worker that opens a device by itself: a device session only exists in an agent's `orcha qa mcp`. Take over is the way a person drives. A person-first recording would need a new session kind and a skill |
| web/src/components/projects/live-device-peek.tsx | Ported: FrameView, LiveBadge and the peek layout are in runs/live/LiveDeviceView.tsx |
| web/src/components/replay/abandoned-run-banner.tsx | Ported into LiveDeviceView.tsx (data-run-abandoned, Mark as failed) |
| web/src/components/replay/replay.tsx (stale banner) | Ported into LiveDeviceView.tsx (data-replay-stale-banner, same 2 and 5 minute tones) |
| web/src/lib/recordings/recording-live.ts | Ported (runs/live/recording-live.ts); paths are portal routes; phases, stale tone and takeover gating added |
| web/src/lib/recordings/recording-gestures.ts | Ported (runs/live/recording-gestures.ts) |
| web/src/lib/recordings/recording-inputs.ts | Ported (runs/live/recording-inputs.ts); pollDelay and idleEndedLine moved: the live poll covers the first, the portal words the second |
| web/src/lib/recordings/recording.ts | Ported in part (runs/live/recording.ts): the geometry, crosshair, URL check and describeCommand the live screen uses. The rest picks targets and devices for record-scenario-button. describeCommand never repeats typed text |
| web/src/lib/data/live-frame.ts | Ported as GET /api/qa/sessions/{id}/live: it read a file on the server's disk; the frame is in the portal's memory here |
| web/src/lib/common/poll-loop.ts | Ported (runs/live/poll-loop.ts) |
| web/src/lib/common/frame-buffer.ts | Ported by the runs workstream (runs/lib/frame-buffer.ts), imported |
| web/src/components/replay/device-bezel.tsx, browser-frame.tsx, buffered-image.tsx | Ported by the runs workstream (runs/replay/), imported |
| src/verdikt/recorder/live_frames.py | Ported (qa/device/live_frames.py): sink instead of files on disk, plus hold, frame_guard, identical-frame skip |
| src/verdikt/recorder/runner.py (execute_command, command grouping) | Ported (qa/device/live_frames.py, QATools._live_loop) |
| src/verdikt/drivers/ios_idb.py jpeg_frames, _h264_as_jpegs | Ported (qa/device/ios_idb.py) |
| src/verdikt/sessions/ios.py start_live, stop_live | Ported; orientation correction left out because this device layer has no ios_orientation port, so a rotated simulator's stream shows the native framebuffer |
| src/verdikt/sessions/android.py _live_frame, start_live, stop_live | Ported; not exercised on a device (no emulator running), unit tests only |
| src/verdikt/sessions/web.py start_live, screencast | Ported |
| src/verdikt/sessions/appium.py live loop | Not ported: cloud devices are not a moved feature |

## Exploration

Reference: Verdikt web/src. Files under `components/explorations/composer/*` are recipe parts (not moved); Run QA covers starting a session.

| Verdikt | Decision |
|---|---|
| components/explorations/compare/compare-view.tsx | Ported (sessions/compare), at `?view=sessions&sub=compare&a=&b=`. Build line empty: Orcha sessions store no build. |
| components/explorations/detail/actions.ts | Ported as sessions/api.ts calls (keep, again, duplicate, stop). |
| components/explorations/detail/charter-list.tsx | Ported, step links go to the run page. |
| components/explorations/detail/check-face.tsx | Ported: verdicts (check runs) and measured scan rows from qa_measured. |
| components/explorations/detail/detail.module.css | Ported. |
| components/explorations/detail/drafts-panel.tsx | Ported for this page, plus Run what you accepted. Conversation feed and per-draft evidence live in sessions/drafting (drafting workstream); no separate drafter runs beside an Orcha explorer. |
| components/explorations/detail/exploration-detail.tsx | Ported: every face, rename, More menu, Stop, Run again, run links, workflows, footer. Model, cost and brief chips: Orcha agents report none (billing not moved). Device prep: no worker prepares a device, the agent does in start_session. |
| components/explorations/detail/explore-face.tsx | Ported; LiveScreen shows LiveDeviceView (real device, buffering, stalled, ended). Withheld note: Orcha uploads no frame then, so nothing is withheld. |
| components/explorations/detail/feature-outcomes.tsx | Ported. |
| components/explorations/detail/finding-input.ts | Ported. |
| components/explorations/detail/finding-sheet.tsx | Ported with fix prompt, severity edit, Create scenario, run link. |
| components/explorations/detail/finding-shot.tsx | Ported. |
| components/explorations/detail/finding-ticket.tsx | Not moved: trackers. File as task is Orcha's way. |
| components/explorations/detail/header.tsx | Ported with EditableName. ExplorationModels: no model data, billing not moved. |
| components/explorations/detail/journeys.tsx | Ported. |
| components/explorations/detail/legacy.tsx | Ported as the "What was measured" section of the report, on the session's measured rows and series. |
| components/explorations/detail/model.ts | Ported. queuedWords says the agent waited for and the place in line. stepHref and followUpHref became sessions/links.ts and Run QA. |
| components/explorations/detail/phase-timeline.tsx | Ported. |
| components/explorations/detail/report-findings.tsx | Ported with all actions. |
| components/explorations/detail/report.tsx | Ported. |
| components/explorations/detail/run-links.tsx | Ported to the run page. |
| components/explorations/detail/states.tsx | Ported including QueuedFace. BuildFailureDetail: Orcha builds nothing. |
| components/explorations/detail/study-face.tsx | Ported. |
| components/explorations/detail/study-model.ts | Ported. |
| components/explorations/detail/use-exploration-live.ts | Ported as use-session-live.ts: 2.5 s poll, no change feed in Orcha. |
| components/explorations/exploration-way-back.tsx | Ported (sessions/exploration-way-back.tsx, exploration-link.ts). Runs workstream mounts ExplorationBackLink. |
| components/explorations/home/bits.tsx | Ported with Sparkline. |
| components/explorations/home/card-menu.tsx | Ported. |
| components/explorations/home/empty-scene.tsx | Ported. |
| components/explorations/home/exploration-card.tsx | Ported from source: rename, Run again, Duplicate, Compare with previous, Pin (added), Archive, score delta, sparkline, pick circle. |
| components/explorations/home/exploration-history.tsx | Ported: archived filter, compare tray, pinned group (added). Legacy report list: no pre-v2 rows here. |
| components/explorations/home/exploration-home.tsx | Ported with AppModelEntry. Feature territory: lives in the map/atlas views. Server loaders replaced by QaSessions.homeData. |
| components/explorations/home/explore-hero.tsx | Ported. |
| components/explorations/home/explore-skeleton.tsx | Ported. |
| components/explorations/home/explore.module.css | Ported. |
| components/explorations/home/feature-stat.tsx | Ported. |
| components/explorations/home/home-model.ts | Ported. featureTrails and deepDivePick serve the territory and the recipes, not moved here. |
| components/explorations/home/live-expedition.tsx | Ported; live tiles read the pushed device frame (useLiveFrame). |
| components/explorations/home/route-strip.tsx | Ported. |
| components/explorations/lens-chip.tsx | Ported. |
| components/explorations/motion.module.css | Ported. |
| components/explorations/recipe-meta.tsx | Ported for session kinds. Recipes not moved. |
| components/explorations/score-ring.tsx | Ported. |
| components/explorations/workflows/app-model-entry.tsx | Ported. |
| components/explorations/workflows/app-model-panel.tsx | Ported; qa_app_models backs it. |
| components/explorations/workflows/bits.tsx | Ported. |
| components/explorations/workflows/flow-queue.tsx | Ported. |
| components/explorations/workflows/use-workflow-walks.ts | Ported on the session poll, no change feed. |
| components/explorations/workflows/walk-live.tsx | Ported. |
| components/explorations/workflows/walk-outcomes.tsx | Ported in full, replacing the first pass copy. |
| components/explorations/workflows/walk-scene.tsx | Ported. |
| components/explorations/workflows/workflow-section.tsx | Ported. |
| components/explorations/workflows/workflows.module.css | Ported. |
| components/exploration/check-chart.tsx | Ported. |
| components/exploration/diff-panel.tsx | Ported. |
| components/exploration/exploration-browser.tsx | Ported. |
| components/exploration/exploration-map.tsx | Ported. |
| components/exploration/exploration-section.tsx | Not applicable: Verdikt's old project tab wrapper; the session page mounts the browser directly. |
| components/exploration/finding-detail-panel.tsx | Ported. |
| components/exploration/finding-row.tsx | Ported. |
| components/exploration/finding-screenshot.tsx | Ported. |
| components/exploration/findings-explorer.tsx | Ported. |
| components/exploration/judged-findings.tsx | Ported. |
| components/exploration/notes-section.tsx | Ported; agents write notes with the new note_impression tool. |
| components/exploration/report-detail.tsx | Ported. |
| components/exploration/reports-list.tsx | Ported. |
| components/exploration/screen-node.tsx | Ported. |
| components/exploration/severity-bar.tsx | Ported. |
| components/exploration/tree-model.ts | Ported. |
| components/exploration/version-rail.tsx | Ported; revisions are the series. |
| components/findings/copy-fix-prompt.tsx | Ported. Runtime log lines: the prop stays, nothing passes logs yet. |
| components/findings/evidence-thumb.tsx | Run page only; ported by the runs workstream (runs/parts). |
| components/findings/finding-card.tsx | Run page only, not used by exploration. |
| components/findings/finding-logs.tsx | Run page only, not used by exploration. |
| components/findings/finding-scenario-button.tsx | Ported. "Run it" dropped: a draft cannot be checked until a person approves it. |
| components/findings/finding-severity.tsx | Ported. "Remember for this project": memory not moved. Orcha's reviewing state never occurs (no severity review model). |
| components/findings/status-select.tsx | Issue status, not used by exploration. |
| app/(app)/explorations/[id]/page.tsx, loading.tsx | Ported as QaSessions routing and ExploreSkeleton. |
| app/(app)/explorations/compare/page.tsx | Ported as sessions/compare/compare-page.tsx. |
| app/(app)/explorations/new/page.tsx | Composer: recipes not moved; Run QA starts sessions and now queues them. |

## Drafting

| Verdikt | Decision |
|---|---|
| components/projects/drafting-stage.tsx | Ported (0.99): film strip, Ken Burns, ambient colour, typed note, drafted stack, fold. Driven by what the drafter says (`draft_progress`, each proposal) and past exploration frames. Checked in a browser: focus moves on the 3.4 s clock. |
| components/projects/drafting-workspace.tsx | Ported (0.79). Reached from a session, so the idle branch (picker, Start, PendingDrafts, IdleDrafts) moved: the picker is in Run QA; pending drafts live in the Scenarios tab. Model chip and cost: Orcha's sessions record neither, an agent runs on the person's own plan. Focus chips (feature/map): a focus reaches the agent as the goal text, shown under the title. |
| components/projects/drafting-parts.tsx | Ported (0.87): DraftSourcesPicker, StartHint, ExplorationPassCard, siblings strip, DraftReview, DraftingError. PlatformControl: the dialog above it picks the platform. DraftStartButton: the dialog's Create task. Worker readiness: an agent is picked by name, there are no workers. Provider error details: the agent's own error text is shown. |
| components/projects/drafting-split.tsx | Ported (0.98). |
| components/projects/draft-card.tsx | Ported (0.94): evidence headline, evidence block, feedback, Revise, previous version (from the correction's stored version, plain text). DraftStubs left out by the brief (mocks). |
| components/projects/draft-deck.tsx | Ported (0.99), keyboard included. Accept, Discard, Accept all gated: disabled with the reason, the keys too; the server enforces. Discard retires (a scenario is never deleted). |
| components/projects/draft-evidence.tsx | Ported (1.00). |
| components/projects/draft-list.tsx | Ported (0.98), gated the same way. DraftStubs left out (mocks). |
| components/projects/conversation-feed.tsx | Ported (0.99). Reads `qa_session_messages` plus the explorer's first sighting of each screen. Without an explorer it is headed Drafter. |
| components/projects/generation-activity.tsx | DraftSkeletons ported. GenerationActivity not: only the recordings screen uses it, and recordings did not move. |
| components/projects/generate-from-repo.tsx | Not ported: it is a link to the full drafting page; here Run QA with Draft preselected (Scenarios header, hero quick start). |
| components/projects/generate-scenarios.tsx | Not ported: the onboarding wizard's inline copy of the same parts, tied to a request it starts itself. Orcha starts drafting through Run QA (a task), and watches it on the session's page. |
| components/projects/live-device-peek.tsx (needed by parts) | Ported (0.95): FrameView, LiveDevicePeek, ExplorationReplay on the run replay's bezels. |
| app/(app)/projects/[slug]/drafting/page.tsx | Not ported as a page: a Next.js server loader. Its job (resolve the request, the exploration, the focus) is `GET /api/qa/sessions/{sid}/drafting`; the deep link is `?view=sessions&session=`. Topbar trail: the QA tabs and the footer's way back. |
| lib/drafting/draft-sources.ts | Ported (0.84). Device readiness and the multi-platform pick (`chooseDraftPlatform`, `explorePlatformPick`, `aheadOf`): no workers and no multi-platform composer; several explorers of one task do show as tabs. |
| lib/drafting/drafting-board.ts | Ported (0.99). |
| lib/drafting/drafting-route.ts | Ported in part (0.53): phase, step, progress line, sources. URL parsing and target picking are the Next page's, replaced by `qaHref`. |
| lib/drafting/drafting-stage.ts | Ported (0.99). |
| lib/drafting/failure-drafting.ts | Not ported: failure drafting writes API stubs, and mocks/stubs did not move. |
| components/projects/use-*.ts (session, board, actions, revisions) | Ported as same-shaped hooks over the board route; polled (2.5 s live, 15 s idle) in place of realtime. |
| Explorer tool `post_screen` | Not added: an explorer's screens come from its recorded steps, each once. |
| Contradictions in `read_screens`, platform pinning | Not added: the agent compares drafts with the labels it reads and corrects them with `revise_scenario(screen=...)`; a scenario here is already on one platform. |

## Map and atlas

| Verdikt | Decision |
|---|---|
| components/atlas/atlas-board.tsx | Ported. Export menu real again (Download a PDF, Download a page to share, Copy a link), label back to Export. Refresh and Fill open the device dialog, which creates the map task. The source's refresh POST is a task here: agents do the work. Cost lines left out (billing not moved). |
| components/atlas/atlas-hero.tsx | Ported. `position:relative; z-index` on actions so the export menu opens over the figures. |
| components/atlas/atlas-play.tsx | Ported |
| components/atlas/atlas-scenes.tsx | Ported. Minutes restored (about 3 minutes). Price left out: billing not moved. |
| components/atlas/atlas-skeleton.tsx | Ported |
| components/atlas/before-after.tsx | Ported |
| components/atlas/diff.ts | Ported |
| components/atlas/empty-scene.tsx | Ported |
| components/atlas/fill-dialog.tsx | Ported. Device picker is the onboarding's port, `GET C/devices`. Cloud devices not moved. Adds an Agent row: a pass here is a task for an agent. |
| components/atlas/filter-bar.tsx | Ported |
| components/atlas/model.ts | Ported. `fillWords` minutes and `refreshWords` restored; `unchecked` wording restored. Cost words left out (billing). Kept one row per device kind when no look says light or dark (frames from before 095). |
| components/atlas/num.tsx | Ported |
| components/atlas/play.ts | Ported |
| components/atlas/refresh-story.tsx | Ported. Real targets and depth from the session's queue. Cost lines left out (billing). |
| components/atlas/screen-card.tsx | Ported |
| components/atlas/screen-detail.tsx | Ported. Builds, light and dark and set appearance now come from real looks. |
| components/atlas/storyboard.tsx | Ported |
| components/atlas/summary.ts | Ported |
| components/atlas/tip.tsx | Ported |
| components/atlas/types.ts | Ported. `minutes`, `fill_minutes` restored. |
| components/atlas/use-atlas.ts | Ported on polling: change feed does not exist here (nonce, 3 s while a pass runs). |
| components/atlas/zoom.ts | Ported |
| components/atlas/atlas.module.css | Ported, tokens only. |
| components/atlas/board.module.css | Ported |
| components/atlas/detail.module.css | Ported |
| components/atlas/hero.module.css | Ported |
| components/atlas/play.module.css | Ported |
| components/atlas/story.module.css | Ported |
| Python app_map/atlas.py | Ported into qa_atlas.py: compare, badge_for, fingerprint reads, match `setting`, blank notes, builds, since by build. `fingerprint`, `is_blank`, `frame_appearance`, `resolve_appearance` run at capture in CLI qa/frame_facts.py, so the portal needs no Pillow. |
| Python app_map/atlas_export.py | Ported into atlas/export.ts, in the browser: HTML with thumbnails inside, PDF drawn on canvases with its own writer. No server renderer. |
| Python app_map/queue.py, ways_in.py, mcp/tools_crawl.py | Ported into CLI qa/crawl_queue.py and mcp_server (`crawl_next`, nudges, auto move-on, report). ParamIndex (ids from past runs) left out: no store of visited records; a route with a parameter uses the map's path or a hint. Auto dead-end detection left to the agent via `blocked_kind`. |
| Python screen_perf/* | Samples and settings ported into qa_perf.py, read from step timing. Run findings, PR note and PR gate not moved. |
| components/app-map/app-map-board.tsx | Ported. Agents build: Rebuild opens Run QA. Running build now real: `orcha qa map build` posts `C/map/builds`. |
| components/app-map/app-map-scenes.tsx | Ported. `no model is called` restored: true of the code read that writes builds (`orcha qa map build`). `built from what Orcha can already read` restored. |
| components/app-map/app-map-view.tsx | Ported. Speed chip, legend and heat restored. Platform switch stays on the QA page: its map is one platform at a time (`GET C/map?platform=`). |
| components/app-map/app-map.module.css | Ported, Speed classes restored. |
| components/app-map/coverage-model.ts | Ported |
| components/app-map/crawl-chip.tsx | Ported |
| components/app-map/detail-panel.tsx | Ported. Ask and ScreenMemory left out: features not moved. Explore carries the screen as Run QA's focus. |
| components/app-map/draft-action.tsx | Ported. Area focus now reaches Run QA; `Draft the gaps` crawls while most is unseen, as the source. |
| components/app-map/fixture.ts | Ported |
| components/app-map/layout.ts | Ported |
| components/app-map/live-reveal.ts | Ported |
| components/app-map/map-coverage.tsx | Ported |
| components/app-map/map-edge.tsx | Ported |
| components/app-map/map-nodes.tsx | Ported. Heat marks and region heat restored. |
| components/app-map/map-speed.tsx | Ported |
| components/app-map/map-speed.module.css | Ported |
| components/app-map/model.ts | Ported |
| components/app-map/panel-frame.tsx | Ported |
| components/app-map/panel-state.ts | Ported |
| components/app-map/scale-fixture.ts | Ported |
| components/app-map/screen-stubs.tsx | Not ported: mocks and stubs not moved. |
| components/app-map/stub-suggestions.tsx | Not ported: mocks and stubs not moved. |
| components/app-map/types.ts | Ported. `parseAppMap` uses `parseBuild`, so planned and reused reach the scenes. |
| components/app-map/use-map-crawl.ts | Ported on polling. Queue marks and budget ring live: sessions carry `crawl_queue`. |
| components/perf/slowest-screens.tsx | Ported, `?sub=slowest`. Perf issue row left out: trackers not moved. Polls instead of the change feed. |
| components/perf/perf-ui.tsx | Ported |
| components/perf/perf-motion.ts | Ported |
| components/perf/slowdown-replay.tsx | Ported |
| components/perf/perf.module.css | Ported. Rows' left stripes replaced by the same tint, by the no-stripes rule. |
| components/perf/perf-settings-section.tsx | Ported as Budgets, `?sub=budgets`, person only. PR group, on/off switch and `runs in a row` left out: PR checks and filed findings not moved. |
| lib/perf/perf.ts, perf-settings.ts | Ported to map/perf/ |
| app/(app)/projects/[slug]/map, atlas pages | Ported: QaMap.tsx sub tabs, QaAtlas.tsx. |
| Map and atlas history | Atlas: Changed since, by date or build, with before and after. Map: build beats with `Reused the code read 2 days ago`, from `C/map` sources in adapt.ts. |
| QaOverview `?state=` | Source's map has no state filter. Map opens on the first screen in that state, its panel open, then drops the parameter. |
| Web page timings (lcp, ttfb) | Not recorded: the session records settle and appear; web ranks on `settle`, the source's own fallback when no LCP exists. |

`run-perf-panel` and `perf-waterfall` are ported on the run page: see that table.

## Scenarios and checking

| Verdikt | Decision |
|---|---|
| components/scenarios/bulk-action-bar.tsx | Ported, with Delete and Run selected by id. |
| components/scenarios/check-fix-card.tsx | Ported; accept is a person's PATCH of `checks` (a new version); agents send check_fix / check_repairs on verdict. |
| components/scenarios/confirm-dialog.tsx | Ported. |
| components/scenarios/coverage/coverage-board.tsx | Ported. |
| components/scenarios/coverage/coverage-map.tsx | Ported. |
| components/scenarios/coverage/coverage-page.tsx | Ported into QaScenarios.tsx: the Coverage sub-tab and its scroller (`?sub=coverage`, `&coverage=growth`). |
| components/scenarios/coverage/coverage-panel.tsx | Ported. |
| components/scenarios/coverage/coverage-states.tsx | Ported. |
| components/scenarios/coverage/coverage.module.css | Ported (shared copy in map/). |
| components/scenarios/coverage/fog-paint.ts | Ported (shared copy in map/, the Map uses it too). |
| components/scenarios/coverage/fog-texture.ts | Ported (shared copy in map/). |
| components/scenarios/coverage/growth/added-tiles.tsx | Ported. |
| components/scenarios/coverage/growth/baseline-shutter.tsx | Ported. |
| components/scenarios/coverage/growth/growth-charts.tsx | Ported. |
| components/scenarios/coverage/growth/growth-hero.tsx | Ported. |
| components/scenarios/coverage/growth/growth-model.ts | Ported. |
| components/scenarios/coverage/growth/growth-states.tsx | Ported. |
| components/scenarios/coverage/growth/growth-timelapse.tsx | Ported. |
| components/scenarios/coverage/growth/growth-view.tsx | Ported; computed by portal_backend/qa_growth*.py from stored rows (the Python ported); live feed replaced by the page's re-reads. |
| components/scenarios/coverage/growth/growth.module.css | Ported. |
| components/scenarios/coverage/growth/motion.ts | Ported. |
| components/scenarios/coverage/growth/types.ts | Ported. |
| components/scenarios/coverage/growth/variations-panel.tsx | Ported. |
| components/scenarios/coverage/growth/weekly-preview.tsx | Not ported: it previews a Monday Slack post, and Orcha has no sender for it; showing it would promise a message nothing sends. `weekly` line and payoff are ported. |
| components/scenarios/coverage/map-layout.ts | Ported. |
| components/scenarios/coverage/panel-model.ts | Ported. |
| components/scenarios/coverage/types.ts | Ported. |
| components/scenarios/examples-field.tsx | Ported; sealed cells live in qa_example_secrets. The portal has no encryption helper, so the value is stored as text in the local DB, never listed, versioned or exported. |
| components/scenarios/examples.module.css | Ported. |
| components/scenarios/export-menu.tsx | Ported; PNG drawn on a canvas from the graph's nodes and edges (graph-png.ts), no dependency: a file of the cards and arrows, not a pixel screenshot. |
| components/scenarios/fresh-state-row.tsx | Ported. |
| components/scenarios/generate-failures-dialog.tsx | Not ported: its drafts fake API failures with stubs, and mocks/stubs are out by the user's order. |
| components/scenarios/health/badge.tsx | Ported. |
| components/scenarios/health/board-model.ts | Ported. |
| components/scenarios/health/health-board.tsx | Ported; the audit runs in portal_backend/qa_scenario_health.py (the Python ported). |
| components/scenarios/health/health-dialogs.tsx | Ported. |
| components/scenarios/health/health-page.tsx | Ported into QaScenarios.tsx: the Health sub-tab (`?sub=health`). |
| components/scenarios/health/health-states.tsx | Ported. |
| components/scenarios/health/health-store.ts | Ported. |
| components/scenarios/health/health.module.css | Ported. |
| components/scenarios/health/types.ts | Ported. |
| components/scenarios/history-drawer.tsx | Ported; Ask and pull-request heal notes left out (Ask and heals are not moved). |
| components/scenarios/modifier-select.ts | Ported. |
| components/scenarios/needs-row.tsx | Ported; environment colouring left out: it reads test-data profiles (a test-data page). |
| components/scenarios/new-scenario-review.tsx | Ported; the Ask review bar left out (Ask is not moved). |
| components/scenarios/panel-ui.tsx | Ported. |
| components/scenarios/permissions-row.tsx | Ported. |
| components/scenarios/platform-filter.tsx | Ported. |
| components/scenarios/platform-fit-note.tsx | Ported; real on `shared` scenarios (new column), Limit/Split/Keep all work. |
| components/scenarios/platform-status-strip.tsx | Ported. |
| components/scenarios/quarantine-badge.tsx | Ported. |
| components/scenarios/release-quarantine-button.tsx | Ported. |
| components/scenarios/replay-trace-section.tsx | Ported as Recorded path: built from walks; there is no model-free replay here, so 'Replays with no model' reads 'Given to the next check run' (get_scenario gives the path to the agent). Watch replay is Open session. |
| components/scenarios/scenario-account-select.tsx | Not ported: lists accounts from environment auth config, a test-data page. |
| components/scenarios/scenario-files-list.tsx | Ported; files on disk beside the frames (qa_scenario_files). |
| components/scenarios/scenario-filters.tsx | Ported. |
| components/scenarios/scenario-graph.tsx | Ported. |
| components/scenarios/scenario-list.tsx | Ported. |
| components/scenarios/scenario-node.tsx | Ported. |
| components/scenarios/scenario-panel.tsx | Ported; Ask, memory snippets, API stubs left out (not moved). Profile/account as above. |
| components/scenarios/scenario-profile-select.tsx | Not ported: lists environment personas, a test-data page. |
| components/scenarios/scenario-search-box.tsx | Ported. |
| components/scenarios/scenario-status-control.tsx | Ported; issues are this project's tasks (a finished task resumes it). A GitHub ref is kept and said to be a person's to resume: the portal does not read GitHub. |
| components/scenarios/scenarios-canvas.tsx | Ported; Ask entry points left out. |
| components/scenarios/seed-data-field.tsx | Ported: scenario data, not a test-data page. Seed and cleanup lines are carried out by the agent. |
| components/scenarios/shortcuts-help.tsx | Ported. |
| components/scenarios/tracking-events-field.tsx | Ported; stored, listed by get_scenario. The agent checks them from what it can see: no capture matcher. |
| components/scenarios/yaml-drawer.tsx | Ported as the Markdown view (text-dialog.tsx, scenario-markdown.ts): the same read-only text in the format Orcha stores. |
| app/(app)/scenarios/page.tsx | Ported into QaPage/QaScenarios. |
| app/(app)/scenarios/scenarios-content.tsx | Ported into QaScenarios.tsx. |
| app/(app)/projects/[slug]/scenarios/page.tsx | Ported: sub-tabs canvas, Health, Coverage; Checks, Mocks, Suites, Migrate out by the brief. |

Also ported, outside components: lib/scenarios check-fixes, scenario-platform, scenario-status, examples, examples-edit, seeds, tracking-events, scenario-health, lib/environments/app-permissions; Python scenario_health, coverage_growth (measure, compare, depth, variations), examples, test_data_rules (locale), fresh_state, app_permissions.

Not automatic: suspicious scenarios are only skipped by the check skill unless named; quarantine by a person (no auto-quarantine); 5 clean passes auto-release.

## Onboarding

Moved onto PortRoot/.qa-port and the generated utilities; the private compiled sheet qa-onboarding.css and onboarding/icons.tsx are gone (kit controls and kit icons, as the source uses them). Checked in a real browser on data captured from the real qa_onboarding code on a fixture repo, fresh project, every step, dark and light, 390/768/1440.

| Verdikt | Decision |
|---|---|
| map/backends.ts | Ported |
| map/bring-in-step.tsx | Ported |
| map/choreo.ts | Ported |
| map/contract.ts | Ported, plus `auth` and `sandboxes` on the found sheet |
| map/coverage-step.tsx | Ported |
| map/coverage.ts | Ported |
| map/draw.ts | Ported; draws no gradient |
| map/first-run-map.tsx | Ported; the live device is LiveDeviceView. Ask next-step left out: Ask is not moved |
| map/first-run-result.ts | Ported |
| map/fixtures.ts | Ported |
| map/flow-rail.tsx | Ported |
| map/flow.ts | Ported |
| map/found-backends.tsx | Ported |
| map/found-sheet.tsx | Ported. Environment and Test data rows are display only, as asked; both now show what the scan found (sign-in summary, sandboxes with evidence). `Change` left out: the repository is the project's own folder, there is nothing to change it to. Ask row is Orcha's Agent row: Ask is not moved |
| map/layout.ts | Ported |
| map/live-pass.ts | Ported |
| map/live-run-panel.tsx | Ported; LiveDeviceView with the newest stored frame as fallback; steps polled from the new newest-first route |
| map/map-stage.tsx | Ported |
| map/map-step.tsx | Ported |
| map/onboarding-map.module.css | Ported. Stage accent restored as a neutral --v2-text tint with the same geometry; sheen gradient neutral. Dark blocks gone because the tokens theme themselves |
| map/scenes.tsx | Ported, every scene and animation |
| map/use-onboarding-map.ts | Ported; polling in place of the change feed (Orcha has none for this row) |
| wizard/ask-step.tsx | Not ported: Ask is not a moved feature |
| wizard/device-step.tsx | Ported on the device picker. A portal that cannot see the machine (container portal) falls back to a typed name |
| wizard/environment-step.tsx | Display only, as asked: the sign-in scan (`auth_scan.py`, the source detector) feeds the Environment row. The editor is not ported because display-only was the instruction |
| wizard/first-run-step.tsx | Ported: Platforms, Platform, Mode, scenario file, Runs on summary, queue. Exploratory: the source embeds the exploration composer, which is built on recipes (not moved) and has no port; minutes + focus + Start, with "More options" opening Run QA |
| wizard/generate-step.tsx | Not ported: it is the fallback for a build without the map route. Orcha ships the route with the portal; `onClassic` opens the Apps form |
| wizard/index.tsx | Ported as OnboardingFlow.tsx: layout, wide transition, announcements, reload draft + Start over, first-run queue. Project creation does not apply: the project already exists. Keeps the reopen-on-We-found and failed-confirm patch |
| wizard/repository-step.tsx | Ported as far as it applies: repository, detected platforms, tests. Folder picker, subdirectory, icon and name belong to creating a project |
| wizard/state.ts | Ported as far as it applies: device options, run device, draft read/write/clear, first-run fields. Project-creation fields do not apply |
| wizard/target-step.tsx | Ported. URL and Upload build sources left out: the device layer never installs a build (`build_path` is stored, no session reads it), so they would be controls that do nothing; adding an install pipeline is its own feature. Desktop kind: no desktop device layer |
| wizard/test-data-step.tsx | Page not ported, as asked. Display: `sandbox_scan.py` feeds the Test data row. Launch hook left out: the hook kit is not moved, so no app can carry one |
| wizard/tests-found.tsx | Ported; reads the found sheet rather than a separate survey route, so its folder-access and retry phases do not apply |
| wizard/use-live-devices.ts | Ported on polling `GET C/devices` |
| components/devices/device-picker.tsx | Ported as device-picker-view.tsx, Local only: cloud devices are not moved. Multi-select is New Run's, not onboarding's |
| lib/devices/device-picker.ts | Ported, Local only |
| components/runs/runs-on-summary.tsx | Ported, without scenario splits and cloud placement |

## Bugs found and fixed
- `found.defaults.device` is a word ("A simulator"); the old port saved it as the device, so an iOS-first project's sessions could not find a device.
- The picked device never reached the agent: the task text now says what to pass to start_session.
- A build path typed on the sheet was dropped; saved to qa_targets.build_path.
- First run had no session until its first verdict, so its live view could not start.
- The live panel read steps oldest first, capped at 500: a long session never showed its current screen.
- A tap's target is an object in real data: steps read "tap" with no label.
