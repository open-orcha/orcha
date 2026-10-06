-- Manager review handoff: finished work follows the org chart (mig 052 reporting lines).
--
-- When an agent's /done parks a task at needs_verification, the review is routed by
-- portal_backend/review_routing.py according to the project's setting:
--
--   containers.review_route
--     'manager_chain' (default) — the finisher's nearest actionable HUMAN manager becomes
--                     the task's reviewer (no reporting line → today's behaviour: anyone);
--     'owner'         — the project owner becomes the reviewer;
--     'anyone'        — no automatic reviewer (the pre-057 behaviour).
--   containers.ai_manager_prereview
--     true (default)  — when an AI manager sits between the finisher and that human, the AI
--                     manager is asked to PRE-review first (a normal request → a normal wake).
--                     Its recommendation is advisory; a human still verifies.
--
--   tasks.review_routing — how the current reviewer was chosen:
--     {routed_via: 'reports_to'|'owner'|'fallback'|'manual', reviewer_alias,
--      assignee_alias, manager_depth, reports_to_skipped, ...}. NULL = never routed.
--     'manual' = a human set (or cleared) the reviewer via PUT /api/tasks/{tid}/reviewer;
--     automatic routing never overwrites a manual choice.
--   tasks.manager_review — the AI manager pre-review record:
--     {status: 'pending'|'approved'|'sent_back'|'commented'|'superseded'|'overridden',
--      manager_agent_id, manager_alias, request_id, recommendation, reasons,
--      requested_at, decided_at}. NULL = no pre-review.
--
-- ADD-only: existing rows get the defaults / NULL; nothing is rewritten.
ALTER TABLE containers
    ADD COLUMN IF NOT EXISTS review_route TEXT NOT NULL DEFAULT 'manager_chain'
        CHECK (review_route IN ('manager_chain', 'owner', 'anyone'));

ALTER TABLE containers
    ADD COLUMN IF NOT EXISTS ai_manager_prereview BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS review_routing JSONB NULL;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS manager_review JSONB NULL;
