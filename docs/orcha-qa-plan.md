# Orcha QA: mapping, exploration and scenario drafting (iOS, Android and web)

Status: in build on `feat/orcha-qa` (from `main`). Source of the port: Verdikt
(`~/Desktop/future/mobile_automation/verdikt`, main). This file is the contract every part of the
build follows; change it here first when a part needs a different shape.

## Goal

Orcha agents can map an app, explore it, draft QA scenarios from what they walked, and check
approved scenarios, on an iOS simulator or an Android emulator, without Verdikt installed. A
human approves every scenario (draft → validated), the same rule as task verification. The UI is
Verdikt's (map, scenarios, explorations), rebuilt in Orcha's design system as a **QA** project tab.

Web was added on 2026-11-05 (Playwright Chromium, Verdikt `sessions/web.py`). Out of scope for
now: desktop (Electron) targets, physical devices, cloud devices, Verdikt's own
site/worker/queue, model backends, judge, replays, suites. The existing Verdikt HTTP integration
(`verdikt_*.py`) stays as it is; it is an optional outside runner.

## How it fits Orcha

| Verdikt | Orcha |
|---|---|
| project / app | container + `qa_targets` row per platform |
| `/qa` exploration run, `/qa-suite` drafting run | an Orcha task worked by an agent with the `orcha-qa-*` skills; the agent's QA work is a `qa_sessions` row linked to the task |
| charter (self-approved) | the task plan (opening message) the human approves when the task's autonomy is off |
| walk finding | `qa_findings` row; in a workflow, also reported through the step's outcome (`POST /api/tasks/{tid}/outcome`, kind `failure`) |
| draft → validated scenario | `qa_scenarios.status`; only a human may set `validated`, `paused`, `retired` |
| suggestion against a validated scenario | `qa_scenario_suggestions`, accepted/dismissed by a human |
| app map, features | `qa_map_nodes`, `qa_map_edges`, `qa_features`, per container and platform |
| MCP tool server | `orcha qa mcp` (stdio), package `orcha_cli/qa/` |

The map is never a gate. Agent work still stops at `needs_verification`.

## Layout

```
orcha-cli/orcha_cli/qa/
  __init__.py
  cli.py              # `orcha qa doctor|mcp|map build|targets` (wired into the orcha parser)
  config.py           # finds .claude/orcha.json, api base, container id, acting agent
  portal.py           # tiny HTTP client for the /qa routes (urllib, no new deps)
  device/             # the device layer (ports Verdikt drivers + sessions: iOS, Android, web)
    web.py            # WebSession over Playwright Chromium (from sessions/web.py + web_extractor.js)
    tree.py           # Element, compact(), tree hash          (from recording/tree.py)
    targets.py        # Target parsing: ref "e12" | text | x,y  (from recording/targets.py)
    screen.py         # Screen, text for the model, jpeg helpers (from sessions/protocol.py)
    base.py           # DeviceSession protocol
    ios_idb.py        # idb_companion + fb-idb client             (from drivers/ios_idb.py)
    ios.py            # IosSession                               (from sessions/ios*.py, slimmed)
    android_u2.py     # uiautomator2 driver                      (from drivers/android_u2.py)
    android.py        # AndroidSession                           (from sessions/android.py, slimmed)
    locks.py          # simulator/emulator lock dirs (/tmp/claude-sim-lock-<name>)
  mcp_server.py       # MCP tools (below); one process per agent session
  session_state.py    # the live session: steps, frames upload, budget, walk in progress, live view
  scenario_format.py  # scenario markdown v3 parse/render/lint  (from scenarios/parser.py, lint.py)
  checks.py           # check grammar used in criteria           (from verdicts/checks.py, subset)
  walk_to_scenario.py # a passed walk → a draft scenario         (from workflows/to_scenario.py, slimmed)
  codemap/            # code readers: Swift/SwiftUI, Kotlin/Compose, Flutter, RN/Expo (from app_map/code*.py
                      #   + exploration/feature_map.py); output is the /qa/map/import payload
orcha-cli/orcha_cli/templates/
  migrations/093_qa.sql, migrations/sqlite/023_qa.sql
  portal/portal_backend/qa_store.py, qa_map.py, qa_routes.py, qa_scenarios.py, qa_drafting.py, qa_drafting_routes.py
  portal/frontend/src/pages/qa/*
  skills/orcha-qa-map.md, orcha-qa-explore.md, orcha-qa-draft.md, orcha-qa-check.md
tests/test_qa_*.py
```

Python deps are an optional extra so the base CLI stays light:
`orcha-cli[qa]` = `mcp>=2.2`, `fb-idb>=1.1.7`, `uiautomator2>=3.5`, `adbutils>=2.9.3`, `pillow>=10`.
Install: `uv tool install --force --reinstall --no-cache './orcha-cli[qa]'`. Host tools:
`idb_companion` (brew `facebook/fb/idb-companion`), Xcode `simctl`, `adb`. `orcha qa doctor`
reports each. Import device modules lazily: `import orcha_cli` must not need the extra.
Keep code Python 3.10 compatible (`from __future__ import annotations`, no PEP 695).

## Data model (migration 093 / sqlite 023)

All ids are UUID text, timestamps `TIMESTAMPTZ` (sqlite: text ISO), JSON is `JSONB` (sqlite:
text). Every table has `container_id` → `containers(id)`. `platform` ∈ `ios|android|web`.
For web, `qa_targets.app_id` is the start URL (http/https) and `device_name` is the viewport
(`desktop` 1280x800 or `mobile` 390x844); a web session stays on the target's origin.

- `qa_targets` — `(container_id, platform)` PK; `app_id` (bundle id / package), `app_name`,
  `build_path` (optional .app/.apk to install), `device_name` (default simulator/emulator name),
  `notes` (sign-in identity hints; never a password), `updated_at`, `updated_by_agent_id`.
- `qa_features` — `id`; `key`, `name`, `summary`, `entry`, `paths` JSON, `source`
  (`code|exploration|manual`), `last_explored_at`; UNIQUE `(container_id, key)`.
- `qa_map_nodes` — `id`; `platform`; `kind` (`screen|endpoint|entity|flow`); `key`; `label`;
  `feature_key`; `state` (`seen|declared|blocked`); `blocked_kind` (`needs_sign_in|needs_data|
  needs_permission|paywall|external|crash|other`); `blocked_reason`; `sources` JSON (list of
  `code|tests|live|crawl|agent`); `evidence` JSON (one part per source, Verdikt's shape);
  `detail` JSON; `frame_id`; `last_seen_at`; timestamps; UNIQUE `(container_id, platform, kind, key)`.
- `qa_map_edges` — `id`; `platform`; `kind` (`navigates|calls|reads|writes|steps`);
  `from_node_id`, `to_node_id` → nodes (cascade); `label`; `count`; `sources`; `evidence`;
  `detail`; UNIQUE `(container_id, platform, kind, from_node_id, to_node_id, label)`.
- `qa_map_builds` — `id`; `platform`; `source`; `status` (`running|done|failed`); `counts` JSON;
  `error`; `started_at`, `ended_at`; `agent_id`.
- `qa_sessions` — `id`; `kind` (`map|explore|draft|check`); `platform`; `task_id` (nullable →
  tasks); `agent_id` (nullable → agents); `device_name`, `device_udid`; `app_id`; `status`
  (`running|done|failed|cancelled|abandoned`); `budget_minutes`; `goal`; `briefing` JSON;
  `charter` JSON (missions `{id,title,why,status active|covered|partial|blocked|bug,note,
  finding_ids}`); `result` JSON; `report_md`; `started_at`, `ended_at`, `last_seen_at`;
  `draft_sources` (`code|exploration|both`, mig 095).
- `qa_session_messages` (mig 095) — `id`; `session_id` (cascade); `seq`; `kind` (`note|read|search|
  draft|plan|request|answer|correction|feedback`); `title`; `body` JSON; `scenario_id`; `frame_id`;
  `reply_to`; `status` (a request: `open|claimed|answered|timed_out|cancelled`); `agent_id`;
  `created_at`. What a drafter says; see "Drafting".
- `qa_frames` — `id`; `session_id`; `path` (under the attachments dir: `qa/<cid>/<sid>/<id>.jpg`);
  `width`, `height`; `screen_hash`; `created_at`. Served by `GET /api/qa/frames/{fid}`.
- `qa_steps` — `id`; `session_id`; `seq` (UNIQUE with session); `kind` (`screen|tap|type|swipe|
  press|open_url|launch|terminate|wait|note`); `args` JSON; `result` text; `screen_key`;
  `screen_hash`; `frame_id`; `at`.
- `qa_findings` — `id`; `session_id`; `task_id`; `severity` (`blocker|major|minor|trivial`);
  `title`; `detail`; `expected`; `actual`; `frame_ids` JSON; `start_seq`, `end_seq`;
  `screen_key`; `status` (`open|filed|dismissed`); `filed_task_id`; `created_at`.
- `qa_flows` — `id`; `platform`; `key`; `name`; `persona`; `criticality` (`high|medium|low`);
  `steps` JSON (`[{text,screen,check}]`); `data` JSON; `source` (`code|plan|briefing|person`);
  `status` (`queued|walking|passed|failed|unreachable|skipped`); `score`; `rank_reasons` JSON;
  `last_walk_id`; `last_walked_at`; UNIQUE `(container_id, platform, key)`.
- `qa_walks` — `id`; `session_id`; `flow_id`; `status` (`walking|passed|failed|unreachable|
  abandoned`); `blocked_kind`; `reason`; `steps` JSON (`[{index,text,reached,result,checked[],
  finding_id,frame_id,seq,screen_key,at}]`); `start_seq`, `end_seq`; `scenario_id`;
  `finding_ids` JSON; `started_at`, `ended_at`.
- `qa_scenarios` — `id`; `platform`; `name` (UNIQUE with container+platform); `category`;
  `persona`; `description`; `criteria` JSON (2–12 strings); `checks` JSON; `data` JSON; `needs`
  JSON; `tags` JSON; `depends_on` JSON; `source` (`authored|generated|walk`); `status`
  (`draft|validated|paused|retired`); `status_reason`; `walk_id`; `session_id`; `task_id`;
  `created_by_agent_id`; `validated_by_agent_id`; `validated_at`; `created_at`, `updated_at`.
- `qa_scenario_evidence` — `id`; `scenario_id` (cascade); `criterion_index`; `status`
  (`verified|unconfirmed|code_only`); `frame_id`; `code_ref`; `note`.
- `qa_scenario_suggestions` — `id`; `scenario_id`; `proposed` JSON; `reason`; `status`
  (`proposal|accepted|dismissed`); `session_id`; `agent_id`; `decided_by_agent_id`; timestamps.
- `qa_session_logs` (migration 095 / sqlite 025) — `session_id`; `seq` (unique per session); `step_seq`; `at_ms`; `level` (error, warn, info, debug); `source` (console, network, device, crash); `text`; `detail`. The run page's Logs tab. Written by `POST /api/qa/sessions/{id}/telemetry`, idempotent on seq.
- `qa_session_requests` (095 / 025) — `session_id`; `seq`; `step_seq`; `at_ms`; `kind` (fetch, xhr, document, other); `method`; `url`; `status`; `duration_ms`; `failure`; `request_body`. The run page's API tab, web sessions only. Credential values are scrubbed from URLs and bodies before they leave the machine.
- `qa_criterion_feedback` (095 / 025) — `session_id`; `scenario_id`; `criterion_index` (unique together); `status` (not_a_bug, acknowledged, resolved); `note`; `agent_id`. A person's answer to a verdict; it changes no verdict.
- `qa_verdicts` — `id`; `session_id`; `scenario_id`; `criterion_index`; `verdict`
- Routes in `qa_explorations_routes.py`: person only `PATCH /api/qa/sessions/{sid}/keep`, `POST .../again`, `POST .../duplicate`, `POST C/sessions/queue`, `PATCH /api/qa/findings/{fid}/severity`; members `POST /api/qa/findings/{fid}/scenario`, `POST /api/qa/sessions/{sid}/measured`, `GET C/app-model`
- `qa_measured` (095) — `id`; `session_id`; `fingerprint` (unique per session); `kind`; `severity`; `summary`; `measured`; `threshold`; `unit`; `rect`; `element_label`; `element_identifier`; `appearance`; `confident`; `extra`; `screen_key`; `screen_hash`; `frame_id`; `step_seq`: what the audit measured on a screen, apart from what an agent judged
- `qa_app_models` (095) — `container_id`; `platform`; `version`; `source` (briefing, plan, walks, person); `summary`; `model`: what the agents understand the app to be, a numbered version per change
- `qa_sessions` (095 adds) `name`, `notes`, `archived_at`, `pinned_at`, `series_id`, `previous_session_id`, `queued_at`, `claimed_at`: what a person keeps, the series, and queued until an agent takes the row
- `qa_findings` (095 adds) `lens`, `fix_prompt`, `severity_reported`, `severity_by`, `severity_reason`, `scenario_id`
  (`pass|fail|blocked|inconclusive`); `note`; `frame_ids` JSON; `created_at`.
- Migration 095 adds to `qa_scenarios`: `status_until`, `status_issue`, `replaced_by`, `quarantined_at`,
  `quarantine_reason`, `quarantine_clean_runs`, `quarantine_released_at`, `fresh`, `permissions`, `session`,
  `shared` (runs on every platform), `examples`, `seed`, `cleanup`, `events`; and to `qa_verdicts`:
  `check_fix`, `check_repairs`, `example_row`.
- `qa_scenario_versions` — `scenario_id`; `version`; `snapshot` JSON (`status_note` on a status change);
  `saved_by_agent_id`; `saved_at`. Written on every change (`qa_scenarios.save_version`).
- `qa_scenario_health_flags` — `scenario_id`; `kind`; `reason`; `action`; `detail` JSON; `first_seen_at`;
  `seen_at`; `dismissed_at`; `dismissed_by_agent_id`. `qa_scenario_health_audits` — `container_id`;
  `computed_at`; `total`; `counts` JSON.
- `qa_check_fix_dismissals` — `scenario_id`; `criterion_index`; `expression`; `proposed`.
- `qa_coverage_baselines` — `day`; `trigger_kind`; `reason`; `app_build`; `evidence_version`; `data` JSON;
  `superseded_at`. `qa_coverage_points` — `day`; `evidence_version`; `data` JSON (one per day).
- `qa_coverage_links` — `scenario_id`; `feature_key`; `state` (`linked`, `confirmed`, `rejected`).
- `qa_data_variations` — `scenario_id`; `technique`; `label`; `row_values` JSON; `row_key`; `status`
  (`suggested`, `applied`, `dismissed`).
- `qa_scenario_files` — `scenario_id`; `file_name`; `size_bytes`; `path`.
- `qa_example_secrets` — `id` (`sec_...`); `scenario_id`; `value`: a sealed Examples cell, never listed.
- `qa_sessions` (095 adds, map and atlas) `build_label`: the build a session ran on (the installed app's version, else `commit <sha>`; "changed since" goes by it); `device_appearance`: what the device was set to; `crawl_queue` JSON: a map session's planned crawl as `crawl_next` moves it (`crawl_queue.CrawlQueue.as_json`)
- `qa_frames` (095 adds) what the CLI read from a frame as it took it, so the portal never decodes one: `fingerprint` (`<16 hex dHash>-<rrggbb>-<w>x<h>`), `appearance` (`light|dark`), `blank` (`uniform|flag_secure`)
- `qa_steps` (095 adds) `duration_ms`; `timing` JSON: `appear_ms`, `settle_ms`, `settled`, `load` per core, `cold` on a session's first launch. Screen timings are read from these (`qa_perf.py`), with no table of samples
- `qa_perf_settings` (095) `container_id`; `settings` JSON: a person's speed budgets and thresholds over the defaults in `qa_perf.py`

## HTTP API (portal; `/openapi.json` is the source of truth)

Container scope `C = /api/containers/{cid}/qa`. Writes carry `actor_agent_id` like every other
route (`trusted_actor`). Agents may write map, sessions, steps, frames, findings, flows, walks,
draft scenarios, evidence and verdicts. Only a human may set a scenario's status, decide a
suggestion, or edit targets. Errors use `HTTPException` with plain sentences.

- `GET C/overview` → counts per platform: screens seen/declared/blocked, features, scenarios by
  status, open findings, last session per kind.
- `GET C/targets`, `PUT C/targets/{platform}`.
- `GET C/map?platform=` → `{features, nodes, edges, last_build}`.
- `GET C/atlas?since=` → the Screen atlas: every screen across platforms, read from the map, steps and
  frames (`qa_atlas.py`, read only).
- `POST C/map/import` — `{platform, source, features?, nodes?, edges?, replace_source?}`; upsert by
  `(kind,key)`, merging `sources`/`evidence` per source (a rebuild of one source never erases
  another; `replace_source` drops that source's part from rows it no longer lists). Returns counts.
  Shapes (what `orcha_cli.qa.codemap.build_payload` emits; `source: "code"`, `replace_source: true`):
  - feature `{key, name, summary, entry, paths[]}` (its `source` is the body's; at most 30 per
    body, so the code payload keeps the 30 with the most screens' code);
  - node `{kind, key, label, feature_key|null, state: "declared", sources: [source], evidence,
    detail}` (`state`/`sources` are informative; the server derives both);
  - edge `{kind, from_kind, from_key, to_kind, to_key, label, sources: [source], evidence,
    detail}` (flat, as `MapEdgeIn` takes it; `from_kind`/`to_kind` default to `screen`): the ends
    name nodes by `(kind, key)` on the same platform; every end is a node of the same body or one
    already stored (an edge whose end the server cannot find is skipped and counted).
  - `evidence` and `detail` in a body are **that source's part**: the server stores them as
    `evidence[source]` / `detail[source]` beside the other sources' parts. The code part's
    evidence is a list of places `[{path, line}]` (repo-relative). Code `detail`: screen `route`,
    `platform`, `framework` (`swiftui|uikit|compose|android|flutter|expo|react-navigation|next|
    pages|react-router`), `name` (human), `entry` (the code's type, route or screen name), `title`,
    `texts[]`, `alerts[]`, `texts_own` (how many leading `texts` are the screen's own code; native
    screens only), `files[]`, `links[]` (`{uri, kind, action?, component?, extras?, label?}`);
    endpoint `method`, `pattern`, `side` (`client|server|both`), `handler`; entity `store`
    (`swiftdata|coredata|room|prisma|api`), `fields[]`. Code edges carry `detail: {}`; a `calls`
    edge is drawn only when the call sits in exactly one screen's code (a shared API client draws
    none). A web screen's key is its route pattern (`/listings/*`), as is an Expo Router one's.
  - Per platform: iOS takes Swift facts, Android Kotlin/Java, the web its Next.js / React Router
    app and the JS servers (Next route handlers, `pages/api`, Express / Fastify / Hono / Koa,
    NestJS) and Prisma models beside it; Flutter and React Native / Expo apps count on both phones
    (and on the web with `react-native-web`) unless that platform's UI is written in its own
    framework. `detect_platforms(repo)` returns the subset of `ios`, `android`, `web`.
- `POST C/map/observe` — `{platform, session_id, title?, texts[], anchors[], frame_id?, from_key?,
  action?}` → `{screen_key, label, state, new}`. Matches a live screen to a node (route-less text
  score, port of Verdikt `app_map/live.py` native matching), marks it `seen`, adds a `navigates`
  edge from `from_key` labelled with the action.
- `POST C/map/blocked` — `{platform, screen, kind, reason, session_id?}`.
- `PUT C/features` — `{features:[{key?,name,summary,entry,paths}], source}` (max 30).
- `POST C/sessions` → session; `GET C/sessions?kind=&status=&task_id=&limit=`.
- `GET /api/qa/sessions/{sid}` → session + walks + findings + steps count + drafts.
- `PATCH /api/qa/sessions/{sid}` — status, briefing, charter, result, report_md, heartbeat.
- `POST /api/qa/sessions/{sid}/frames` — raw `image/jpeg` body (≤4 MB) → `{frame_id}`.
- `GET /api/qa/frames/{fid}` → `image/jpeg` (members read).
- `POST /api/qa/sessions/{sid}/steps` — `{steps:[…]}` batch, idempotent on `seq`.
- `GET /api/qa/sessions/{sid}/steps?from_seq=&to_seq=`.
- `POST /api/qa/sessions/{sid}/findings`, `PATCH /api/qa/findings/{fid}` (dismiss / file as task:
  `{action:"file", title?, assignee_agent_id?}` creates an Orcha task with the finding as DoD
  context and links it).
- `GET C/flows?platform=`; `POST C/flows` — `{platform, flows:[…], source}` upsert by key (key
  from the name when missing); `POST /api/qa/sessions/{sid}/walks/next` → `{walk, flow}` or
  `{walk:null}` when the queue is empty (rank: never walked +40, failed recently +30,
  criticality +30/+20/+10, uncovered +10); `PATCH /api/qa/walks/{wid}` — `{step}` or
  `{outcome, reason?, blocked_kind?}`; a `passed` walk without its last step reached is refused.
- `GET C/scenarios?platform=&status=`; `GET /api/qa/scenarios/{id}` (with evidence, frames, walk).
- `POST C/scenarios` (propose) — returns `{outcome: created|updated|suggested, scenario}`;
  updating a validated scenario files a suggestion instead.
- `PATCH /api/qa/scenarios/{id}` — revise a draft (agents) or any field (humans).
- `POST C/scenarios/status` — `{ids, status, reason?}` (human only).
- `GET C/scenarios/export.md?platform=&status=validated` — scenario markdown v3.
- `GET C/suggestions`; `POST /api/qa/suggestions/{id}` — `{decision: accept|dismiss}` (human).
- `POST /api/qa/sessions/{sid}/verdicts` — `{scenario_id, criterion_index, verdict, note?, frame_ids?}`.
- `GET /api/tasks/{tid}/qa` → the task's sessions, findings, drafted scenarios and verdicts.

### Portal details settled in the build (`qa_routes.py`, `qa_map.py`, `qa_scenarios.py`, `qa_store.py`)

- Map import items. Node `{kind, key, label?, feature_key?, evidence?, detail?}`; a code screen's
  `detail` may carry `texts[]` (its static UI strings), `texts_own` (how many of `texts` are its
  own, the rest come from components it renders), `title`, `alerts[]`, `name`; these feed observe's
  text score and are left out of `GET C/map`. Edge `{kind, from_key, to_key, from_kind?=screen,
  to_kind?=screen, label?, evidence?, detail?}`; an edge whose endpoint is unknown is skipped and
  counted (`edges_skipped`). Each import writes a `qa_map_builds` row (status `done`, counts).
- Observe also takes `screen_hash?` and returns `matched_by` (`code|name|seen|title|new`),
  `states` (keyboard, search, menu, alert) and `node_id`; `new` means the screen was not `seen`
  before. A capture of the device's home screen returns `screen_key: null`. Seeing a screen clears
  its blocked kind; `map/blocked` takes a node key or a screen label, makes an unknown one a node
  (source `agent`), and leaves a `seen` screen `seen`.
- Web (migration CHECKs and every request model take `ios|android|web`): a web target's `app_id`
  must be an http(s) URL and its `device_name` `desktop` or `mobile`. Observe on `web` with a
  `route` collapses it like Verdikt's `keys.route_key` (host, query, fragment, route groups and
  slots dropped; `[id]`, `:id`, `{id}`, `$id`, numbers, uuids, long hex or digit-bearing tokens as
  `*`), meets a screen keyed by a route pattern it fits (fewest `*` first, also without a leading
  locale segment; `matched_by: route`), else the text score, else keys the node by its collapsed
  route (labelled by the title or the route). A site's own 404 page is `not-found`. Native
  platforms ignore `route`. The overview and the targets list include `web`.
- `PUT C/features` upserts by key and never deletes a feature.
- Frames: `actor_agent_id` and `screen_hash` are query parameters; the response is
  `{frame_id, width, height}` (read from the JPEG header).
- Steps batch: at most 500, each seq once per batch; `{inserted, skipped}`.
- Findings: `PATCH` actions are `dismiss`, `reopen` and `file`; filing is refused for a dismissed
  or filed finding and returns the finding plus `task` (the task-creation response). The task is
  created by the finding's filer, through `POST /api/containers/{cid}/tasks`'s handler.
- Flows queue: `walks/next` picks among flows that are `queued` or `failed` and not walked in this
  session yet; "failed recently" is within 7 days; "uncovered" means no walk of the flow is
  linked to a scenario. A walk still walking in the session is returned again (`resumed: true`).
  `walks/next` needs a running session. A flow's status follows its walk's outcome (`abandoned`
  puts it back to `queued`). Ending a session abandons its walking walks.
- Walk steps are 0-based in the portal (the flow's first step is index 0; the MCP tools number
  from 1 and subtract). Each stored step keeps `{index, text, expected, reached, result, checked,
  finding_id, frame_id, seq, screen_key, at}`; a new walk's `expected` starts as the flow step's
  `check`, and an empty `text` never overwrites the flow's. A step past the flow's last one (or any
  step of a flow with no steps) is appended, and the pass rule looks at the last recorded step.
  The walk-end `PATCH` takes `end_seq?` (default: the session's last seq).
- Scenario `checks` is `[{criterion_index: int|null (0-based; null = scenario-level), line}]`,
  at most 50, validated by the request model; an index must name a criterion. It is stored and
  returned in that shape.
- `export.md` renders with `orcha_cli.qa.scenario_format.render_file` (scenario markdown v3, the
  rows' `data` merged into one `## Data` block) when the portal runs in the CLI's interpreter;
  otherwise a minimal renderer: `# name`, `- Key: value` lines, the description, scenario-level
  `Check:` lines, then numbered criteria, each followed by its `   Check:` lines.
- Scenarios: a proposal or an agent's `PATCH` against any non-draft scenario (validated, paused
  or retired, not only validated) files a suggestion; an identical open suggestion is returned
  instead of a second one. Per-criterion evidence is sent as `evidence: [{criterion_index,
  status, frame_id?, code_ref?, note?}]` on propose/PATCH and replaces the scenario's evidence.
  Accepting a suggestion applies it and keeps the scenario's status. Setting `draft` clears
  `validated_by_agent_id`/`validated_at`.
- For the UI: `GET /qa` serves the SPA shell (like `/routines`). Session detail walks carry
  `flow_name` and `flow_key`. Sessions and findings (session detail, session list, task QA,
  overview's last sessions) carry `agent_alias` and `task_title`; findings also carry
  `filed_task_title` (a finding's agent is its session's). Overview has `features_total`, and per
  platform `features`: the features some node of that platform names in its `feature_key`.
- Deleting a task or an agent leaves QA rows in place (their reference is set to NULL); a
  container's QA rows go with the container.


Run page (`qa_runs_routes.py`): `GET /api/qa/sessions/{id}/run` (the page's one document, polled while the session runs), `POST .../telemetry` (log lines and network calls, idempotent on seq), `GET .../logs`, `GET .../requests`, `PUT .../feedback` (human only), `GET .../perf` (the Performance tab), `GET C/qa/live` (the live wall).
## MCP tools (`orcha qa mcp`, stdio, server name `orcha-qa`)

Every tool returns text; failures start with `error:`. Device tools return the settled screen
after acting (Verdikt's habit), so the agent calls `screen` only to look again.

- Session: `start_session(platform, kind, minutes=20, task_id?, app?, device?, goal?)`,
  `screen()`, `tap(target)`, `long_press(target, ms=800)`, `type_text(target, text)`,
  `clear_text(target)`, `swipe(direction, distance_percent=50)`, `swipe_coords(x1,y1,x2,y2)`,
  `press(key)` (home, back, enter, …), `open_url(url)`, `launch_app(app?)`,
  `terminate_app(app?)`, `wait(ms)`, `find(text)`, `capture_evidence(severity, title, expected,
  actual, detail?)`, `end_session(summary)` (refuses while >15% of the budget is left unless
  `force=true` with a reason).
- Map: `read_map(feature?)`, `map_features(features)`, `map_blocked(screen, kind, reason)`.
  Every `screen` result is observed into the map automatically.
- Exploration: `submit_briefing(briefing)` (charter of 3–8 missions), `charter_update(item_id,
  status, note?, finding_ids?)`, `post_plan(flows)`, `next_flow()`, `walk_step(walk_id, index,
  reached, result, checked?, finding_id?)`, `end_walk(walk_id, outcome, reason?, blocked_kind?)`.
  A passed walk is turned into a draft scenario by `walk_to_scenario` and proposed.
- Drafting (no device needed): `list_project()`, `get_scenario(id)`, `propose_scenario(...)`,
  `revise_scenario(id, ...)`.
- Checking: `verdict(scenario_id, criterion_index, verdict, note?)`.

Identity: the server reads `.claude/orcha.json` (walking up from the cwd) for `api_base_url` and
`current_container_id`, and the acting agent from `$ORCHA_ALIAS` → `.claude/orcha-tabs/<alias>.json`
(single-binding fallback as the skills do). Overrides: `ORCHA_QA_API`, `ORCHA_QA_CID`,
`ORCHA_QA_AGENT_ID`.

Devices: iOS uses an already booted simulator by name (default `iPhone 17 Pro`, then the iPad).
It never creates or erases a simulator or downloads a runtime. Before driving a device it claims
`/tmp/claude-sim-lock-<name with spaces as ->` (`mkdir`), and removes the lock at `end_session`, at
exit, or when the portal ended the session. Android uses the first `adb devices` entry in state
`device` unless one is named, with the same lock scheme. The project's usual device is a preference
(any other booted one will do); `device=` on `start_session` is this run's pick and is waited for.

The lock directory stays empty, so a bare `rmdir` always works. Beside it,
`/tmp/claude-sim-lock-<name>.owner` is JSON: `pid`, `started` (`ps` lstart, so a reused pid is not the
owner), `dir` (the directory it belongs to, so a file left by a bare `rmdir` says nothing about the
next `mkdir`), `device`, `claimed_at`, `project`, `kind`, `session_id`, `task_id`. A lock whose owner
is gone is taken at once; a lock with no owner file (another tool's) keeps the 2-hour rule on a shut
down device. The line is `/tmp/claude-sim-queue/<ns>-<pid>.json` (`wants`, the devices, and the same
holder fields): an older ticket goes first on a device it wants, across projects, and a ticket whose
process died or that was not touched for 3 minutes is passed. Only the lock files decide; the portal
shows what the tool server read from them.

Drafting board (mig 095): `draft_progress(note, files, searches)`, `read_screens(wait_s, all)`,
`ask_explorer(question, flow, wait_s)` in a draft session; `next_request()`,
`answer_request(id, answer, found)` in an explore session. `start_session(sources=...)` records what
a draft session reads; `revise_scenario(screen=...)` marks a change corrected from a screen.

## Skills (`templates/skills/orcha-qa-*.md`)

Ported from Verdikt `skills/qa/SKILL.md` (§4 exploration, §4d map), `skills/qa-suite/SKILL.md`
and `skills/test-design/SKILL.md`, rewritten for the tools above and Orcha's task flow:
`orcha-qa-map` (code pass then live crawl), `orcha-qa-explore` (briefing/charter, walk the flow
queue, findings), `orcha-qa-draft` (code + walks → drafts that meet the test-design bar),
`orcha-qa-check` (run validated scenarios, one verdict per criterion). Names start with `orcha-`
so worktrees carry them.

## UI (`pages/qa`, project tab "QA", route `/qa`)

Orcha primitives and tokens only (Linear style; no gradients; lucide stroke 1.75). Views by
`?view=`: `overview` (per-platform cards), `map` (features → screens with state, blocked reasons,
frames; edges as "ways in"), `scenarios` (list by status, detail with criteria, per-criterion
evidence frames, walk filmstrip, Approve / Pause / Retire, suggestions), `sessions` (list; detail
with charter, walks, findings with frames, "File as task"), `targets` (per-platform app id and
device). Task detail gets a QA section from `GET /api/tasks/{tid}/qa`.

## Web (added 2026-11-05)

- Device: `device/web.py` `WebSession(viewport="desktop"|"mobile", headless=True)` satisfies the
  same DeviceSession protocol; `start(url)` opens the page. Every screen adds an `events` block
  (console errors, page errors, failed requests, 5xx responses since the last screen). Navigation
  is limited to the target's origin (plus origins listed in the target's notes as `Allowed:`).
  `press("back")` is browser history. No device lock: each session has its own browser.
- Deps: `playwright` joins the `[qa]` extra; `orcha qa doctor` checks for Chromium and prints
  `playwright install chromium` when it is missing.
- Map: screens on the web are keyed by route; `/map/observe` takes `route` (path with ids
  collapsed) and matches by route first, text second. The code map gains the web readers
  (Next.js app/pages routers, React Router, Expo web) and detects `web` for a repo with a web app.
- MCP: `start_session(platform="web", app=<url>?, device="desktop"|"mobile")`; the URL defaults
  to the target's `app_id`.
- UI and skills: `web` is a third platform everywhere `ios`/`android` appear.

## Onboarding (added 2026-11-05)

A project enters QA through Verdikt's onboarding, ported with its steps, wording and motion: nobody
types a bundle id unless detection failed. `093` is already applied on live projects, so this is a
**new migration**: `094_qa_onboarding.sql`, sqlite `024_qa_onboarding.sql`.

- `qa_onboarding` — `container_id` PK; `phase` (`found|code_map|tests|live|coverage|bring_in|
  first_run|done`); `state` (`idle|running|waiting|failed|done`); `found` JSON (the "We found"
  sheet); `options` JSON (the person's picks); `phases` JSON (per phase: `state`, Verdikt's
  `pending|running|done|skipped|failed`, then note, counts, started_at, ended_at, task_id,
  estimate_usd); `error`; `updated_at`, `updated_by_agent_id`.
- Detection: `orcha_cli/qa/onboarding/` ports `cloud/folder_scan.py`, `cloud/repolib`,
  `test_import/extract.py` (`scan`), `test_import/ci.py`, `onboarding_map/found.py`,
  `backends.py`, `estimates.py`, `risk.py`. No model, no device, no network. It reads the project
  folder: apps in a monorepo, platforms, stacks, bundle ids, packages, dev URLs, UI tests by
  framework, CI, and the backend each build talks to.
- `GET C/onboarding` → the row plus Verdikt's `OnboardingMap` snapshot read from the map:
  `{project_id, container_id, phase, state, phases, found, options, error, updated_at,
  updated_by_agent_id, unavailable, screens, edges, files, gaps, summary, bring_in, first_test,
  smoke, live_run, billing}`. `unavailable` is the sentence `start` would answer, or null. Screen
  ids are `screen:<platform>:<key>`; a screen's `coverage` is `your_tests|qa|both|none` and
  `summary` counts `covered_by_tests` and `covered_by_qa` (a QA scenario covers it). `found` adds `apps` (every app folder) and `bundle_id_candidates` to Verdikt's sheet, and a
  web platform's `app_id` is its URL.
- `GET C/devices` → `{devices, available}` (`qa_onboarding_routes.py`): the booted simulators and
  attached Android devices, read the way a session finds them (`orcha_cli/qa/device/listing.py`). It
  never boots or creates a device. `available` is false on a portal that cannot see the machine (a
  container portal): the Device editor then takes a name.
- `GET /api/qa/sessions/{sid}/steps/latest?limit=8` → the newest steps, newest first, for the live
  panel (`GET .../steps` reads from the start of the session).
- The found sheet also carries `auth` (`{summary, methods, sure}`, from `onboarding/auth_scan.py`) and
  `sandboxes` (`{kind: {key: {ready, evidence}}}`, from `onboarding/sandbox_scan.py`), kept in the
  row's `found`, shown read-only: no migration. Key values are never kept, only which file has which
  prefix.
- A device picked on the sheet is saved as `qa_targets.device_name`, its name (what a session finds
  it by), and a pick for one run travels in `options.device`: the task text tells the agent what to
  pass to `start_session`. A build path typed on the sheet goes to `qa_targets.build_path`.
- A first run names its session as soon as the agent starts it, before the first verdict, so the
  live view follows it from the start.
- `POST C/onboarding` — `{action, options?}`, human only, answers 202 `{project_id, container_id,
  phase, state, phases, error}`: `start` (runs found; options `live?`, `platform?`, `agent_id?`),
  `confirm` (saves `qa_targets` from the picks, then runs code_map, tests; options `platforms?`
  as kinds or `[{kind, app_id?, app_name?, device_name?}]`, default everything found, `live?`
  `ask|true|false`, `agent_id?`), `run_live` (`depth?`, `platform?`, `agent_id?`) / `skip_live`,
  `bring_in` (`migrate?`, `draft?`, `frameworks?`, `areas?`, `gap_screen_ids?`, `agent_id?`),
  `first_run` (`scenario_id?`, `suite?`, `platform?`, `agent_id?`), `skip`, `restart`. A step that
  cannot happen now answers 409 with a sentence; so does `start` where detection is unavailable.
  Row `state`: `idle` before start, `running` while a phase runs, `waiting` for the person,
  `failed` when found failed, `done`. A background thread advances the phases and writes
  `phases`; the UI polls. A row left running by a dead thread is picked up on the next read. A task
  phase moves on at `needs_verification` (the task itself still waits for a person) and is
  `skipped` when the task is cancelled.
- Phases that need an agent or a device create a normal Orcha task for the picked agent (`live`:
  `/orcha-qa-map`; `bring_in`: `/orcha-qa-draft`; `first_run`: `/orcha-qa-check`), stored in
  `phases.<phase>.task_id`, and the phase follows that task and its QA session.
- Detection differs from Verdikt in four places, each from checking a real repo: an app folder's
  own bundle id wins over the repo-wide guess, so `path` and `app_id` agree; folders git does not
  track rank after tracked ones (`web-back/` next to `apps/web/`); among web apps a frontend ranks
  before a server-side backend; a payment provider's API is never an app's backend.
  `has_screens` matches Verdikt's conversion by pattern instead of converting.
- The portal reads the repo from the project folder it already knows (`ORCHA_LOCAL_REPO_DIR`). Where the CLI package or
  the folder is unavailable (a container portal), `start` answers with a plain sentence and the
  manual Apps form stays.
- UI: `pages/qa/onboarding/`, a port of Verdikt `components/onboarding/{wizard,map}` and its
  animation (`choreo`, `draw`, `layout`, `scenes`, `onboarding-map.module.css`). A project with no
  QA set up opens on it; Apps keeps the manual form under "Edit".

## Drafting (added 2026-11-05, migration 095, `qa_drafting.py`, `qa_drafting_routes.py`)

A draft session is watched on its page in Sessions. It reads the session's own messages: `read` and
`search` feed the stage and the activity log, `draft` lands each scenario on it, `plan`, `note`,
`request`, `answer` and `correction` are the conversation feed, `feedback` is what a person typed on
a draft. Run QA states what to read (`--sources`, `--explore`), and the agent passes it to
`start_session(sources=...)`.

An explore session of the same task is the drafter's explorer: `GET /api/qa/sessions/{sid}/drafting`
shows both on one board. The explorer's screens come from its recorded steps (first sighting of each
screen), so it posts nothing twice. The drafter asks with `ask_explorer` (at most three waiting; a
destructive request is look only; 4 minutes open, 3 claimed, swept on read) and the explorer answers
with `next_request` / `answer_request`.

Accepting a draft is `POST C/scenarios/status` (a person). Discarding retires it. Revising records
the person's feedback and creates a normal task for the agent; `revise_scenario` posts a `correction`
holding the changed criteria and the version it replaced.

## Live device view (added 2026-11-05, `device/live_frames.py`, `qa_live_routes.py`, `pages/qa/runs/live`)

While a session runs, its page shows the actual device in its bezel or browser frame
(`LiveDeviceView({sessionId, platform, deviceName, ...})`).

- **Direction.** `orcha qa mcp` is a stdio child of the agent; the portal is another process, native,
  in Docker or remote, reached at `api_base_url`. The opposite direction is not guaranteed, so a local
  stream was rejected: the tool server pushes the latest frame and the page polls, as the source polls
  its `latest.json`.
- **Frames.** `start_live`: a CDP screencast (web), idb's MJPEG stream with an ffmpeg H.264 fallback
  (iOS), a screencap loop (Android). `LiveFrameWriter` keeps the newest and uploads on its own thread at
  5 fps (12 while a person drives), newest only, identical frames skipped, so neither a slow portal nor
  masking reaches the action path. No stream: each step's frame is offered instead.
- **Storage.** The portal holds the latest frame per running session in memory (it serves one process):
  no table, no file. Dropped on `DELETE .../live`, on the first read after the session ended, after
  15 minutes of silence, and past 64 sessions.
- **Secure fields.** A live frame goes through the rule a stored frame does (`frame_guard`): the newest
  screen's secure fields painted out, withheld when that cannot be proven, and nothing sent while text
  goes into a screen that has one.
- **Routes.** `GET /api/qa/sessions/{sid}/live` and `GET .../live/frame` (member read); `PUT .../live/frame`,
  `POST .../live/beat`, `DELETE .../live` (the tool server); `POST .../live/takeover` and `POST .../live/input`
  (a person only). 409 once the session ended, which stops the tool server's loops.
- **States.** Connecting, LIVE, `No activity for N min` (2 min caution, 5 min alarm, from the screen and
  the step count, not the beat), Abandoned (no beat for 30 s; a person can mark it failed), Finished.
- **Take over.** A person takes the device from the view: the agent's next action answers `held: ...`
  and does nothing, their inputs play between steps through `device_lock`, and their time is not
  taken from its budget. Each input is a step with `args.source = "person"`; typed text is never kept,
  only its length. On hand back the agent is told and the screen is read with no `from` key, so the map
  gets no path the agent never took. A closed page (60 s) or 10 idle minutes gives the device back.

## Handoff and workflow integration (added 2026-11-05)

QA lives in Orcha's own code base, so it is wired in as first-class work: any agent can hand a task
to QA with structured data, the result comes back to whoever asked, and a workflow can hold a real
QA step. New migration `096_qa_handoff.sql`, sqlite `026_qa_handoff.sql` (never edit 093–095: they
are live). A QA result never verifies a task: a person still does.

### Requests (the handoff record)

`qa_requests`: `id`; `container_id`; `kind` (`map|explore|draft|check`); `platform`;
`source_task_id`, `source_workflow_id`, `source_agent_id` (nullable); `requested_by_agent_id`;
`qa_task_id` (the linked QA task); `round`; `scenario_ids` JSON; `tags` JSON; `focus`; `acceptance`
JSON (lines to prove, default the source task's definition of done); `build` JSON (`{branch,
commit, url, app_path, notes}`: what to test); `on_fail` (`report|reopen`); `status`
(`requested|running|passed|failed|blocked|cancelled`); `result` JSON (per-scenario and per-line
verdicts, finding ids, draft ids, session ids, summary); `created_at`, `finished_at`.

`qa_settings` per container: `agent_id` (the project's QA agent, default the agent whose role says
QA), `default_platform`, `trigger` (`manual|ui_changes|always`), `on_fail`, `max_rounds` (1–10).

- `POST /api/tasks/{tid}/qa/requests`: the handoff, from an agent or a person. `POST C/requests` is
  the same with no source task. Creates the linked QA task through the normal handler (assigned to
  the QA agent, description naming the skill, the data and the acceptance lines) and returns
  `{request, qa_task_id}`. `GET C/requests`, `GET /api/qa/requests/{id}`, `POST .../cancel`,
  `GET/PUT C/settings`.
- The QA tools take the request: `start_session(request_id?)` links the session; `verdict` records
  against it and may name an acceptance line.
- Return path, when the QA task finishes (needs_verification) or its session ends: roll the
  verdicts up to `passed|failed|blocked`, then (1) post a linked summary on the source task's
  thread, (2) wake the source task's agent, (3) add it to the source task's evidence pack:
  `assess_dod` treats a QA verdict on a line as proof, with its screenshot; (4) log an event and
  notify (category `qa`). With `on_fail=reopen` and rounds left, a failed request sends the source
  task back to `in_progress` with the findings as feedback, and a new request runs when it comes
  back (this replaces the removed auto-fix loop, on Orcha's own results). A pass always leaves the
  task for a person.
- `trigger` hooks task completion (`task_done_routes.py`), including workflow steps, which return
  early today and must not skip this.
- Agents: skill `orcha-qa-request` (plain HTTP, no device or `[qa]` extra needed), CLI
  `orcha qa request`, and project-preference text telling agents when to hand off.

### Workflow QA steps

`FlowStep` gains optional `qa` (`{kind, platform?, scenario_ids?, tags?, focus?, minutes?}`), kept
on the step's task. A QA step is still a task (no new engine):
- Default outcomes `pass` and `fail`; `fail` routes back to the build step inside a repeat group
  (`max_rounds`), `pass` goes on. Assignee defaults to the QA agent.
- Activating the step creates its `qa_request` (source = the step's task, build data from earlier
  steps' results), and the wake prompt names the skill.
- The rolled-up result reports the step's outcome through the existing outcome path, with findings
  as its outcome report, so `round_context` hands them to the fix step. Evidence lands in the
  workflow's evidence.
- A workflow-level draft preset, "Build, QA, fix", and `orcha-draft-workflow` knows QA steps.

### Handoff API (settled)

`C = /api/containers/{cid}/qa`. `/openapi.json` is the source of truth for bodies; the rows below
are computed, so they are written out here. Code: `qa_handoff.py`, `qa_handoff_routes.py`.

- `POST /api/tasks/{tid}/qa/requests`, `POST C/requests` (201) take `{actor_agent_id, kind?, platform?,
  scenario_ids?, tags?, focus?, minutes?, acceptance?, build?: {branch?, commit?, url?, app_path?,
  notes?}, on_fail?}` and answer `{request, qa_task_id}`. `kind` defaults to `check` when the project
  has validated scenarios, else `explore`. 409 with a sentence when the same kind and platform is
  already open on the task, for a root task and for a cancelled one.
- `GET C/requests?status=&kind=&source_task_id=&source_workflow_id=&limit=` (≤200) → `{requests: [row]}`.
- `GET /api/qa/requests/{id}` → row plus `sessions`, `findings`, `drafts`, `verdicts`, `line_verdicts`
  and `rounds: [{id, round, status, summary}]`, oldest first.
- `POST /api/qa/requests/{id}/cancel` `{actor_agent_id}` → row. The requester or a person. Cancels the
  QA task too, except a workflow step's, which stays with its owner.
- `GET C/settings` → `{container_id, agent_id, agent_alias, agent_source: set|role|none, default_platform,
  trigger, on_fail, max_rounds, updated_at, updated_by_agent_id}`. `PUT C/settings` (a person) takes
  `{actor_agent_id, agent_id, default_platform, trigger, on_fail, max_rounds}` and answers the same.
- `GET C/workflow-presets` → `{presets: [{key: "build_qa_fix", name, description, draft}]}`. `draft` is a
  `WorkflowDraft`: fill `tasks[0].assignee_id` (and the title and goal), then POST it to
  `POST /api/containers/{cid}/workflows/preview` and `POST /api/containers/{cid}/workflows` (with an
  `idempotency_key`).
- `GET /api/tasks/{tid}/qa` adds `requests: [row]` (this task as source or as QA task).

Request row: every column of `qa_requests` (`id, container_id, kind, platform, origin:
handoff|trigger|workflow|reopen|recheck, source_task_id, source_work_revision, source_workflow_id,
source_agent_id, source_finding_id, requested_by_agent_id, approved_by_agent_id, qa_task_id,
previous_request_id, round, max_rounds, scenario_ids, tags, focus, minutes, acceptance, build, on_fail,
status, result, created_at, finished_at`) plus `source_task_title, source_workflow_title, qa_task_title,
source_agent_alias, requested_by_alias, approved_by_alias, session_id, session_status` (the newest
session). `approved_by_agent_id` is the person whose click approved the run's plan, or null.

`result` (null until finished): `{summary, lines: [{index, text, verdict|null, note, frame_ids, session_id}],
scenarios: [{scenario_id, name, verdict|null, note, quarantined, frame_ids, criteria: [{index, text, verdict,
note, example_row, frame_ids}]}], finding_ids, draft_ids, session_ids, findings: [{id, severity, title,
expected, actual, fix_prompt, frame_ids, screen_key}], failing_findings, reopened?, rounds_exhausted?,
reopen_refused?, evidence_landed?, outcome_refused?}`.

Elsewhere: sessions, findings and verdicts carry `request_id`; `POST C/sessions` takes `request_id?`;
`POST /api/qa/sessions/{sid}/verdicts` takes `acceptance_line?` (0-based), and `scenario_id` and
`criterion_index` are optional when it names a line. Workflow tasks carry `qa: {kind, platform, scenario_ids,
tags, focus, minutes} | null`; `NewTask` and `FlowStep` take the same field. The evidence pack gains `qa:
[{id, kind, platform, round, status, summary}]`, and a DoD item QA judged has `basis: "qa"`, `frame_ids` and
`qa_request_id`. Live views: a container event `qa_request_changed {request_id, status}`. Notifications:
`qa_result {task_id, request_id, status, round, reopened, preview}`, category `qa`.
Onboarding: `phases.<phase>` gains `blocked_reason` and `request_id` (an open request from the task's
agent, for `live`, `bring_in` and `first_run`), and `cost_usd` runs while the task runs, from
`worker_runs.total_cost_usd`. A worker that left with no session fails the phase after 3 minutes with
that reason, so Run can be pressed again. `live_build` (null once the pass ended) is `{source:
installed|url, platform, app_id, device?, version?, build?, installed_at?}`: Orcha compiles nothing.
`bring_in` with `migrate` is pure: every detected UI test is a draft by the time the click answers (no
task, no cost; `phases.bring_in.counts: {imported, suggested, detected, errors}`; `bring_in.imported`
counts them all, tied to a screen or not). Only drafting for the gaps creates a task.
`GET C/sessions` (with no `status` filter) and `C/session-digests` leave out a session that failed before
its first step (`qs.STARTED_SQL`); `counts.sessions` does too.

Reliability (no migration: `queued` does not fit `qa_sessions_status_check`, so a queued session stays
`status: running` with `queued_at` set and `claimed_at` empty, and what it waits for is in `result.waiting`):
- Every session row (`GET C/sessions`, detail, `/run`, live tiles, task QA) adds `queued` (bool),
  `queue` and `stop_reason`. `stop_reason` is a sentence for `abandoned`, `failed` or `cancelled`, else
  null. `queue` is null once the session has started, else `{position, waiting, device, devices, used_by,
  project, kind, held_session_id, reason}`: `reason` is the line to show ("Waiting for iPhone 17 Pro:
  snug-log's check run has it."), `used_by` who has the device in words, `project` and `kind` the same as
  fields, `held_session_id` that run's session (it may be another project's), `position` 1 for next, in the
  machine's line. `waiting` is the agent's alias. With no device involved (no agent has come yet) `device`
  is null and `reason` says so. A session waiting for a device is never `failed`.
- `GET /api/qa/sessions/{id}` and `/run` add `run_again` for a stopped session, null otherwise: `{mode:
  resume|add_agent|new_task, task_id, agent_alias, says}`. `resume`: its task is open, so `POST .../again`
  wakes that task's agent and queues a session on it, no second task. `add_agent`: nobody can take it, add
  the QA agent first (`task_id` set: that picks up the task). `new_task`: nothing open to go on with.
  `.../again` answers the session plus `task_id`, `session_id` and `run_again`.
- A session ends `abandoned` when the worker running its task has been gone for 2 minutes, or nothing was
  heard for 15. The tool server beats every 60 s, also while the agent is busy elsewhere. Checked on read and
  by a sweeper in the portal every 60 s. The tool server then lets the device go at once.
- `phases.<phase>` also gets `blocked_reason` set to the device wait or the `stop_reason`, and `run_again`
  (same shape) once its worker left. Run on a phase whose task is open goes on with that task.
- `phases.<phase>.blocked_reason` is exactly `no agent` when nobody can take the task; `note` says it in words.
- `GET C/devices`: each device adds `held_by`: `{device, since, project?, kind?, session_id?, task_id?}` or null.
- `POST C/agent` (a person) `{actor_agent_id}` → `{agent_id, alias, created, assigned_task_ids, tools_on}`:
  adds the agent "QA" through agent registration, or uses the project's QA agent, and assigns every waiting QA
  task (no second task). The alias moves to QA2 if a retired agent has it.
- `GET C/tools` → `{tools_on, can_enable, reason}`; `POST C/tools` (a person) `{actor_agent_id}` turns them on
  and answers the same; 409 with the sentence where it can't. `reason` is the sentence when the package or the
  project folder is missing, else null. `GET C/setup` is the same plus `ai_agents`.
- `PATCH /api/qa/sessions/{id}` takes `waiting` and `device_ready`; only the tool server sends them.

A person's explicit action approves the plan of the QA task it creates: Send to QA, Run QA, again,
duplicate, "Triage" on a finding, onboarding's run_live, bring_in and first_run, and a QA step in a
workflow its owner started. It goes through the plan card's own mechanism (a `plan_approval` decision, a
`task_approval_records` row with `permission_source` `qa_person_run` or `workflow_started_by_person`, the
line on the thread) and the task's text says so. `tasks.autonomy` stays off, so an agent still cannot
accept its finished work. An agent's request, a trigger and automatic triage follow the project's rule.

Triage: request `kind: triage` takes `finding_ids`, and its row adds `finding_ids` and `decision:
fix|clear|needs_person`; its `result` adds `diagnoses: [{id, title, severity, severity_original,
classification, rate: "fails 3 of 3", reproduced, attempts, reproductions, root_cause, note, action,
needs_person, evidence_frame_ids, frame_ids}]` and `confirmed_ids`. Settings add `auto_triage:
off|critical|all` and `max_per_run`.
- `POST /api/qa/findings/{fid}/triage` `{actor_agent_id, classification, reproduced?, attempts?,
  reproductions?, root_cause?, severity?, duplicate_of?, note?, scenario_id?, frame_ids?, needs_person?}` →
  the finding plus `action`: `confirmed|backlog|suggested|quarantined|already_quarantined|no_scenario|
  blocked|dismissed|merged`. Findings carry `triage`, `severity_original`, `duplicate_of`.
- `POST /api/qa/findings/{fid}/triage-request` `{actor_agent_id}` → `{request, qa_task_id}`: "Triage" on a finding.
- `POST /api/qa/findings/{fid}/not-a-bug` `{actor_agent_id, reason}` (a person) → the finding.
- `GET C/triage` → `{untriaged, needs_person, decided}`, rows of findings.
- `GET C/memory` → `{memory: [{id, kind, text, finding_id, scenario_id, screen_key, created_by_agent_id,
  created_at}]}`; `POST C/memory` (a person) takes `{actor_agent_id, kind, text, scenario_id?, screen_key?}`.
- `GET C/workflow-presets` also lists `build_qa_triage_fix`: fill `assignee_id` on `build` and `next`.

Where the build settled a detail differently from the sections above:
- A triage run's session is `kind: explore`: `qa_sessions.kind` has a CHECK a SQLite migration cannot
  change without rebuilding a live table. The request says what the session is for.
- The preset has a fourth step, Next, depending on QA and Triage. QA's `pass` is a branch to Next, its `fail`
  a branch to Triage, so a pass skips triage. Two engine rules changed for that: a step further along the
  chosen branch stays selected, and a member that branches out of its group ends the loop.
- `triage_finding` also takes `scenario_id` (when the finding names none) and `needs_person` (the
  judgement call that sends the step to `ask_owner`).
- Blocked QA reports no outcome unless the step declares `blocked`: accepting it then asks the owner.
- `on_fail=reopen` on a workflow step reports only: sending one back is a person's or a QA step's route.
- A QA step's outcome comes only from its rollup or a person; a worker's report is refused
  (`qa_step_outcome`), or an agent could overrule its own verdicts.
- QA's evidence lands as a `log_excerpt` item at `submission` with a note: `workflow_evidence` holds one
  item per kind and phase, and a new kind would need that table rebuilt.
- The test import reads assertions by pattern, not with the original's full translator: each criterion
  is an outcome or the test's goal, and the code stays the source. Tests of unpicked platforms stay out.

Run tasks and the final decision (migration `097_qa_run_tasks.sql`, sqlite `027_qa_run_tasks.sql`; code:
`qa_run_tasks.py`, `qa_final_decision.py`, `qa_run_tasks_routes.py`, `qa_blocks.py`):
- `POST C/sessions` answers 400 with no task. `task_id` is required; only a named `request_id` can stand in
  for it. The tool server calls `POST C/run-task` `{actor_agent_id, kind, platform, goal?}` (header
  `X-Orcha-Run-Token` when it has one) → `{task_id, created}`: the run's task, else the agent's task in progress
  (a run task first), else a new run task already in that agent's hands, which wakes nobody.
- `qa_runs` marks a run task: `task_id, container_id, origin: request|workflow|onboarding|run_check|exploration|agent,
  kind, platform, result_session_id, created_at`. `GET C/run-tasks?limit=` → `{run_tasks: [{task_id, origin, kind,
  platform, status, title, created_at}]}`, for the Tasks list.
- `GET /api/tasks/{tid}/qa` adds `is_run_task`, `run_result` and `final_decision`. `tasks.result` carries the same
  run result under `qa_run`, beside `result`, the text every reader already reads.
  `run_result` (null for a task that is no run task and has no session): `{task_id, is_run_task, origin, kind,
  platform, outcome: passed|failed|blocked|stopped|running|null, reason, summary, request_id, scenarios, lines,
  findings, diagnoses, drafts: [{id, name, status}], screens_reached, screens, duration_seconds, cost_usd, device:
  {name, udid}, build, app_id, agent: {id, alias}, worker_run: {run_id, status}, session_id, session_ids, links:
  {task, run, replay, findings, request, worker_run, activity_log}}`. `scenarios`, `lines` and `findings` are the
  request result's rows above. `reason` is the sentence for `stopped`.
  `final_decision` (null until a decision was made under `quality`): `{decision: finished|person|sent_back, subject:
  work|run, setting, actor: "system:qa", turned_on_by_agent_id, turned_on_by_alias, turned_on_at, reasons: [{code,
  text, lines?, findings?, flags?}], lines: [{index, text, status, basis, strong, evidence, why, why_text}], at}`.
  `lines` are the definition-of-done lines that stopped it. Codes: `setting_person, no_owner, run_open, run_stopped,
  run_blocked, run_failed, inconclusive, unjudged, open_findings, drafts, proved_nothing, own_check, no_outcome, no_pack,
  no_lines, line_not_proven, line_needs_human, line_weak, line_own_verdict, line_stale_proof, risk_flags,
  changes_unknown, tests_failing, acceptance_refused`.
- `GET C/settings` adds `final_decision: person|quality, final_decision_by_agent_id, final_decision_by_alias,
  final_decision_at`. `PUT C/settings` (a person) takes `final_decision?`; left out it stays as it is. A change is
  logged as `qa_final_decision_changed {from, to, by, by_alias}`. It is per project only, read at each decision.
- The evidence pack's DoD items add `strong` (bool) and `qa_session_id`. `strong` is a QA pass, or tests that ran
  and passed. A changed file stays `proven` for display and is never strong.
- `GET /api/agents/{aid}/qa-runs?limit=` → `{agent_id, agent_alias, runs: [{session_id, task_id, task_title, kind,
  platform, status, outcome: passed|failed|blocked|stopped|running|ended, stop_reason, request_id, run_id, cost_usd,
  duration_seconds, device_name, build, started_at, ended_at, links}], totals: {runs, cost_usd, duration_seconds}}`.
  `cost_usd` is the agent's runs on that task.
- Session rows add `run_id`. Request rows add `agent_id`, `agent_alias` and `run_id`, from the newest session.
- `GET /api/containers/{cid}/metrics` adds `qa: {runs, stopped, seconds, cost_usd}`. That cost is inside `totals`.
- `GET C/workflow-blocks` → `{blocks: [{key: check_and_fix|explore_and_draft|map_the_app|release_check, name,
  description, placeholders: {build, next}, tails, closing, draft}]}`. `draft` is shaped like a preset's and holds
  only the block's own steps; `build` (the step before) and `next` (what follows) are the two keys it names that
  are not its own. `tails`: what the following step waits for. `closing`: the step added when nothing follows.
  `POST C/workflow-blocks/splice` `{block, draft: WorkflowDraft, after: [client_key], build_step?}` → `{draft, added,
  preview}`; a splice the engine refuses answers 422 `{code, message}`. Presets are a Build step and a block.
- `NewTask` and workflow tasks carry `block: {key, name} | null`, kept in `tasks.qa_block`.

Polled reads (`qa_read_cache.py`):
- `GET C/onboarding` adds `snapshot_version`, and `first_run_screen: {screen_id, first_run} | null`. Poll it with
  `?since=<snapshot_version>`: while that stands the answer leaves out `screens, edges, files, gaps, summary` and says
  `snapshot_unchanged: true`, with phases and the small run state (`first_test`, `smoke`, `live_run`, `bring_in`). The
  client keeps what it holds (`foldSnapshot` in `use-onboarding-map.ts`). `?fields=row`: the row and phases, no snapshot.
- The map part is computed at most once per version and shared by every reader. `GET C/map` and `GET C/atlas` are
  cached the same way and answer already-encoded JSON. A version reads what the page reads; scenarios are hashed by
  content, because several writes leave `updated_at` alone. A heartbeat changes no version. An entry lasts 60 s at most.
- A device command never runs inside a transaction. A poll takes what is known, and a thread refreshes it.
- A polled read opens no write transaction: `tests/test_qa_read_cache.py` holds QA's GET routes to that. The few that
  can write look first with a read and write only when there is something to write. The evidence pack is built with no
  write lock (`fresh_pack`).
- `GET /api/containers`, `/api/plan-usage*`, `C/budgets`, `C/running-runs` and `C/project-profile` are read-only now.
  About ninety other GET routes outside QA still open a write transaction out of habit.

Where the build settled a detail of run tasks and the final decision:
- A run's end writes its result and thread message. The agent's `/orcha-done` still moves the task to
  `needs_verification`, because the skills do their report after `end_session`. A worker that leaves without it
  stays `in_progress`, as any task does.
- Under `quality` the rule is one pure function, `qa_final_decision.decide`, which returns its reasons. It runs when a
  task reaches `needs_verification`, when its run ends and when a workflow step's worker stops. Any task can finish
  this way, so a backend-only task can finish on tests alone with no run.
- It is also stricter than the spec's list in four places: QA proof from before the task was finished does not
  count (`line_stale_proof`), a pack with unreadable changes refuses (`changes_unknown`) except on a QA step, whose
  own run changes nothing, failing tests refuse (`tests_failing`) and a task with no definition of done refuses.
- A run task with a source answers for its run only (`subject: run`). So a clean run can finish its run task while
  its source goes to a person. The run task's own definition of done is boilerplate, so it is not proved line by line.
- A failed run task stays at `needs_verification`: only a clean pass completes anything. Its source goes back to the
  agent, as `on_fail=reopen` does, and with no rounds left it stays for a person.
- An open blocker or major finding goes to a person even on a fail, so such a fail does not go back by itself.
  Most fails carry one. To send them back anyway, drop `open_findings` from `qa_final_decision._PERSON_ONLY`.
- Workflow steps have no pack from `/done`, so `decide` builds one when the worker stops and the evidence is saved;
  with none, the step goes to a person. The rule is the same with four differences: a QA step's authors are the steps
  before it, not its own assignee; QA proof must be for this `work_revision`; tests must come from this revision's
  runs; and the step needs a reported outcome.
- A step is accepted through `op_accept`, so evidence and routing rules hold. `workflow_task_acceptances` admits only a
  person or an agent, so the row names the person who turned `quality` on, with `acceptance_source: qa_final_decision`,
  and the workflow history says `decided_by: system:qa`. A finished review loop and an outside result stay a person's.
  A clean fail is accepted the same way (`decision: sent_back`), so its route runs and the fix step gets the findings.
- `system:qa` is no agent row. Events carry it as `actor_type: system`, `detail.actor: "system:qa"`. The approval row
  names the person who turned it on, `permission_source: qa_final_decision`. A task finished this way writes no
  `verified` event, so Metrics' `tasks_verified` and agent performance do not count it as a person's verification.
- Agent performance's typed response has no QA fields yet: it needs a new response model. `GET /api/containers/{cid}/metrics`
  has `qa`, and an agent's page reads `GET /api/agents/{aid}/qa-runs`.
- A triage step after several checks takes every failed check's findings, but its session runs on one platform.
- `release_check` keeps a repeat group, which needs a send-back and an exit that is not `ask_owner`. So its triage
  has two outcomes only a person reports: `retest` and `release`. Every outcome the rollup reports asks the owner.

### Tracking, both ways

Every QA object links to where it came from: request ↔ source task ↔ workflow ↔ session ↔ findings
↔ filed tasks ↔ scenarios. A filed finding's task, when done, triggers a re-check request. UI: QA
tab Requests view; session, finding and scenario show their source; task detail shows requests and
a "Send to QA" action; the workflow graph marks QA steps with live status, the embedded device link,
findings and per-round history; project Activity and notifications carry QA events.

### Triage (in workflows and on its own)

A finding is a claim, not a fix order. Triage judges each one before anyone acts on it, and each
diagnosis drives a different route. Ports Verdikt `runs/triage.py`, `runs/reproduce.py`,
`severity/{rubric,review,store}.py` and the `not_a_bug` memory. Goes in `096` (not applied anywhere
yet) with `qa_requests`: `qa_findings` gains `triage` JSON (`{classification, reproduced, attempts,
reproductions, root_cause, evidence_frame_ids, by_agent_id, at}`), `severity_original`,
`duplicate_of`; new `qa_memory` (`container_id`, `kind` `not_a_bug|convention|decision`, `text`,
`finding_id`, `scenario_id`, `screen_key`, `created_by_agent_id`, `created_at`).

- Classifications: `product_bug`, `test_issue`, `environment`, `flaky`, `agent_error`, plus
  `duplicate` and `not_a_bug` (the last only from a person).
- `qa` kind `triage`: a new request kind and a workflow step kind. The agent re-runs only the
  failing part, attempts it at least 3 times ("fails 3 of 3" and "fails 1 of 3" are different bugs),
  reads the code, re-rates severity with the rubric, finds the root cause. Tool
  `triage_finding(finding_id, classification, reproduced, attempts, reproductions, root_cause,
  severity?, duplicate_of?, note?)`; skill `orcha-qa-triage`.
- What each diagnosis does, automatically:
  - `product_bug` blocker/major: goes to the fix step with reproduction, root cause and screenshots.
  - `product_bug` minor/trivial: filed as a backlog task; does not block the workflow.
  - `test_issue`: a suggestion on the scenario for a person (never edits a validated scenario).
  - `flaky`: the scenario is quarantined with the rate; it no longer fails a gate alone.
  - `environment`: the request ends `blocked`; a person is told what is missing.
  - `agent_error`: the finding is dismissed with the reason, kept for the record.
  - `duplicate`: merged into the open finding it repeats.
  - a person's `not_a_bug`: stored in `qa_memory`; QA agents read it (`list_project`) and that
    behaviour is never reported again.
- Triage step outcomes (default routes): `fix` (confirmed blocker/major) → back to the build step
  with only the confirmed findings as round context; `clear` (nothing left that blocks) → next;
  `needs_person` (a judgement call) → `ask_owner` through the existing owner decision.
- Preset "Build, QA, triage, fix": a fail at QA goes to triage rather than straight to a fix, so
  the build agent never burns a round on a flaky test. The repeat group's `max_rounds` covers the
  whole loop.
- Outside a workflow: `qa_settings.auto_triage` (`off|critical|all`, off by default since each run
  holds a device and spends model time, with `max_per_run`) and "Triage" on any finding.
- UI: a Triage inbox in the QA tab (untriaged, needs person, recently decided), the diagnosis card
  on a finding (classification, "fails 3 of 3", root cause, before and after severity), Mark as not
  a bug with a reason, QA workflow steps showing what triage decided per finding.

## Run tasks: every run is a task (added 2026-11-06)

Decided with the owner: every agent QA action is an Orcha task, so it is tracked by the system that
already tracks work. The person does not manage that link; they just see the task going on.

- **Always linked, never asked.** `task_id` is required on a QA session (portal route and MCP
  `start_session`). It is not a person-facing field and agents never have to think about it: the
  tool server resolves it (the task the worker was woken for), and only if there is none it creates
  a run task itself. No QA session exists without a task. Older rows stay as they are.
- **Who has the final say is the owner's choice.** `qa_settings.final_decision` is `person` (the
  default) or `quality`. One setting per project, with no per-workflow or per-request override.
  Only a person can change it, and it is logged.
  - `person` (default, unchanged rule): when a run ends, results are written into the task and it
    stops at `needs_verification` for a person. A QA pass is evidence, never a verdict on the work.
  - `quality` ("Finish by itself when everything is proven"; the name may change): verification is
    not only UI, so a Quality pass alone never finishes a task. A task finishes without a person only
    when every definition-of-done line has strong proof (a QA verdict or tests that ran and passed;
    a changed file is weak proof, shown but not enough) from someone other than the author, the
    evidence pack has no risk flags, there is no open blocker or major finding, and nothing is
    inconclusive. It records the rule and who turned it on, as actor `system:qa`. A backend task can
    finish on tests alone; a mixed task goes to a person with the unproven lines listed.
  - Always to a person, whatever the setting: a dead, stopped or blocked run, drafted scenarios,
    `needs_human` lines, and work with no evidence pack.
- **Results live on the task.** `tasks.result` and a thread message carry: outcome, verdicts per
  scenario and per line, findings, drafts, screens reached, duration, cost, device and build, the
  agent, and links to the run page, replay, findings and the agent's run. The task page shows them
  as a Run result card, not raw text.
- **Who did it.** Every run shows its agent and worker run; the agent's page lists its Quality runs
  with outcome, cost and time; from a run you can open what the agent actually did (the activity log,
  its messages, its tool calls). Agent performance and Metrics count QA work.
- **Across the board.** Tasks list marks run tasks and filters them; Activity, notifications, Needs
  you, Metrics (cost and time per run), and Talk where it applies (only when the Talk branch merges)
  all read the same run records.

### Embedding a Quality workflow in any workflow

When someone creates or edits a workflow, they can embed one of ours as a block: "Add a Quality
workflow" offers ready-made blocks, each a tested set of steps with its routing already wired:
- **Check and fix:** Check → Triage → back to the chosen build step, until it passes.
- **Explore and draft:** Explore → Draft scenarios.
- **Map the app:** Map → Coverage summary.
- **Release check:** Check every validated scenario on each platform → Triage → ask the owner.

A block expands into normal workflow steps inside a repeat group at the point it was inserted, linked
to the step before it and to what follows, with a label showing they came from the block. The person
may edit any step. Blocks are served by `GET C/workflow-blocks`, alongside the existing presets (the
whole-workflow presets become a block plus a Build step), so the catalogue has one source.

## Simplified product (decided 2026-11-06, Kedar)

Quality has three tabs: **Exploration**, **Scenarios**, **Runs**. The UX of what remains stays exactly
as it is. Brainstorming scenarios is the existing drafting and explorer experience; nothing new is
built. Overview, Map, Screen atlas, Slowest screens, Triage, Apps and the Health and Coverage
sub-tabs are removed from navigation and routes. Their source stays until the owner confirms
deletion. Onboarding, workflows, handoff and run tasks are unchanged.
