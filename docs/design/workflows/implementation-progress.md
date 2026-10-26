# Workflows interface implementation checkpoint

This is an implementation checkpoint, not a completed feature or verification handoff. Dana owns portal presentation and desktop route mapping. ReleaseEngineer owns the workflow API; CodeCleanupAgent owns task autonomy, acceptance integration and final integration. Code Reviewer independently checks the integrated result; Kedar verifies.

The [implementation task](http://localhost:8004/tasks?task=fb80c6f1-b180-4ac2-b8c2-ef0fd81d0fdd) follows Kedar's new authorization in the [parent task](http://localhost:8004/tasks?task=1854c320-7719-4bd0-bdec-01586c1fa858). The original planning tasks remain untouched. The accepted task request remains unanswered until the full definition of done is materially satisfied. Do not call `/done` while Full would automatically certify the work.

## Verified sources and generated contracts

All nine approved files were freshly downloaded and matched manifest version 9. [The source record](approved-source-record.json) preserves immutable URLs, versions and fingerprints. The complete parent brief and canonical planning thread were read. Precedence remains plan version 13 sections 18 → 17 → 16 → 15 → 14, PDF version 11, then UI/screens version 7. Kedar's newer task-only autonomy requirement overrides human-only task acceptance in that package; workflow finish remains human-only.

The committed generated files are development contracts, not claims that the running server has these routes:

| Source | Origin | SHA-256 |
| --- | --- | --- |
| `workflows-openapi.json` | ReleaseEngineer branch `orcha/workflows-backend-20261025`, exact generated snapshot from `4772e401` | `9ec06a7f1db24b8223b04da8a9f82ab56ee937abd27490f5add7bd7917eb753f` |
| `workflow-evidence-openapi.json` | CodeCleanupAgent's generated evidence slice supplied through the evidence-contract request, subsequently saved with the evidence checkpoint | `a3a98a4093221faf85216c9e00bfa7d9ed5384c9c435b1f23dd5333f0bf45413` |

Regenerate the 47 TypeScript models, runtime schemas and 42 operations from the repository root:

```sh
node tools/generate-workflow-contract.mjs docs/design/workflows/workflows-openapi.json docs/design/workflows/workflow-evidence-openapi.json
```

The generator merges the evidence GET operation and its referenced schemas, rejects conflicting definitions and preserves the workflow service's evidence-write contract. Saved evidence references use `item_id`, `deliverable_id`, `deliverable_version` and `sha256`. Runtime validation rejects unsupported response/request shapes rather than presenting empty success.

## Implemented

- Shared portal/desktop navigation: Workflows after Overview, list/new/detail routes, task return links, membership discovery and add-to-new/existing-workflow entry. List filters and keyboard focus survive a detail round trip. Review, activity and Finish task links retain workflow context. TaskDetail's existing assignee plan selector is unchanged.
- Capability discovery, verified-sign-in and server-provided per-action permissions. Missing routes, integration unavailable, read-only local connections, access refusal, loading and connection failure have distinct states. Previously loaded data is labelled stale during failed refresh; forbidden responses clear cached reads.
- Workflow list pagination and loaded-page filters; detail with server-derived task labels, blockers, exact accepted/total progress, goal/objective counts and supplied stop deadlines. No browser-clock release eligibility or inferred acceptance from worker logs.
- Creation draft with goal, objectives, summaries, assignees and dependencies together. Stable task keys, cycle prevention, three-prerequisite maximum, removal protection and all new tasks OFF. Creation is one atomic workflow request after a server preview, never staging calls to standalone task creation or assignment.
- Import previews preserve the selected group, explain both-direction dependency closure and require explicit exact-result review for completed imports. Add tasks, prepare, holds/release, dependency changes, retry/reassign, stop/reissue/lost-worker release, outside result/withdrawal and missing-evidence replacement use generated routes and current permissions/revisions.
- Workflow settings, ownership transfer, objective edits, connected-group move/removal, review outcomes with fresh correction/review pairs, owner resolution and paginated activity. Recorded review outcomes link the exact reviewed task, work revision and immutable file versions. Waiting rounds and older responses without the reviewed-task reference never borrow or guess evidence links.
- Saved evidence comes before worker diagnostics. Immutable file versions, readable/missing/corrupt/restore states, pending/superseded sets, incomplete evidence and cancelled/released attempt labels remain distinct. Goal and objective acceptance record exact evidence references separately from the human-only Finish request.
- Start, cancellation and Finish reviews re-fetch authoritative checks. Mutations retain their original key/body during uncertain outcomes, first look up a receipt and only permit an explicitly requested same-key retry after fresh permission checks. Refusals consume the confirmation, preserving typed drafts.
- Existing token/component system, keyboard-operable dependency diagram and equivalent relationship list, selection/neighborhood, search, zoom/fit, responsive dialogs and wrapped touch-height controls.

Drafts and uncertain operation records are memory-only, scoped to connection origin, project and verified identity. SPA navigation retains them; reload/close retention is explicitly not promised. There is no offline mutation queue or automatic mutation replay.

## Remaining integration work — do not call this feature complete

1. **Task autonomy and task acceptance:** CodeCleanupAgent's latest contract answer says no generated read/write/permission contract is ready. Task ON/OFF presentation exists (absent means OFF), but changing it and task Accept/Reject stay explicitly unavailable in these forms. Replace container/per-agent controls only when that contract arrives. Preserve the existing approval routing. The generic task inspector/global task list still require workflow membership, projected states, evidence-first acceptance and appropriate suppression/replacement of legacy actions; do not enable Workflows before these seams are integrated.
2. **Formal requirements recording:** Kedar has answered the owner-only, future-actions-only and unfinished-tasks-OFF choices. The parent requirements still require recording them through a human-controlled path; Kedar's editor has no Definition of Done field. This is an editing limitation, not an unanswered product decision. CodeCleanupAgent is coordinating it. Do not resend the request for the missing field or alter the requirements as an agent.
3. **Page/history integration:** ReleaseEngineer supplied the [requested backend additions](http://localhost:8004/requests?request=a8953357-b022-4720-8cd8-363ae9118d4f) in `4772e401`: production SPA routes `/workflows`, `/workflows/new`, `/workflows/{workflow_id}`, plus recorded `ReviewHistory.reviewed_task_id` and `reviewed_work_revision`. This frontend binds those fields and tests exact-version links. CodeCleanupAgent still needs to integrate the backend commit and check combined production routing; no Python or SQL was copied into Dana’s branch.
4. **Acceptance audit projection:** the final integrated contract must expose the task acceptance actor/kind, same-person outside-result attribution, accepted evidence references and persistent historical stop warning so TaskDetail and the Finish/completed views can show them accurately. Current workflow DTOs do not supply this complete acceptance history. Do not infer attribution from the task assignee or current owner.
5. **Integrated review and regression:** reconcile these frontend files with CodeCleanupAgent's task policy, backend evidence, worker safeguards and notices; regenerate from the final combined OpenAPI; exercise real isolated routes and obtain Code Reviewer's review. Existing live local Workflows is unsupported, so the tests here exercise generated contracts with isolated responses, not a live end-to-end workflow.

## Native compatibility inventory

Native Workflows parity is outside this assignment. CodeCleanupAgent owns compatibility changes:

- iOS: `ContainerControlsSheet.swift`, Settings entry, `MobileUx.swift`, `AppModel.swift`, `OrchaApiClient.swift`, container DTO and agent configuration history.
- Android: `WorkspaceControlsSheet.kt`, Settings/Workspace entry points, `AgentAndWorkspaceHumanActions.kt`, `ProjectLogic.kt`, `OrchaApiClient.kt`, DTOs and agent history.

The existing `manage_autonomy` permission also covers budget, objective, wake and icon controls. Removing the legacy autonomy UI must not mechanically remove those unrelated controls or permission uses.

## Validation

From `orcha-cli/orcha_cli/templates/portal/frontend`:

```sh
npm test -- src/pages/workflows src/pages/tasks src/shell/routes.test.tsx src/shell/nav.test.ts src/shell/Sidebar.test.tsx
npm run build -- --outDir /tmp/dana-workflows-portal-build
```

- **360 portal tests passed** across 36 files, including 67 Workflows tests, existing task detail/approval behavior and shell routing. Targeted page/read-view tests: **14 passed** after the destination-heading focus refinement. The later review-history contract update has **7 rendered history tests passing**, including three new cases for recorded, pending and older-server references; this is a focused follow-up, not a claim that the broader suite was rerun after it.
- Portal typecheck and build pass. The build writes outside tracked `static/dist`; existing circular chunk/large chunk warnings remain.
- Desktop renderer typecheck passed; `projectModel.test.ts` and `embed.test.ts`: **37 passed**.
- Full desktop typecheck still fails in unchanged `src/main/index.ts:1778` (`void` versus `Promise<void>`). The file is byte-identical to the fetched reviewer-fix base. This checkpoint does not claim all desktop checks pass.
- Isolated browser inspection covered the Start review dialog at desktop, 390px and 320px, and the settings form at 320px. It found cramped footer actions; they now wrap. Preview data and fetches were local fixtures, with no live service calls. Temporary preview files/server/tab were removed. This does not substitute for final full-screen and integrated acceptance testing.
- `git diff --check` passes. No Python, SQL, native files or tracked distribution assets changed.

No deploy, default-branch merge, live setting/data changes, self-verification or completed-feature claim accompanies this checkpoint.
