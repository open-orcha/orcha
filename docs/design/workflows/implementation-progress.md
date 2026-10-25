# Workflows interface implementation checkpoint

This is the first implementation slice, not a finished feature or a verification handoff. Dana owns portal presentation and desktop route mapping. ReleaseEngineer owns the workflow API; CodeCleanupAgent owns task autonomy and final integration. Code Reviewer checks the integrated result and Kedar verifies.

The [implementation task](http://localhost:8004/tasks?task=fb80c6f1-b180-4ac2-b8c2-ef0fd81d0fdd) follows Kedar's new authorization in the [parent task](http://localhost:8004/tasks?task=1854c320-7719-4bd0-bdec-01586c1fa858), superseding the older planning-only and cancellation instructions for this new assignment. The original planning tasks remain untouched.

## Verified sources

All nine exact-version files were downloaded and their bytes matched manifest version 9. [The source record](approved-source-record.json) preserves URLs, versions and checksums. The complete canonical task thread and the final clean package review were read. Precedence remains plan version 13 sections 18 → 17 → 16 → 15 → 14, PDF version 11, then UI/screens version 7. Kedar's newer task-only autonomy requirement overrides human-only task acceptance in that package; workflow finish remains human-only.

## Implemented in this slice

- Workflows sits immediately after Overview in portal navigation; list, creation and detail URLs stay in the shared shell. The desktop recognizes the same section without a second UI.
- The page checks the existing OpenAPI document once per project, with cancellation, timeout and explicit retry. Missing routes, unreadable discovery and a server whose newer contract is not bound have distinct honest states. Route presence never grants write authority. This is a temporary integration boundary.
- A local draft editor supports name, goal, execution mode, task summaries/details and dependencies during creation. Stable keys preserve edges when names change; cycle choices and a fourth dependency are disabled; removal cannot silently drop an edge. All draft tasks default OFF. The save button cannot send anything.
- Drafts remain in memory across SPA navigation, scoped to origin, project and signed-in identity. Reload/close retention is explicitly not promised. Discard requires confirmation. There is no offline mutation queue.
- Presentation components provide exact accepted-task fractions, server-projected task labels/reasons, prerequisite and dependent links, a bounded diagram plus full equivalent loaded-task list, stop deadlines supplied by the server, and persistent unconfirmed-stop warnings. Partial task data never becomes a total or completion verdict.
- Saved evidence links require an immutable version URL matching its label. Pending/missing evidence and unavailable worker details remain distinct. Blank diagnostics never claim that no files changed.

`WorkflowReadViews` inputs are local presentation models, **not** a declared wire contract. These components are not yet populated from live workflows. `WorkflowDraft` is likewise local form state, not a request body. The creation deep link permits this local editor only after verified identity is present; a selected local actor cannot unlock it. Save remains unavailable in every case.

## Work remaining before feature handoff

1. Bind the generated contract and capability/permission responses. Replace discovery's temporary adapter-unavailable boundary; add list pagination/filtering/detail loading, stale/error preservation and authoritative refresh. ReleaseEngineer confirmed that generated models were not yet available and will send them when ready.
2. Complete draft objectives/assignee selection, import closure previews, add-from-task and inspector return context, graph task selection/neighborhood/fit, and remaining approved forms.
3. Add mutation previews, exact-revision confirmations, same-key receipts and uncertain-save recovery; then Start/release/holds, review rounds/outside results, stop/retry/recovery/cancel, evidence upload/acceptance and two-step goal/Finish.
4. Replace legacy portal autonomy controls only after the owner decisions and generated write/permission contract arrive. CodeCleanupAgent confirmed stable fields `autonomy` (`off`/`on`, absent means OFF) and `autonomy_revision`. No container or agent fallback may grant task authority. Preserve the existing assignee plan selector.
5. ReleaseEngineer must add the server page routes for `/workflows`, `/workflows/new` and `/workflows/{workflow_id}`. Vite and React already recognize these routes; fresh production loads require server integration. No Python or SQL was edited here.
6. Complete independent review, address findings and submit for human verification. Do not call `/done` under Full autonomy, merge, deploy or rebuild tracked distribution assets.

## Native compatibility inventory

Native Workflows parity is outside this assignment. CodeCleanupAgent confirmed ownership of the compatibility changes:

- iOS: `ContainerControlsSheet.swift`, the Settings entry, `MobileUx.swift` labels, `AppModel.swift` action and `OrchaApiClient.swift` container-autonomy route; container DTO and agent configuration history expose old values.
- Android: `WorkspaceControlsSheet.kt`, Settings/Workspace entry points, `AgentAndWorkspaceHumanActions.kt`, `ProjectLogic.kt` labels, `OrchaApiClient.kt` and DTOs; agent history also exposes old values.

The permission grant named `manage_autonomy` is reused for unrelated budget, objective, wake and icon controls. Do not mechanically remove that grant or those controls when retiring autonomy levels.

## Validation

- Portal typecheck: passed.
- Portal rendered workflow, shell routing and sidebar tests: **52 passed**. Includes cycle prevention, dependency limit/removal, rename preservation, identity/project draft isolation, explicit discard, no staging writes, exact totals, immutable evidence, stop-state honesty and discovery failures.
- Desktop route/embed tests: **37 passed**. Nested Workflows routes map to the shared section; embed URL handling stays unchanged.
- Desktop renderer typecheck: passed. Full desktop typecheck stops in the unchanged baseline `src/main/index.ts:1778`: `copyText` returns void where Promise<void> is required. This line is identical to the fetched base.
- Portal build: passed into `/tmp/dana-workflows-portal-build`, leaving tracked `static/dist` untouched. Rollup reports existing primitive-barrel circular chunk and large-chunk warnings.
- Temporary illustrative browser harness: viewed desktop and 390px draft/detail layouts, dark and light tokens; no page exceptions or page-wide horizontal overflow. The graph scrolls within its own region. This is component inspection, not end-to-end live workflow validation. The harness was removed.

No workflow records, settings or live task outcomes were changed by this slice. No implementation review, final acceptance or full feature completion is claimed.
