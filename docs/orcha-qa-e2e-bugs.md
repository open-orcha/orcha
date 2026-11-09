# Quality tab end-to-end walk: bugs found and fixed

Found walking the deployed build on nyumba-connect's web target (localhost:3000, staging behind it).
The Embodent window's DevTools did not answer (a native alert holds its main thread), so the walk used a
headless Chromium of its own on the same portal pages. Newest at the bottom. Rows 36 on come from the second walk (workflows, handoff, a fresh project, Android).

| # | Where | What was wrong | Fix | Test |
|---|---|---|---|---|
| 1 | Onboarding, We found | The Live pass platform picked on the sheet was dropped: it said "any booted simulator" on the Map step and would have run on iOS | `confirm` now carries the platform; the server keeps it and the Map step reads it | `test_the_live_platform_a_person_picks_is_what_the_map_step_runs`, `state.test.ts` |
| 2 | Workflow blocks | Multi-platform step titles read "Check ios" | Uses the platform's name | `test_a_release_check_names_each_platform_as_people_do` |
| 3 | Finish by itself | Thread line and notification said "Finished by Quality" | Uses the setting's words, "Finished by itself"; old lines still parse | `test_qa_run_tasks.py`, `TasksPage.parity-r1.test.tsx` |
| 4 | Overview cards | "not reached yet" cut to "not reached..." at 1440 | Label may take three lines and breaks on words | looked at on the deployed build |
| 5 | Runs home | "What Embodent understands com.nyumbaniconnect.ios to be" (a URL on the web) | Says "this app" | looked at on the deployed build |
| 6 | Scenarios, Web | "No scenarios match the current filters." with no filter on and none on the platform | Says there are none on this platform yet and what to do | looked at on the deployed build |
| 7 | Scenario panel | Dependencies listed iOS scenarios for a Web-only scenario, which can never run first | Only scenarios that run on the same platform; one already set stays listed | typecheck, looked at on the deployed build |
| 8 | Apps | QA tools could be turned on but not off, or even seen, from the app | QA tools On/Off in QA settings (`POST .../qa/setup/tools/off`, a person) | `test_tools_status_and_turning_them_on` |
| 9 | Run page | A map run's way back said "Back to exploration · Exploring" | Says mapping | `exploration-way-back.test.ts` |
| 10 | Onboarding, Map | "29 of 266 screens seen" on a Web pass counted every platform's | Counts the pass's own platform | `live-pass.test.ts` |
| 11 | Run page, 1024 wide | The stacked Activity panel left the watch about 90 px | The watch keeps 500 px and the page scrolls | looked at on the deployed build |
| 12 | Runs home, cards | A map or check in progress said "Exploring now" / "Exploring"; "Nothing has run yet" while the first run was going | Status word follows the run's kind; "The first one is running" | typecheck, looked at on the deployed build |
| 13 | Run report | "405 findings" beside tabs saying 115 | Counts one row per measured check, like the lens tabs | looked at on the deployed build |
| 14 | Onboarding, Map | "17 of 9 main areas seen" | Reached is capped at the pass's targets; a deeper pass aims at every screen | looked at on the deployed build |
| 15 | Onboarding, resume | Coming back after the map finished skipped Coverage and landed on Bring it in | Coverage first until Bring it in has started | `OnboardingFlow.test.tsx` |
| 16 | Onboarding, Bring it in | A Web pass drafted Android and iOS screens (the task is one platform, the gaps were all three) | Gaps stay on the platform of the pass | `test_gaps_and_the_first_test_stay_on_the_picked_platform` |
| 17 | Onboarding, First run | The first test was an iOS scenario on a Web onboarding | The first test stays on the picked platform when it has one | same test, looked at on the deployed build |
| 18 | Finish by itself | "Came to a person" was recorded and sent while the run was still going, then the task finished by itself | Nothing is decided while the task's run is open; its end decides | looked at on the scratch portal |
| 19 | Run result card | Device said "desktop"; build said the agent's task checkout's commit, not what the dev server served | "Desktop (1280×800)"; the project's main checkout commit | typecheck |
| 20 | Drafting | "first drafts usually land in 1 to 2 minutes" still showing at 4 minutes | "within a few minutes" | `work` tests |
| 21 | Setup gate | "Check tools are off for this project" | "QA tools are off for this project" | looked at on the deployed build |
| 22 | Triage | No way to file a finding as a task from the inbox; the time column drifted; nothing said which platform; a filed finding stayed Untriaged and in the count | File as task and Dismiss in the inspector; platform on each row; aligned; a filed finding moves to Recently decided | `test_a_finding_filed_as_a_task_leaves_untriaged_and_names_its_platform` |
| 23 | Drafting | A Web drafter's stage and its screen labels came from iOS explorations | Past explorations of the same platform only | `test_qa_drafting.py` |
| 24 | Onboarding estimates | Draft for 10 gaps said about $0.60, real $5.71; a first test said $0.15, real $1.03 to $1.26 | Drafting is per gap; a check is a start plus each scenario, fitted to real runs | `test_qa_onboarding_portal.py` |
| 25 | Run header | 19 screens beside 17 everywhere else | Counts the map's screens, then hashes | `run-counters.test.ts` |
| 26 | Run line | While a person held the device the Activity line said the agent was working | "A person has the device: QAEngineer waits until it is handed back" | `test_a_person_at_the_device_is_what_the_run_says` |
| 27 | Stop | Stop ended the session but not the agent, which went on spending while it looked for why its session had ended | A person's Stop also stops the worker on that task | `test_a_person_stopping_a_run_stops_its_worker` |
| 28 | Stopped runs | One run read both Cancelled and Stopped | Stopped everywhere | looked at on the deployed build |
| 29 | Stop | After a person's Stop the task stayed open, so the next wake started a new run of the same thing | A person's Stop cancels a run's own task (a workflow step stays the workflow's); the thread no longer says it stays open | `test_a_person_stopping_a_run_closes_its_task_so_no_wake_starts_it_over` |
| 30 | A killed worker | The task's new worker started a new session while the dead one stayed Running for up to 15 minutes, and its tool server and browser stayed behind | A session a new worker replaced ends with that reason; the tool server exits with its agent | `test_a_session_a_new_worker_replaced_ends_with_that_reason`, `test_the_tool_server_knows_when_its_agent_is_gone` |
| 31 | Run page | A chip read lowercase "abandoned" | "Stopped responding" | looked at on the deployed build |
| 32 | Compare | "322 fixed": findings on screens the later run never reached counted as fixed | They count as not checked, and the page says so | `exploration-compare.test.ts` |
| 33 | Triage | The task said "QA triage: the app"; queued said it waits for a device, on the web too | The task names the finding; queued names the agent and the device | `test_qa_handoff_triage.py` |
| 34 | Stop | Stopping a run still woke the agent to tell it the task closed, about $0.90 for nothing | A Stop closes the task without a wake | `test_a_person_stopping_a_run_closes_its_task_so_no_wake_starts_it_over` |
| 35 | Run page | Pressing Run check left the keyboard focus on the page body | Each view opens with focus on its title | looked at on the deployed build |
| 36 | Workflow draft | The bar said to choose Review start, which sat disabled behind ⋯ until a step was prepared | Says to open each step and choose Prepare task; Review start once one is prepared | `WorkflowsPage.test.tsx` |
| 37 | Workflow page | "Needs your input · 0 decisions" in warning amber on every workflow | The strip goes quiet when nothing waits | typecheck, looked at |
| 38 | Prepare task | The button stayed dead with no reason when Done when was empty | Says what is missing | typecheck, looked at |
| 39 | Review start | Nothing was ticked, so Check selected tasks was dead with no reason | What can start comes ticked; a step a person holds does not | `WorkflowMutations.test.tsx`, `WorkflowImpact.test.tsx` |
| 40 | Blocks | A closing step called "Next": "Passes → Go to Next" | "Sum up" | `workflowBlocks.test.ts`, `test_qa_run_tasks_blocks.py` |
| 41 | Step rows | "This task is not waiting to take a turn" and "The previous turn has not been released" on every running or finished step, "The workflow is not active" on finished ones | Only what really holds a step up shows | `heldBy`, workflow tests |
| 42 | Workflow title | A blue focus box around the title on arrival | Gone | looked at |
| 43 | Loops | Step chips were tall ovals with a floating checkbox | One line | looked at |
| 44 | Route | The search icon sat on the placeholder | Fixed | looked at |
| 45 | Quality step | "Quality is waiting to start" while its agent worked for minutes | "Quality is getting ready", on the card, the chip and the mark, Triage too | `qualityRounds.test.ts` |
| 46 | Quality step | "The current commit is 87120a0d" was not read as a commit, so the Check got a deleted branch and rebuilt the app | A step's commit in plain words reaches the Check | `test_a_build_step_saying_its_commit_reaches_the_quality_step` |
| 47 | Request summary | "Quality check on ios passed" | iOS | `test_a_summary_names_the_platform_as_people_do` |
| 48 | Onboarding, We found | After one-click Add a QA agent it still said to run `orcha qa enable` | Sentence gone; the gate says it when tools are really off | looked at |
| 49 | Onboarding, reload | A reload on Bring it in, or on First run after Skip, went back to Coverage | The address's step holds | looked at |
| 50 | Onboarding | "1 areas", "1 screens" | Singular | looked at |
| 51 | Onboarding, tests | XCUITests counted as covering Android screens; "205 UI tests tied to 28 screens" beside "99 tests" | A test counts on its own platform; the note counts tests that reach a screen | `test_a_test_only_counts_on_its_own_platform` |
| 52 | Coverage | "screen:ios:paywall untested", Paywall listed twice with no platform, risk read "5500 of 100" | Screen's name, platform when there are two, 0 to 100 | `onboarding-map.test.ts` |
| 53 | Map | Android's status bar named a screen "T-Mobile, signal full."; iOS "Dismiss context menu" | Device chrome never names a screen; the dismiss layer is a control | `test_the_device_chrome_never_names_a_screen` |
| 54 | First run | "Run the smoke suite (11)" with 1 scenario, after Skip | Counts what exists | `test_qa_onboarding_portal.py` |
| 55 | First run | The result card was never seen: the run's way back landed on Overview | Back from the first run opens the card once | `qaLogic.test.ts` |
| 56 | Overview | Platforms with no app showed rows of zeros and "An agent with the QA map skill fills this in" | One line and a link to Apps | `QaPage.test.tsx` |
| 57 | Finish checklist | "This action is not available in the current state" | Says the list below is what is left | typecheck |
| 58 | Review history | A finished loop said "Round 2 · in progress", "No review rounds recorded yet", "Round limit 5 · used 0" | "finished", and the empty lines go when the loop's rounds are listed | `WorkflowHistory.test.tsx` |
| 59 | Send to QA | No way to pick the scenarios; a focus could only ask nicely | Scenario picks, as on a workflow step | `QaRequests.test.tsx`, typecheck |
| 60 | Finished workflow | The main button stayed Finish checklist | Run again | `WorkflowsPage.test.tsx` |
| 61 | Notifications | "Qa result" | "Quality result" | looked at |
| 62 | First run | "Your first test passed" said nothing of the 3 findings the same run filed | The card says how many and links to Triage | looked at |
| 63 | First run | Clicking the Overview tab on the result card did nothing | Leaving the step closes the card | looked at |
| 64 | Onboarding, no agent | The live pass said "Waiting for a device" and the pill "Mapping · 6:36:35" when nothing could run: no agent | "Waiting for an agent" in both | `qaLogic.test.ts` |
| 65 | Blocks | Editing a Map step in a block offered Coverage summary as the step it tests and made a cycle, so the draft could not be saved; any edit also rewrote the block's outcomes and loop | A step tests what comes before it, and an edit keeps the block's wiring | `workflowBlocks.test.ts` |
| 66 | Run page | A map run read "Exploring", with an Explore phase | "Mapping" and Map; a check says Checking and Check | looked at |
| 67 | Run check | The device menu did not say who had a device | "sada's map run has it" beside it | typecheck, looked at |
| 68 | Tests | Four shell, Home and Code tests failed since an outage takes three lost reads (`OUTAGE_FAILURES`) | They wait for the third read. Retry on a failed project page now takes about 9 s to show | `Shell.parity-r2`, `HomePage`, `CodeSpacePage` tests |
| 69 | Map | Chrome, opened from a link, went on the app's Android map as "Make Chrome your own" | Android only maps the package under test | `test_another_app_in_front_stays_off_the_android_map` |
| 70 | Stopped step | A Quality step its owner stopped said "Quality is waiting to start", with 0 decisions | "Stopped. Map waits for the owner", and the strip counts it | `qualityRounds.test.ts` |
| 71 | Blocked step | "Quality could not test it" with no reason on the workflow page | The agent's first sentence: "No validated scenario exists for Android" | `qualityRounds.test.ts` |
| 72 | Serial workflow | `/orcha-next` claimed a step waiting for its turn: Check Web read Running with no worker, no action and no way on, while Check iOS ran | A workflow's steps only start from its scheduler | `test_a_step_waiting_for_its_turn_cannot_be_claimed_with_next` |

## Still not right

- **Proof labels:** the server still sends only Quality, tests and changes. It has no CI or review data for a task, and adding them would change what can finish a task by itself, so that is the owner's call.
- **Embodent window:** its main process sits on a native alert, so DevTools never answered. `desktop/src/main` shows no such dialog of its own, so it is probably Electron's uncaught-error box. Not confirmed: the screen was locked.
- **Behaviour change to check:** a person's Stop now cancels a run's own task. The old test said the task stays; on a real project that meant the next wake started the run over.
- **Run tasks without a cost:** a killed worker reports no cost, so the run card and Metrics under-count it.
- **Blocks on a saved workflow:** "Add a Quality workflow" is only in Create workflow. The plan says "creates or edits", but Add new tasks on a saved workflow has no picker, and a block needs tasks, a repeat group and new dependencies saved together, which the workflow API takes in three calls. Owner's call whether to build it.
- **An old stuck task wakes on unrelated events:** nyumba-connect's `dfb86411` (QA onboarding: first run on iOS, from early on the 6th) stays In progress with no worker. A workflow acceptance woke QAEngineer on it (wake `decision_made`), it spent $1.03 re-running a check, left without finishing the task, and its session ended abandoned. The serial workflow waited 8 minutes for the agent meanwhile, saying only "Waiting for its turn". A run task whose worker left should go to a person, not wait for the next wake. Not fixed: it needs a decision on what a dead run's task becomes. Cancelling the task stops it.
- **Coverage summary's verdict on the map:** on nyumba-connect the agent found the map's own count off: 16 duplicate rows and 9 reached screens not marked seen. Not looked into.
- **Stop on a workflow step still spends:** a worker told to stop within seconds of starting cost $0.93 reading why.
- **Old names on the maps:** screens already on a map keep their names (snug-log's "T-Mobile, two bars.", "Make Chrome your own"; Slate's "Dismiss context menu"). The fixes stop new ones.
- **sada:** its onboarding stands at Coverage after the one-click walk, ready for the owner.
- **Run all from First run spends without asking:** after Bring it in, the button runs every draft (Snug Log: 210, about 7 h, $64) on one click. It was labelled a smoke suite; it now says what it is. A real smoke set or a confirmation is still open.
- **First test estimate:** "about 2 min, $1.30" took 6 min 35 s and cost $1.59 on Snug Log under heavy load (load average above 400).
- **A task handed to QA showed only its request row:** the run and findings live on QA's task. Fixed: `GET /api/tasks/{tid}/qa` includes what its requests' QA tasks produced, and QA's run card links back to the work. Checked on nyumba-connect's handed-off task.
- **A silent device start:** Snug Log's map took about 6.5 minutes on "asking for a device". Fixed: `result.starting` carries each stage to the run page, and clears once the device is open.
- **A drafting run opened the device page:** Steps 0, "Connecting", no device, because drafting uses none. Fixed: a draft session always opens the drafting screen.
- **Smoke suite named nothing:** its task said "Check the validated scenarios", and none is validated after Bring it in. Fixed: the 10 riskiest scenarios, named in the task.
- **Drafter and explorer do not pair live:** the tools and the board came over from the original, but the Draft form never starts a second agent, and one tool server runs one session. "A new exploration" explores first and then drafts. Open: keep that as the design.
- **Scenario examples read after the lint:** `propose_scenario` warned "has no value" for every Examples column, so agents revised good drafts and paid for it. Fixed.
- **A map, exploration or draft run said "failed" when it found bugs:** it now says "Found problems". Only a check fails.
- **30 s for an app launch:** a launch took 100 s on a busy Mac and every scenario start failed. Now 150 s.
- **Confirm dialogs had no styling:** rendered outside `.qa-port`, so a native black border. Fixed at the root, for every Quality confirm.
- **A long task name broke the compact header:** the chip now truncates at 320 px.
- **223 scenarios opened as a map:** past 40 the tab opens on the list; Map stays one click away.
- **A freshly booted simulator can be half up:** `simctl boot` printed a launchd_sim error and launches stalled until a restart. Not ours, but a boot under heavy load needs a restart check.
- **A software-rendered emulator shows a black Flutter app:** start it with the hardware GPU.
- **A false pass on the run page:** with an Examples table, the run page, the scenario page and the health reads kept the last row's verdict, so a row that passed hid a row that failed. The task said Failed, the run said 1/1 passed. Fixed: `qs.newest_verdicts` and `worstVerdicts` keep each row and take the worst.
- **A failed check showed a green 85 "Good":** a check now shows scenarios passed of total, no score, here and on the Runs list.
- **Run what you accepted ignored the platform and the selection:** a web draft opened the check on iOS with every approved scenario. It now keeps the session's platform and runs only what was accepted.
- **Starting triage gave no feedback:** the finding now says "Triage is running. Open it".
- **The run page's finding left out the diagnosis:** it now shows it. A triage that confirms a bug reads "Bug confirmed", not "Failed".
- **A finding's id in a verdict note:** the tool strips it.
- **Open: no explanation for a black preview:** a Flutter app on a headless emulator shows a black screen with no reason given. Documented in setup; the page could say why.
- **A long Quality run was cut at 20 minutes and started over:** the worker hard cap replaces a worker with a fresh one, but a Quality session dies with its worker. A 15-scenario check lost its progress at exactly 20:00, and a drafting worker was replaced before it could mark its task done, which then repeated the whole draft. Fixed: a Quality task's worker gets `QUALITY_CAP_SECS` (90 minutes); the stall detector still catches a stuck one.
