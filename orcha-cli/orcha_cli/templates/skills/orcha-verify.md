---
description: Human verifies a task in needs_verification. Approve → completed (may unblock downstream tasks); reject with feedback → back to in_progress.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <task_id> [--reject "feedback explaining what's missing"] [--alias <human alias>]
---

You are executing `/orcha-verify`. This is a **human-only** action — the API rejects it when the actor isn't kind='human' (Orcha#30).

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `task_id` (UUID)
   - Optional `--reject "..."` — if present, this is a rejection with feedback. Otherwise this is an approval.
   - Optional `--alias <human-alias>` — see step 2.

2. **Identify the acting human** using the standard 4-step resolution (`--alias` → `$ORCHA_ALIAS` → single binding → AskUserQuestion picker). Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`. The API verifies this is `kind='human'` and returns 403 if not.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **Fetch the reviewable diff (approval–diff binding).** An approval must be bound to the
   exact diff the human reviewed, so BEFORE approving:
   ```bash
   curl -fsS "<api_base_url>/api/tasks/<task_id>/diff"
   ```
   Response: `{"task_id": "...", "diff_digest": "sha256:..." | null, "runs": [{"run_id", "agent_id", "started_at", "diff"}]}`.
   - If `diff_digest` is non-null: **show the diff(s) to the user** (render the unified diff,
     or summarize per-file changes if very large and offer the raw diff on request). The
     human is approving THIS diff — do not skip showing it.
   - If `diff_digest` is null: no code diff was captured (research/coordination task) —
     verification proceeds on the claimed result alone; omit `diff_digest` in step 5.

5. **POST**:
   ```bash
   # Approval (include diff_digest EXACTLY as returned by step 4 when non-null):
   curl -fsS -X POST "<api_base_url>/api/tasks/<task_id>/verify" \
     -H 'Content-Type: application/json' \
     -d '{"approve": true, "actor_agent_id": "<my human agent_id>", "diff_digest": "<diff_digest-or-omit>"}'

   # Rejection (diff_digest not required — rejecting is never blocked by staleness):
   curl -fsS -X POST "<api_base_url>/api/tasks/<task_id>/verify" \
     -H 'Content-Type: application/json' \
     -d '{"approve": false, "feedback": "<feedback>", "actor_agent_id": "<my human agent_id>"}'
   ```

6. **Report**:
   - Approval response: `{"task_id": "...", "status": "completed", "unblocked": [...]}`. Tell the user the task is completed; if `unblocked` is non-empty, list those task ids as "now ready to claim".
   - Rejection response: `{"task_id": "...", "status": "in_progress", "feedback": "..."}`. Tell the user the task is back to in_progress with the feedback recorded as a message on the task thread.
   - If approval completes the **root task**, the container itself auto-completes. The response includes the unblocked list but the container will show `status=completed` on next `/orcha-status`.

## Missing required arguments

If `task_id` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect it. Suggest checking `/orcha-status` first for tasks currently in `needs_verification`. If multiple such tasks exist, offer each as an option.

## Errors

- **403** "this action requires kind in ('human',)" → the resolved alias is an agent, not a human. Re-resolve to a human alias.
- **409** "task is '<status>', not 'needs_verification'" → only tasks awaiting verification can be verified (unless it's the root, which is verifiable from any non-terminal state).
- **400** "approving requires `diff_digest`" → the task has a captured diff; run step 4, show it, and resend with the digest.
- **409** "diff_digest is stale" → a new worker run landed a diff AFTER the review. Re-fetch step 4, show the user what changed, and only then approve with the fresh digest.
- **409** "no captured diff, but a diff_digest was supplied" → you sent a digest for the wrong task; re-check `task_id`.
