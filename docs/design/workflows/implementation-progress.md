# Workflows and task autonomy integration checkpoint

This is the integrated implementation checkpoint, not a verification claim. Dana supplied the portal presentation and desktop route mapping, ReleaseEngineer supplied the workflow API, and CodeCleanupAgent integrated task autonomy, acceptance, worker safeguards and final contracts. Code Reviewer independently checks the integrated result; Kedar verifies.

The [implementation task](http://localhost:8004/tasks?task=1854c320-7719-4bd0-bdec-01586c1fa858) follows Kedar's authorization to extend the existing approval-fix pull request. The original planning tasks remain untouched. The implementation still requires independent Code Reviewer review and Kedar's verification; this checkpoint is not self-certification.

## Verified sources and generated contracts

All nine approved files were freshly downloaded and matched manifest version 9. [The source record](approved-source-record.json) preserves immutable URLs, versions and fingerprints. The complete parent brief and canonical planning thread were read. Precedence remains plan version 13 sections 18 → 17 → 16 → 15 → 14, PDF version 11, then UI/screens version 7. Kedar's newer task-only autonomy requirement overrides human-only task acceptance in that package; workflow finish remains human-only.

The committed generated files are development contracts, not claims that the running server has these routes:

| Source | Origin | SHA-256 |
| --- | --- | --- |
| `workflows-openapi.json` | FastAPI-generated integrated workflow and task-authority contract | `1efb4ebae382d0e3ca009b7be96fcaafbfd224028d4b0b11ed346a6be288587d` |
| `workflow-evidence-openapi.json` | FastAPI-generated saved-evidence read contract | `f2a794298f992bd3ff3955fa5d6aefc30a97e373794a3c1e9d03c8f46796853e` |

Regenerate the 58 TypeScript models, runtime schemas and 46 operations from the repository root:

```sh
node tools/generate-workflow-contract.mjs docs/design/workflows/workflows-openapi.json docs/design/workflows/workflow-evidence-openapi.json
```

The generator merges the evidence GET operation and its referenced schemas, rejects conflicting definitions and preserves the workflow service's evidence-write contract. Saved evidence references use `item_id`, `deliverable_id`, `deliverable_version` and `sha256`. Runtime validation rejects unsupported response/request shapes rather than presenting empty success.

## Implemented

- Shared portal/desktop navigation: Workflows after Overview, list/new/detail routes, task return links, membership discovery and add-to-new/existing-workflow entry. List filters and keyboard focus survive a detail round trip. Review, activity and Finish task links retain workflow context. TaskDetail's existing assignee plan selector is unchanged.
- Existing Tasks list/board, task inspector and Needs you now share a complete, paginated workflow-membership read. Workflow members show the server's status/blockers, task ON/OFF and saved evidence before diagnostics, with a focused link back to their workflow controls. Legacy hold, release, assignment, cancel, run-stop and approval controls stay unavailable for workflow members or while membership is uncertain. Standalone actions resume only after a complete successful read or an explicitly unsupported older server. Focus/manual refresh preserves comment and rejection drafts; access refusal and identity/project changes clear prior workflow reads. Plan attention depends only on task OFF/ON. Every `needs_verification` task remains in human attention, including ON outside results; a worker’s authorized self-acceptance instead transitions to `completed`.
- Capability discovery and server-provided per-action permissions. Local Orcha uses its existing selected human on loopback or LAN connections; every write revalidates that person as a live, non-viewer member of the same project, and the server rejects viewers, agents, retired or cross-project identities. Deployments that explicitly enable trusted proxy identity ignore local claims and continue to require the verified signed-in member. Missing routes, integration unavailable, access refusal, loading and connection failure have distinct states. Previously loaded data is labelled stale during failed refresh; forbidden responses clear cached reads.
- Workflow list pagination and loaded-page filters; detail with server-derived task labels, blockers, exact accepted/total progress, goal/objective counts and supplied stop deadlines. No browser-clock release eligibility or inferred acceptance from worker logs.
- Creation draft with goal, objectives, summaries, assignees and dependencies together. Stable task keys, cycle prevention, three-prerequisite maximum, removal protection and all new tasks OFF. Creation is one atomic workflow request after a server preview, never staging calls to standalone task creation or assignment.
- Import previews preserve the selected group, explain both-direction dependency closure and require explicit exact-result review for completed imports. Add tasks, prepare, holds/release, dependency changes, retry/reassign, stop/reissue/lost-worker release, outside result/withdrawal and missing-evidence replacement use generated routes and current permissions/revisions.
- Workflow settings, ownership transfer, objective edits, connected-group move/removal, review outcomes with fresh correction/review pairs, owner resolution and paginated activity. Recorded review outcomes link the exact reviewed task, work revision and immutable file versions. Waiting rounds and older responses without the reviewed-task reference never borrow or guess evidence links.
- Saved evidence comes before worker diagnostics. Immutable file versions, readable/missing/corrupt/restore states, pending/superseded sets, incomplete evidence and cancelled/released attempt labels remain distinct. Goal and objective acceptance record exact evidence references separately from the human-only Finish request.
- Start and release previews now bind the generated `WorkflowImpact`, show each task’s checked resulting status and blockers, and echo the reviewed work revisions. Confirmation requires the same task/hold choices; mismatched, incomplete, refused or detail-only older responses cannot authorize a change. Cancellation shows server counts, retained accepted results and named workers to stop. Import offers unchecked start-when-ready choices only where the started workflow and server preview permit them, preserving invalid choices for explicit removal after refusal.
- Current list and graph stop warnings follow `display_state.list_warning`; inspector/history warnings follow the permanent `warning`. Withdrawal actor/reason and the review report’s own recorded work revision are displayed without borrowing the current owner or work version.
- Start, cancellation and Finish reviews re-fetch authoritative checks. Mutations retain their original key/body during uncertain outcomes, first look up a receipt and only permit an explicitly requested same-key retry after fresh permission checks. Refusals consume the confirmation, preserving typed drafts.
- Existing token/component system, keyboard-operable dependency diagram and equivalent relationship list, selection/neighborhood, search, zoom/fit, responsive dialogs and wrapped touch-height controls.

- Owner-only task OFF/ON controls now discover their generated routes, require a deliberate confirmation, explain future-action scope, and retain task authority/approval history separately. Missing routes and failed discovery do not enable writes. A lost autonomy response is **unconfirmed**, never “unchanged”: the endpoint has no receipt or revision precondition, so recovery reads the current setting without treating it as proof of the earlier save. There is no automatic retry.
- Verified human members may approve an OFF workflow task’s plan through the existing plan-decision route; workflow ownership is not required for that distinct decision. The existing assigned-plan selector and confirmation remain intact. The workflow member never exposes legacy result verification. The completion review is separate and checks the workflow revision, work revision and exact readable evidence versions before task Accept/Request changes; refusal consumes confirmation and retains feedback. Uncertain completion writes use receipt-first recovery and the original request key/body.
- The task inspector, task controls and Finish checklist display immutable acceptance actor/kind/time, accepted autonomy and work revision, exact saved file versions and hashes. Current assignee, owner, autonomy and newer evidence never replace those records. New saved evidence freezes the supplier ID, display alias and human/agent kind at capture time; outside-result review labels the supplier separately and explicitly records when the same person supplies and accepts a result. Historical rows are backfilled with the retained actor identity as it exists during upgrade (not reconstructed as the alias used at the original capture); older records that still lack attribution remain blocked from acceptance or Finish.
- Project and per-agent autonomy selectors have been removed. Wake, budget, objective, model, icon and unrelated `manage_autonomy` uses remain. Historical settings remain in configuration history, but restoring an old autonomy override is blocked in the portal. Task-level authority is the only editable autonomy surface.

Drafts and uncertain operation records are memory-only, scoped to connection origin, project and the current authorized human (selected locally or verified by the hosted proxy). SPA navigation retains them; reload/close retention is explicitly not promised. There is no offline mutation queue or automatic mutation replay.

## Final integration status — ready for independent review

1. **Outside-result supplier attribution:** implemented in the immutable evidence contract and portal review surfaces. Supplier identity is captured with the evidence, retained in the acceptance record, and never inferred from current ownership, assignment or free text. Acceptance and Finish regressions cover both attributed records and safe refusal of legacy records without attribution.
2. **Integrated count and historical-restore parity:** every `needs_verification` task now remains in human attention across portal, backend and desktop even when autonomy is ON. Historical per-agent autonomy is retained for audit, explicitly listed as restore-blocked and never reapplied.
3. **Formal requirements recording:** Kedar has answered the owner-only, future-actions-only and unfinished-tasks-OFF choices. The parent requirements still require recording them through a human-controlled path; Kedar’s editor has no Definition of Done field. This is an editing limitation, not an unanswered product decision. CodeCleanupAgent coordinates it. Do not resend the request or alter human requirements as an agent.
4. **Integrated review and regression:** the portal, backend, worker safeguards, desktop/native compatibility, generated contracts and tracked production assets are now combined. The integration branch descends from the existing approval-fix pull request head and preserves those fixes. Code Reviewer independently reviews this result before it is fast-forwarded to that pull request branch; Kedar verifies afterward. The running local server still does not offer the new Workflows writes, so fixture-backed checks are not claimed as a live deployment test.

## Native compatibility

Native Workflows parity is outside this assignment. The iOS and Android project-wide execution sheets and Settings rows now expose only the wake switch; they no longer present container autonomy as authority. Their container-autonomy write DTOs and client methods are removed. The backend keeps old persisted values as read-only history, rejects new legacy writes and starts unfinished migrated tasks with task autonomy OFF.

The existing `manage_autonomy` permission also covers budget, objective, wake and icon controls. Removing the legacy autonomy UI must not mechanically remove those unrelated controls or permission uses.

## Validation

From `orcha-cli/orcha_cli/templates/portal/frontend`:

```sh
npm test -- --maxWorkers=4
npm run build -- --outDir /tmp/dana-workflows-finish-build
```

- **3,192 portal tests pass across all 346 files.** Meaningful rendered cases cover owner/member/viewer authority, local workflow creation and plan approval, hosted/local trust separation, unsupported/refused routes, uncertain autonomy without replay, separate plan and completion review, exact evidence versions/hashes/storage, preserved feedback, same-key receipt recovery, historical controls, supplier guards, imported-result attribution and human attention for ON tasks.
- Portal typecheck and production build pass. Existing circular/large chunk warnings remain. The tracked distribution assets were rebuilt from the final source and generated contracts.
- Isolated browser checks covered task authority at desktop and 320px, plus narrow-screen result review, exact evidence links, acceptance history and confirmation. The check found cramped authority labels; existing stacked property layouts now keep them readable. Only local fixture responses and static assets were used, without live task writes. Temporary preview files/server/tab were removed and viewport override reset.
- **55 desktop route/count tests pass**, and the renderer typecheck passes. Full desktop typecheck still fails at unchanged `desktop/src/main/index.ts:1778` (`void` versus `Promise<void>`); it is not claimed to pass.
- **572 focused backend/integration tests pass** for Workflows, task autonomy, plan routing, duplicate notification protection, workflow workers, evidence, permissions, OpenAPI snapshots and project migration. The full Python run is not clean on this machine: its Git 2.23 client cannot execute the test fixtures' `git init -b` command, causing broad Git/worktree setup errors, with additional unrelated baseline failures. The focused affected suites were rerun independently and pass. PostgreSQL was unavailable locally, so that database leg remains for CI/review; SQLite schema and route checks pass.
- Android debug unit tests build successfully with the installed SDK. The complete iOS simulator suite passes **448 tests in 79 suites**.
- `git diff --check` passes. The contract generator produces 58 models/46 operations from the checked exact sources.

Prior checkpoints remain in branch history, including the 3,153-test full portal run, 37 desktop mapping tests, generated impact previews, history warnings, graph/list accessibility, retained drafts and routing fixes. This checkpoint preserves that work rather than replacing its base.

No deploy, default-branch merge, live setting/data changes, self-verification or completed-feature claim accompanies this checkpoint.
