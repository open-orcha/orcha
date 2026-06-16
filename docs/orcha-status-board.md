# Orcha — Status Board (live)

_Last updated: 2026-06-09 (Tim)_

> Single source of truth for work-item status. **Tim maintains this:** 🟠 when dispatched to a worker,
> ✅ once **verification is done** (human `/orcha-verify` → task `completed`), 🔴 if at risk/blocked.
> 🟠 covers both *building* and *awaiting-verify* (done by the worker but not yet human-verified). ⏸ deferred · ⚪ not started.
>
> Legend: ✅ done (verified) · 🟠 WIP (building / awaiting verify) · 🔴 at risk · ⏸ deferred · ⚪ not started
>
> **Ground truth:** an Orcha task at `completed` = human-verified (✅); `needs_verification` = built, awaiting Kedar's `/orcha-verify` (🟠); `in_progress` = building (🟠).

## 🎯 v1 = portal MVP w/ LIVE terminal + conversation continuity — current frontier
Plan: 2-round S3 cut-over. **R1** (live embedded terminal core) is **✅ verified on main** (full batch `/orcha-verify`'d 2026-06-09).
**R2 is ACTIVE** (Tim seq `77623c64` + Kedar scope `38772a41`, both answered 2026-06-09).
**Reversal (Kedar 2026-06-09):** the embedded terminal **and** cross-embodiment conversation continuity (ISS-69/70) are now **IN v1** —
this un-freezes the prior "terminal-free MVP, conversation frozen" stance. Only the **SDK-dependent E4 interrupt/permission cards** remain frozen as fast-follow.

### R1 — LIVE embedded terminal (S3, pulled into v1) — ✅ COMPLETE & VERIFIED
All three "untested-seam" integration bugs (found in functional test, not unit tests) were fixed + merged + **human-verified**:
| Bug (untested seam) | Fix | PR |
|---|---|---|
| #1 terminal pointed at portal origin, not the `:8765` bridge + bridge not auto-started | Forge wire+auto-start · Frame `terminal.js`→`:8765` + visible connect states | **#152 / #153** |
| #2 ISS-61 resident warm-resume crash-loop (regression from #149 worktree isolation) | cold-boot fallback on `--resume` miss | **#152** (`8707a74`) |
| #3 bridge actor-verify hit `/api/agents/{id}` (PATCH-only → 405) → "busy" | bridge reads `/persona` · distinguish **4403** (no valid human) vs **4409** (busy) | **#154 / #155** |

| Item | Status | Owner | PR / notes |
|---|---|---|---|
| S3 R1 — embedded-terminal panel + locking UX | ✅ verified | Frame | task `4aea9950` |
| S3 R1 — frontend↔bridge wire + auto-start | ✅ verified | Forge | #152; task `1cafb313` |
| S3 R1 — `terminal.js`→real bridge + visible states + 4403/4409 | ✅ verified | Frame | #153/#155; task `d777b457` |
| S3 R1 — live-lease lifecycle (acquire/renew/release · wake-scan exclusion) | ✅ verified | Forge | task `815daec8` (`17bef16c`) |
| S3 R1 — live-embodiment continuity (boot-as-agent + snapshot-on-close) | ✅ verified | Vault | task `fe9824a8` (unblocked once #162 overlay + host deploy landed) |
| ISS-61 — resident warm-resume crash-loop | ✅ verified | Forge | fix #152; refine = preemptive cold-boot + label `errored` not `killed`; task `75c2d632` |
| ISS-60 Part A — hard-cap a hung resident turn (lease wedge) | ✅ | Forge | PR #151 |

### Merge gate (mandatory for resident/terminal PRs) — ✅ landed
| Item | Status | Owner | notes |
|---|---|---|---|
| e2e resident/terminal SMOKE gate (real bridge + cold/warm-resume/orphan, **un-mocked** seams) | ✅ merged | Forge | **#164** (stacked on #162); task `5872ecbc`. Dock has adopted it into the merge quality gate. `pytest -m smoke`. No resident/terminal PR merges without it green — the 3 R1 bugs all shipped green because unit tests mocked the seams. |

### R2 — ACTIVE (P0 dispatched 2026-06-09; P1–P3 staged, released as P0 plans clear)
| Item | Status | Owner | task / PR |
|---|---|---|---|
| 🔴 R2 — **ISS-74 (#183): warm-idle resident holds the wake lease → ALL event-driven headless wakes suppressed** (decision_made / task_message / request_answered QUEUE until the lease releases) — **URGENT v1 RELEASE BLOCKER** · plan-first | 🔴 to dispatch | Forge (proposed) | new — root-cause + note ↓ |
| R2 P0 — ISS-56 (#138): verify event-wake `worker_run` (feed-visibility) | 🟠 awaiting verify | Forge | task `021875a0` (close #138 on verify) |
| R2 P0 — ISS-70 (#169): cross-embodiment digest re-sync (warm-resume amnesia) — **plan-first, Option B** | 🟠 building | Forge | task `9247cbd4` |
| R2 P0 — ISS-71 (#170): embedded terminal must survive portal nav — **plan-first** | 🟠 building | Frame | task `e3aedb84` |
| V1 ENGINE (definitive) — #1 live embodiment + embedded-terminal | 🟠 building | Forge | task `183fb6ad` |
| V1 ENGINE bundle — wake-and-act (ISS-55/56) · B5 assign | 🟠 building | Forge | task `0795bbd3` |
| R2 P1 — ISS-69(b) (#181): preempt-yield BACKEND (daemon-side resident handoff — terminal preempts idle resident; the server-side holder-yield seam) | 🟠 awaiting verify | Forge | task `bffbe274`; PR #181 NEEDS REVIEW; lights up Frame's UX PR #179 (APPROVED). Kedar approved plan, asked for testing instructions w/ completion req — human-verify pending |
| R2 P1 — ISS-69 (#179): embodiment-contention UX (name holder + resident hand-off) | 🟢 APPROVED | Frame | task `b8259ec7`; awaiting merge |

**Staged P1–P3** (folded once P0 plans clear): ISS-69 terminal contention/handoff UX · ISS-72 abort · ISS-59 approve-carries-answers (#159) · ISS-62 attach (#157) · ISS-63 collapse (#158) · ISS-64 draft-loss (#156) · ISS-68/#167 actionability-tiered lazy load · turn-budget reset+UI · ISS-9 per-agent gh cred isolation · ISS-60 Part B heartbeat-keyed orphan backstop. (GH labels: **5 URGENT** (incl. #183/ISS-74) + 14 HIGH — the 14th HIGH is #166/ISS-67 embedded-terminal slow reconnect.)

> **ISS-74 / #183 (URGENT v1 blocker — root-cause, filed by Page 2026-06-09).** A warm-idle RESIDENT conversation renews the single-embodiment **wake lease every tick** even when idle between turns; the wake gate (`main.py:1983`, `not lease_active`) therefore **suppresses every event-driven headless wake** for that agent — `decision_made` (approvals), `task_message`, `request_answered` all QUEUE and are never delivered to the live resident, which only consumes `conversation_turn` (`notifier.py:1437`). They fire only when the lease releases (idle-reap / tab close) — minutes, or indefinitely if the tab stays open. **Live repro:** Kedar's approval to Tim queued ~14 min (resident last turn 23:03:39 → `decision_made` worker fired 23:18:57, run `472c2d75`). Distinct from ISS-69(b) (terminal-preempt yield, dispatched to Forge `f0bff4f6`) and ISS-70 (digest re-sync). 4 fix options in the issue: **A** inject-as-turn (deliver the queued event into the live resident as a turn — preserves single-embodiment + live delivery; **Tim's lead recommendation**) · **B** bypass-gate (spawn headless even with a resident live — ⚠️ breaks the single-embodiment invariant) · **C** yield-on-event (reuse the ISS-69b preempt-yield seam — heavy: tears down the live tab) · **D** surface-to-operator. **Plan-first → Forge; fix-option pick = Kedar.** Secondary (ops, for Kedar): Tim is `turns_used 214 / budget 50` → needs a manual budget reset to act headlessly.

## ✅ Shipped & verified (v1 portal)
| Item | PR / task |
|---|---|
| **S3 R1 LIVE embedded terminal batch** (panel+lock · bridge wire+auto-start · `terminal.js`→bridge+4403/4409 · live-lease lifecycle · boot-as-agent continuity · ISS-61 fix) | #152/#153/#154/#155/#162 · tasks `4aea9950`/`1cafb313`/`d777b457`/`815daec8`/`fe9824a8`/`75c2d632` |
| e2e resident/terminal SMOKE gate (real seams) | #164 · `5872ecbc` |
| Embedded-terminal surface + locking UX (definitive) | task `64f6ccc9` |
| Onboarding O1/O2/O3 (operator name + create-agent) + O-series fixes | `52b306e7` · `fbf9bc77` |
| In-place fresh-start / container reset (`POST /containers/{cid}/reset`, `orcha init --force --reset-data`) | #131 · `4cecef4b` |
| Conversation panel polish (thinking indicator + slash-focus) | `1098ad20` |
| v1 surface bundle — ISS-44 linkify + ISS-52/ISS-53 | `09679a10` |
| Conversation-history injection (cache-friendly prefix) | #120 · `fbbea8d5` |
| Conversation-thread store (conversations + turns) | #150 · `55a44be4` |
| Agent-update endpoint (`PATCH /api/agents/{aid}`) | #83 · `aacbd206` |
| ISS-51 agent retirement · ISS-50 heartbeat-on-poll | #79 · #82 |
| ISS-58 — digest-snapshot self-wake runaway hotfix (container-scoped + wake-scan excl.) | #143 · `51641383` |
| Task-thread-message wake-and-act fix (Kedar live finding) | `98281bbd` |
| **D-series redesign** D2 home · D3 agents · D4/D5 tasks+requests · D6 SSE feed · D7 read-payload enrich · prompt_preview | `7587ee22` · `288f3390` · `357665f0` · `c5c1a912` · #74 · `afb0bffc` |
| Phase-0.5 R1 incremental migration runner | #42 · `433e264d` |

## ⏸ Frozen — fast-follow (un-freeze post-v1)
**Only SDK-dependent work remains frozen** after the 2026-06-09 reversal: **E4 interrupt/permission cards** (needs Claude Agent SDK `canUseTool`/`interrupt()`). Continuity (ISS-69/70) and the live terminal are now IN v1 (R2). Other deferred resident pieces: V2 resident digest-on-end (`35b68626`, reap-seam locked) · C3 thread summaries.
_Context: E-series resident engine spike done (E2 `b0b4a253`/#111 · E3 engine #119 · store #115/#150). A portal `conversation_turn` is answerable headless today via a normal daemon wake (no resident manager needed)._

## Deferred / Post-v1 (`docs/orcha-postv1-plan-and-tasks.md`)
PV1-1 task hierarchy · PV1-2 request graph · PV1-3 conversational requests (ISS-25) · PV1-4 summaries · PV1-5 warm worker pool.

---
**VERIFY QUEUE (awaiting Kedar `/orcha-verify` + "Functionally Tested" label):**
- `021875a0` — R2 P0 ISS-56 (#138) event-wake `worker_run` feed-visibility (Forge). Close #138 on verify.

_S3 R1 batch (`1cafb313`, `d777b457`, `4aea9950`, `fe9824a8`, `75c2d632`, smoke `5872ecbc`) — all **✅ verified/completed 2026-06-09**; R1 cleared, R2 released._

**Fleet:** Tim `c8f9ea25` · Forge `b6b01400` · Frame `8a1f27b7` · Vault `e031603a` · Reese `ef4c9551` · Dock `6be9beeb` · Page `1cf6ad61` · Invy `36711142`. Container `b034a1c3`.
