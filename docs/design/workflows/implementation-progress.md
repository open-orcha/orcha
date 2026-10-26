# Workflows interface implementation checkpoint

This is an implementation checkpoint, not a completed feature or verification handoff. Dana owns portal presentation and desktop route mapping. ReleaseEngineer owns the workflow API; CodeCleanupAgent owns task autonomy, acceptance integration and final integration. Code Reviewer independently checks the integrated result; Kedar verifies.

The [implementation task](http://localhost:8004/tasks?task=fb80c6f1-b180-4ac2-b8c2-ef0fd81d0fdd) follows Kedar's new authorization in the [parent task](http://localhost:8004/tasks?task=1854c320-7719-4bd0-bdec-01586c1fa858). The original planning tasks remain untouched. The accepted task request remains unanswered until the full definition of done is materially satisfied. Do not call `/done` while Full would automatically certify the work.

## Verified sources and generated contracts

All nine approved files were freshly downloaded and matched manifest version 9. [The source record](approved-source-record.json) preserves immutable URLs, versions and fingerprints. The complete parent brief and canonical planning thread were read. Precedence remains plan version 13 sections 18 → 17 → 16 → 15 → 14, PDF version 11, then UI/screens version 7. Kedar's newer task-only autonomy requirement overrides human-only task acceptance in that package; workflow finish remains human-only.

The committed generated files are development contracts, not claims that the running server has these routes:

| Source | Origin | SHA-256 |
| --- | --- | --- |
| `workflows-openapi.json` | CodeCleanupAgent’s [confirmed integrated contract](http://localhost:8004/requests?request=cb191d08-491b-4898-ae87-3c70973e60e3), based on `4e3c7d6654c9a90f25fd58b6e796b60de74bdb16` | `5d9a0426c866cddc5b37e70666f5129872a6eead62a42e5d5dc60adca9e85099` |
| `workflow-evidence-openapi.json` | CodeCleanupAgent's generated evidence slice supplied through the evidence-contract request, subsequently saved with the evidence checkpoint | `a3a98a4093221faf85216c9e00bfa7d9ed5384c9c435b1f23dd5333f0bf45413` |

Regenerate the 58 TypeScript models, runtime schemas and 46 operations from the repository root:

```sh
node tools/generate-workflow-contract.mjs docs/design/workflows/workflows-openapi.json docs/design/workflows/workflow-evidence-openapi.json
```

The generator merges the evidence GET operation and its referenced schemas, rejects conflicting definitions and preserves the workflow service's evidence-write contract. Saved evidence references use `item_id`, `deliverable_id`, `deliverable_version` and `sha256`. Runtime validation rejects unsupported response/request shapes rather than presenting empty success.

## Implemented

- Shared portal/desktop navigation: Workflows after Overview, list/new/detail routes, task return links, membership discovery and add-to-new/existing-workflow entry. List filters and keyboard focus survive a detail round trip. Review, activity and Finish task links retain workflow context. TaskDetail's existing assignee plan selector is unchanged.
- Existing Tasks list/board, task inspector and Needs you now share a complete, paginated workflow-membership read. Workflow members show the server's status/blockers, task ON/OFF and saved evidence before diagnostics, with a focused link back to their workflow controls. Legacy hold, release, assignment, cancel, run-stop and approval controls stay unavailable for workflow members or while membership is uncertain. Standalone actions resume only after a complete successful read or an explicitly unsupported older server. Focus/manual refresh preserves comment and rejection drafts; access refusal and identity/project changes clear prior workflow reads. Plan attention depends only on task OFF/ON. Every `needs_verification` task remains in human attention, including ON outside results; a worker’s authorized self-acceptance instead transitions to `completed`.
- Capability discovery, verified-sign-in and server-provided per-action permissions. Missing routes, integration unavailable, read-only local connections, access refusal, loading and connection failure have distinct states. Previously loaded data is labelled stale during failed refresh; forbidden responses clear cached reads.
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
- The task inspector, task controls and Finish checklist display immutable acceptance actor/kind/time, accepted autonomy and work revision, exact saved file versions and hashes. Current assignee, owner, autonomy and newer evidence never replace those records. Outside/owner supplier attribution is explicitly unavailable under the currently published contract; dependent acceptance and Finish remain disabled pending the promised immutable replacement.
- Project and per-agent autonomy selectors have been removed. Wake, budget, objective, model, icon and unrelated `manage_autonomy` uses remain. Historical settings remain in configuration history, but restoring an old autonomy override is blocked in the portal. Task-level authority is the only editable autonomy surface.

Drafts and uncertain operation records are memory-only, scoped to connection origin, project and verified identity. SPA navigation retains them; reload/close retention is explicitly not promised. There is no offline mutation queue or automatic mutation replay.

## Remaining integration work — do not call this feature complete

1. **Outside-result supplier attribution:** CodeCleanupAgent’s [latest contract answer](http://localhost:8004/requests?request=bc7aed8d-0bc8-428e-afb3-a4d7e3d1d6ef) confirms the supplier fields are only in an uncommitted integration copy. Keep this branch on the exact published contract above. The lead will send a new request with an immutable commit and OpenAPI SHA; then bind the recorded supplier/alias and same-person label, replace the temporary unavailable guards, and add acceptance/Finish regression tests. Never infer supplier from current owner/assignee or free text.
2. **Integrated count and historical-restore parity:** the lead [confirmed](http://localhost:8004/requests?request=eeb45333-1d20-44e1-983e-ed13f9fd0f4b) `needs_verification` itself is the authoritative human-acceptance marker regardless of ON/OFF. The portal now follows it. CodeCleanupAgent owns the already-edited desktop attention and backend counts. The integrated history route currently refuses an old override with HTTP 410 indirectly after advertising it in `restore_preview`; the lead still needs explicit `restore_blocked` projection and stale-test cleanup. Portal restore is already blocked without deleting unrelated permissions.
3. **Formal requirements recording:** Kedar has answered the owner-only, future-actions-only and unfinished-tasks-OFF choices. The parent requirements still require recording them through a human-controlled path; Kedar’s editor has no Definition of Done field. This is an editing limitation, not an unanswered product decision. CodeCleanupAgent coordinates it. Do not resend the request or alter human requirements as an agent.
4. **Integrated review and regression:** combine these frontend changes with CodeCleanupAgent’s task policy, supplier evidence, worker safeguards, desktop/native compatibility and notices; regenerate from the final combined OpenAPI; exercise isolated real routes and production SPA mappings; obtain Code Reviewer’s independent review, then Kedar’s verification. The running local server still does not offer the new Workflows writes. Fixture-backed tests are not a live end-to-end result.

The finish branch is based exactly on the lead’s integration baseline `7e273e41a7f790c04d603c5b2f51861e32252634`, which already contains the earlier portal work and current reviewer fixes. The original implementation branch remains untouched. Dana retains TaskDetail ownership until handoff; Python/SQL/backend, native files and tracked distribution assets are not part of this checkpoint.

## Native compatibility inventory

Native Workflows parity is outside this assignment. CodeCleanupAgent owns compatibility changes:

- iOS: `ContainerControlsSheet.swift`, Settings entry, `MobileUx.swift`, `AppModel.swift`, `OrchaApiClient.swift`, container DTO and agent configuration history.
- Android: `WorkspaceControlsSheet.kt`, Settings/Workspace entry points, `AgentAndWorkspaceHumanActions.kt`, `ProjectLogic.kt`, `OrchaApiClient.kt`, DTOs and agent history.

The existing `manage_autonomy` permission also covers budget, objective, wake and icon controls. Removing the legacy autonomy UI must not mechanically remove those unrelated controls or permission uses.

## Validation

From `orcha-cli/orcha_cli/templates/portal/frontend`:

```sh
npm test -- --maxWorkers=4
npm run build -- --outDir /tmp/dana-workflows-finish-build
```

- **3,182 portal tests pass across all 346 files** with four workers. The final inspector/acceptance-record regression rerun adds **16 passing tests** after a small definition-of-done visibility fix. Meaningful rendered cases cover owner/member/viewer authority, unsupported/refused routes, uncertain autonomy without replay, separate plan and completion review, exact evidence versions/hashes/storage, preserved feedback, same-key receipt recovery, historical controls, supplier guards and human attention for ON tasks.
- Portal typecheck and external-output build pass. Existing circular/large chunk warnings remain. No tracked distribution assets are rebuilt.
- Isolated browser checks covered task authority at desktop and 320px, plus narrow-screen result review, exact evidence links, acceptance history and confirmation. The check found cramped authority labels; existing stacked property layouts now keep them readable. Only local fixture responses and static assets were used, without live task writes. Temporary preview files/server/tab were removed and viewport override reset.
- **37 desktop route mapping tests pass**, and the renderer typecheck passes. Full desktop typecheck still fails at unchanged `desktop/src/main/index.ts:1778` (`void` versus `Promise<void>`); it is not claimed to pass. Desktop implementation is unchanged in this checkpoint; the lead owns its attention update.
- `git diff --check` passes. The contract generator produces 58 models/46 operations from the checked exact sources. No Python, SQL, native or tracked distribution files changed.

Prior checkpoints remain in branch history, including the 3,153-test full portal run, 37 desktop mapping tests, generated impact previews, history warnings, graph/list accessibility, retained drafts and routing fixes. This checkpoint preserves that work rather than replacing its base.

No deploy, default-branch merge, live setting/data changes, self-verification or completed-feature claim accompanies this checkpoint.
