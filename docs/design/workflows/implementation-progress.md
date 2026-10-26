# Workflows and task autonomy integration checkpoint

This is the integrated implementation checkpoint, not a verification claim. Dana supplied the portal presentation and desktop route mapping, ReleaseEngineer supplied the workflow API, and CodeCleanupAgent integrated task autonomy, acceptance, worker safeguards and final contracts. Code Reviewer independently checks the integrated result; Kedar verifies.

The [implementation task](http://localhost:8004/tasks?task=fb80c6f1-b180-4ac2-b8c2-ef0fd81d0fdd) follows Kedar's new authorization in the [parent task](http://localhost:8004/tasks?task=1854c320-7719-4bd0-bdec-01586c1fa858). The original planning tasks remain untouched. The accepted task request remains unanswered until the full definition of done is materially satisfied. Do not call `/done` while Full would automatically certify the work.

## Verified sources and generated contracts

All nine approved files were freshly downloaded and matched manifest version 9. [The source record](approved-source-record.json) preserves immutable URLs, versions and fingerprints. The complete parent brief and canonical planning thread were read. Precedence remains plan version 13 sections 18 → 17 → 16 → 15 → 14, PDF version 11, then UI/screens version 7. Kedar's newer task-only autonomy requirement overrides human-only task acceptance in that package; workflow finish remains human-only.

The committed generated files are development contracts, not claims that the running server has these routes:

| Source | Origin | SHA-256 |
| --- | --- | --- |
| `workflows-openapi.json` | Final integrated FastAPI slice, including task-autonomy and approval-history routes | `5d9a0426c866cddc5b37e70666f5129872a6eead62a42e5d5dc60adca9e85099` |
| `workflow-evidence-openapi.json` | CodeCleanupAgent's generated evidence slice supplied through the evidence-contract request, subsequently saved with the evidence checkpoint | `a3a98a4093221faf85216c9e00bfa7d9ed5384c9c435b1f23dd5333f0bf45413` |

Regenerate the 58 TypeScript models, runtime schemas and 46 operations from the repository root:

```sh
node tools/generate-workflow-contract.mjs docs/design/workflows/workflows-openapi.json docs/design/workflows/workflow-evidence-openapi.json
```

The generator merges the evidence GET operation and its referenced schemas, rejects conflicting definitions and preserves the workflow service's evidence-write contract. Saved evidence references use `item_id`, `deliverable_id`, `deliverable_version` and `sha256`. Runtime validation rejects unsupported response/request shapes rather than presenting empty success.

## Implemented

- Shared portal/desktop navigation: Workflows after Overview, list/new/detail routes, task return links, membership discovery and add-to-new/existing-workflow entry. List filters and keyboard focus survive a detail round trip. Review, activity and Finish task links retain workflow context. TaskDetail's existing assignee plan selector is unchanged.
- Existing Tasks list/board, task inspector and Needs you share a complete, paginated workflow-membership read. Workflow members show server status/blockers, task ON/OFF, the exact acceptance actor/authority/version and saved evidence before diagnostics, with a focused link back to workflow controls. Attention counts and desktop notifications use each task's autonomy only. Legacy hold, release, assignment, cancel, run-stop and standalone approval controls stay unavailable for workflow members or while membership is uncertain.
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

Drafts and uncertain operation records are memory-only, scoped to connection origin, project and verified identity. SPA navigation retains them; reload/close retention is explicitly not promised. There is no offline mutation queue or automatic mutation replay.

## Final integration status — awaiting independent review

1. **Task autonomy and task acceptance:** all new and migrated unfinished tasks default OFF. Only the project owner may change an active non-root task; changes apply to future actions and retain earlier approvals. ON permits the assigned agent to approve its exact plan and result; OFF records human plan and completion approval. Workflow acceptance records actor name/kind, work and autonomy revisions, permission source, time, evidence set and exact file versions/hashes. Plan approvals remain separate. Project/per-agent legacy settings are captured in migration history, their write routes return a compatibility error, and no agent decision reads them.
2. **Formal requirements recording:** Kedar has answered the owner-only, future-actions-only and unfinished-tasks-OFF choices. The parent requirements still require recording them through a human-controlled path; Kedar's editor has no Definition of Done field. This is an editing limitation, not an unanswered product decision. CodeCleanupAgent is coordinating it. Do not resend the request for the missing field or alter the requirements as an agent.
3. **Page/history and worker integration:** production Workflows routes, review versions, immutable evidence, checked impact previews, reservation/stop fencing, unexpected-exit recovery, cancelled scheduled-wake cleanup and current/permanent warning distinctions are integrated. A human source-workflow owner may move an eligible connected task group to another active workflow; both histories record the move.
4. **Remaining gate:** run the complete repository regression set, resolve any independent Code Reviewer blockers, update the existing pull-request branch, and return to Kedar for verification. Workflows stay behind the integration gate until those checks finish. No default-branch merge or deployment is authorized here.

## Native compatibility

Native Workflows parity is outside this assignment. The iOS and Android project-wide execution sheets and Settings rows now expose only the wake switch; they no longer present container autonomy as authority. Legacy DTOs, API methods and configuration-history labels remain temporarily readable for mixed-version compatibility, while the server rejects new legacy writes and the migration preserves old values as history.

The existing `manage_autonomy` permission also covers budget, objective, wake and icon controls. Removing the legacy autonomy UI must not mechanically remove those unrelated controls or permission uses.

## Validation

From `orcha-cli/orcha_cli/templates/portal/frontend`:

```sh
npm test -- --maxWorkers=4
npm run build -- --outDir /tmp/dana-workflows-portal-build
```

- Prior checkpoint: **423 portal tests passed** across 44 files after the task-context integration, including existing approval-routing/assigned-plan regressions, review-history exact links, paginated membership, malformed/failed/forbidden reads, saved evidence before diagnostics, workflow action suppression in Tasks and Needs you, draft retention, and keyboard focus. An initial unrestricted parallel run timed out under load; the four-worker run also exposed delayed rejection-form focus after Escape. The focus callback now checks the form is still open, Cancel returns focus to the trigger, and the complete four-worker run passes.
- Portal typecheck and build pass. The build writes outside tracked `static/dist`; existing circular chunk/large chunk warnings remain.
- Desktop renderer typecheck passed; `projectModel.test.ts` and `embed.test.ts`: **37 passed**.
- Full desktop typecheck still fails in unchanged `src/main/index.ts:1778` (`void` versus `Promise<void>`). The file is byte-identical to the fetched reviewer-fix base. This checkpoint does not claim all desktop checks pass.
- Isolated browser inspection covered the Start review dialog at desktop, 390px and 320px, and the settings form at 320px. It found cramped footer actions; they now wrap. Preview data and fetches were local fixtures, with no live service calls. Temporary preview files/server/tab were removed. This does not substitute for final full-screen and integrated acceptance testing.
- The later task-context preview checked the global row and task inspector at desktop and 320px. Workflow labels wrap in the row and below the detail title; a compact, neutrally labelled header glyph avoids clipping the action buttons. The preview used read-only fixtures and local static assets, never a live task write.
- `git diff --check` passes. No Python, SQL, native files or tracked distribution assets changed.

No deploy, default-branch merge, live setting/data changes, self-verification or completed-feature claim accompanies this checkpoint.

## Latest contract-binding follow-up

All nine approved source files were freshly downloaded and hash-checked again. ReleaseEngineer confirmed the generated snapshot at `6485d522` (38 paths, 48 workflow schemas; 51 models after merging the unchanged evidence GET slice). The refreshed approval-fix reference remains `c06dde67`; CodeCleanupAgent has requested no contributor rebase. This branch preserves its existing commits and routing fixes.

The focused workflow suite passes **91 tests in 13 files**. A full-suite run exposed three fixture assumptions in older integration tests (four failures): navigation omitted Workflows, the standalone evidence fixture returned a discovery failure instead of a supported OpenAPI response, and protocol editing did not await the asynchronous membership/identity check. Those tests now cover the intended navigation and wait for the permission-bearing controls; their **26 tests pass** without weakening any product safeguard.

Browser inspection used isolated read-only fixture responses and local static assets. Start was inspected at desktop and 320px, and cancellation/import at 320px. Checked outcomes, long import labels and wrapped footer controls remain readable and reachable. The temporary files, server and tab were removed and viewport override reset. No live mutation was sent.

Final validation for this follow-up: **3,153 portal tests passed across all 342 files** with `--maxWorkers=4`; the portal typecheck and external-output build pass. Existing test-harness console warnings (unimplemented browser navigation/scroll and deliberate error-boundary probes) and build chunk warnings remain; no test failed. Desktop code is unchanged from the earlier 37-test mapping check, and the earlier full desktop typecheck limitation remains. `git diff --check` passes.
