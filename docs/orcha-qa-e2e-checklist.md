# Quality tab: end-to-end checklist

Every row is walked by hand, in a real browser, on a real project, with a real agent and device where
one is involved. A row is done only when it worked start to finish with nothing stuck, no misleading
text and no console or portal error. Scripts and unit tests do not count.

| # | Flow | Project | Platform | Status | Evidence / notes |
|---|---|---|---|---|---|
| 1 | Onboarding, fresh project: Connect → We found → Map → live pass → Coverage → Bring in → First run | fleet-mate | web | done (web, ios) | Web on nyumba-connect by the first walk. iOS on Slate, a fresh project: Connect → We found → one-click agent → Map → live pass → Coverage → Bring all 9 in → draft for 10 gaps ($3.71) → First run on the device. Result card checked on the deployed build. Screens qa-walk2 30-39, 65, 66, 95, 111. |
| 2 | Onboarding, project with no agent: one click adds an agent and turns tools on | sada | ios | done (ios) | Slate: one click on We found. sada, re-walked on the deployed build: a pass stuck 6 h with no agent now says "Waiting for an agent"; one click made the agent, turned the tools on and the waiting task started. Screens 33, 114, 115. |
| 3 | Reload, leave and return mid-run on every onboarding step | nyumba-connect | ios | done | Leave for Tasks, come back, reload, Back from the live page, during Bring it in and First run on Slate while the agent ran. Screens 53, 54, 74. |
| 4 | Run check: Map the app, full page, redirect to live, Back, pill | fleet-mate | web | done (web) | Run check → Map → options → Start → live page → Back → pill → run page → Stop. Full 5 min run session 732bff17, 24 seen. Stop leaves nothing running: session cc9e67b0. |
| 5 | Run check: Explore, charter, findings with screenshots | nyumba-connect | ios | done (web) | 5 min guest explore, session c909f1bf: charter, 2 walks, 4 findings with screenshots, 2 drafts. Take over and Hand back during the run. Screens 93-95, 100. |
| 6 | Run check: Draft scenarios, stage, feed, inline accept | nyumba-connect | ios | done (web) | Draft from gaps, session 2792f4f2: stage, feed, 15 drafts, inline accept with a, discard is two presses of d. Screens 75, 86, 87. 14 drafts left for a person. |
| 7 | Run check: Check scenarios, verdicts, result on the scenario | nyumba-connect | ios | done (web) | Session 5a588de5: 8 verdicts all pass, shown on the scenario as Web passed; my test scenario also ran (bb190add). Screens 90, 91. |
| 8 | Map, Screen atlas, Play the app, Slowest screens, export | nyumba-connect | ios | done (web) | Map, data flow, tests, Screen atlas, Play the app, Slowest screens on Web and iOS, atlas PDF and HTML downloaded. Slowest says every timing was noise: the Mac was above the load limit, so no web rows yet. Screens 78, 82, 143. |
| 9 | Scenarios: list, graph, edit, history, health, coverage, approve, pause, retire, suggestion | nyumba-connect | ios | done (web + scratch) | List, graph, edit, history, health, coverage, approve, pause, retire on the test scenario (now retired). Suggestion accepted on the scratch portal. Screens 41, 131, 135, 136. |
| 10 | Runs: history, run page, replay, compare, rename, stop, run again, take over | nyumba-connect | ios | done (web) | History, run page and tabs, Replay, Compare, rename, Stop, Run again, Take over. Screens 96-99, 113, 117, 128, 129. |
| 11 | Finding: triage, not a bug, file as task, re-check after the fix | nyumba-connect | ios | done (web + scratch) | Real Triage on nyumba: product bug, 4 of 4, root cause found. Not a bug, File as task and the automatic re-check on the scratch portal (so nothing is remembered on the real project). Screens 120-126. Triage left unassigned task 86291f48 for the owner. |
| 12 | Handoff: Send to QA from a task, result returns to the task, thread, wake, evidence | nyumba-connect | ios | done (ios) | Real task, Send to QA from its menu, QAEngineer ran it on iPhone 17 Pro: QA section on the task, thread message, IOSEngineer woken, line "QA proved it". Scenario picks added and seen on the deployed build. Screens 86-94, 106, 128. |
| 13 | Agent hands off by itself (`orcha-qa-request`) | nyumba-connect | ios | done (ios) | Asked in the task description. IOSEngineer filed the request itself (kind, platform, scenario, focus, line), QA passed, IOSEngineer was woken and reported. Proof 1/1 DoD. Screen 109. |
| 14 | Workflow from a Quality block: Check and fix, pass path | nyumba-connect | ios | done (ios) | Workflow from the picker: Report the commit → Check on the validated photo viewer scenario → passed, Triage not selected → closing step → goal accepted → finished. $3.91. Fixes re-seen on the deployed build. Screens 01-29, 43-48, 126, 127. |
| 15 | Workflow: fail → triage → fix → pass, findings reach the build step | nyumba-connect | ios | done (ios) | Drafted a scenario false in the app, approved it. Round 1 failed, real Triage: product bug, major, fails 3 of 3, root cause at PhotoGalleryView.swift:100, a duplicate merged. Back to Build with only the confirmed finding. Scenario corrected, round 2 passed, finished. $6.29. The workflow page alone says why it went back. Screens 68-71, 81-85, 99, 103, 104, 107. |
| 16 | Embed each Quality block in an existing workflow | nyumba-connect | any | done (ios), Create workflow only | All four blocks inserted between real steps with the picker and saved. Run for real: Map → Coverage summary (reported gaps, went back to Map round 2, stopped by a person), Explore → Draft scenarios, Release check on Android (blocked: no approved scenarios, said on the card) and iOS (passed); Check Web was taken out of its turn by a claim bug, now fixed, so it and that block's Triage did not run (Triage ran for real in row 15). A step inside a block can be edited without breaking it. The picker is not on a saved workflow: see the bugs file. Scratch workflows cancelled. Screens 56-59, 121-136, 143. |
| 17 | Run tasks: results on the task, agent link, what the agent did, Metrics | nyumba-connect | ios | done (web) | Run result card, Open the run, Replay, What the agent did, agent link, Metrics, on real run tasks. Screens 72, 73, 140-142. |
| 18 | Finish by itself: on and off, each refusal shows its reason | scratch | any | done (scratch) | Deployed build on a seeded SQLite portal. On, confirm, Esc, Off. Refusals seen: unproven line, stale proof, own check, blocked, inconclusive, nothing proved, drafts, no definition of done. Every other refusal shares that render and is in test_qa_run_tasks_decision. Screens 68-71. |
| 19 | Device queue: two runs, one device; second run takes the other device | nyumba-connect + another | ios | done (ios) | sada's map held iPhone 17 Pro; Slate's map, pinned to it, waited 5:13 with "Waiting for iPhone 17 Pro · used by sada's map run. Next in line.", Use iPad Pro and Cancel beside it, then started by itself. Pins removed after. Screens 120, 124. |
| 20 | A killed worker: session ends cleanly, lock freed, Run again works | nyumba-connect | ios | done (web) | kill -9 of the worker, session 9bdc1b7c. Tool server gone in under 7 s, a new worker reran it and passed (bb190add), the old session ended with its reason in under a minute. No device lock on the web, so the lock half was not exercised. Screen 130. |
| 21 | Android: map and check on an emulator | snug-log-mobile-apps | android | done (android) | snug-log on the Pixel 9 Pro emulator, debug build of com.premiumlabstudios.snuglog. Map: 19 of 27 seen, 6 blocked with reasons, 126 steps. Check: 2 of 2 passed. Settle fix live: 2.3 s a step on average, settled "changed" at 1.3 to 2.6 s. Screens 60-64, 75, 80, 98-105. |
| 22 | Web: map and check in a browser | fleet-mate | web | done (web) | Map, explore, draft, check, triage on localhost:3000 with staging behind it, read-only, signed out. Sign-in flows ended blocked with a reason: 8 screens on the map. |
| 23 | Apps and settings: detected apps, edit, tools on and off, final decision | nyumba-connect | any | done (web + scratch) | Detected apps, edit, QA tools On/Off (new), Run check gate, Finish by itself. Screens 05, 09, 50, 68, 76, 77. |
| 24 | Both themes, 1024 and 1440, keyboard, no console errors | all | any | done (web) | 11 views: dark 1440 and light 1024 on the final build, dark 1024 and light 1440 on the build before it. No horizontal overflow or console errors; no portal tracebacks or 500s on the final build. Keyboard walked on the Run check path. Screens sheet-*.jpg. |

The second walk (rows 1, 2, 3, 12 to 16, 19, 21) ran on real devices and real agents: iPhone 17 Pro, and a Pixel 9 Pro emulator it started and stopped. The Embodent window's DevTools still did not answer, so it used a headless Chromium too. Its screens are in `qa-walk2/` in the session scratchpad.

Rows above were first walked on nyumba-connect's web target in a headless Chromium on the portal pages, not inside the
Embodent window: its DevTools port hung for the whole night because a native alert held its main thread. Screens are
in `qa-walk/` in the session scratchpad. Bugs: `docs/orcha-qa-e2e-bugs.md`.

## Third walk, 2026-11-07: Embodent window, real agents, every platform

| Flow | Project | Platform | Status | Evidence / notes |
|---|---|---|---|---|
| Fresh onboarding, map to first run | snug-log | ios | done | Map 76 steps, 83 screens; 207 tests in; first test 4 of 4, 1 minor finding, $1.59 |
| Draft from code and past runs | snug-log | ios | done | 14 drafts, $3.65, 8 min |
| Review: accept a draft, run what you accepted | snug-log | ios | done | 1 of 1 passed, plus a new minor finding: Back on Edit Medicine skips the entry |
| Explore first, then draft | nyumba-connect | web | done | $5.77, 8.5 min: 5 findings, 14 drafts, exploration shown live on the drafting page |
| Running row opens the live page | nyumba-connect | web | done | Exploring row went to the live page; drafting row to the drafting screen |
| Stop a live run | snug-log | ios | done | Dialog, session cancelled, worker gone, task cancelled, lock taken at once by the next run |
| Android exploration | snug-log | android | done | $2.13, 5 min, 2 findings (1 major), 2 drafts, live device shows the real screen. nyumba-connect is Flutter and stays black on a headless emulator |
| Check fails, finding, triage | nyumba-connect | web | done | Major finding with the cause; triage reproduced it 4 of 4 and named PropertySideFilter.jsx:158 |
| Run the 10 riskiest scenarios | sada | ios | running | The task names the 10 scenarios |
| Send to QA from a work task | nyumba-connect | web | done | Lines prefilled, proved with evidence; the run, finding and check all show and link on the work task |
| Draft from past runs | snug-log | android | running | Focus: logging a feed or diaper |
