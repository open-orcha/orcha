-- GH #56 (Point 3): link a request to the task its requester was working on when it asked.
--
-- Today a request row carries requester_id / target_id / spawned_task_id / parent_request_id
-- but NOTHING tying it to the task the requester had in_progress when it sent the ask. So when
-- the answer comes back, the wake that consumes it attaches to no task — the task page looks
-- idle even though work happened on its behalf, and the protocol-load path has to GUESS the
-- agent's "one in_progress task" (wrong when the agent has several).
--
-- This adds a NULLABLE column. It is OPTIONAL by design: requests sent from a conversation, or
-- any context with no attached task, leave it null. It is AGENT-SUPPLIED, never backend-guessed
-- (a requester can have multiple tasks in progress, so a backend guess would be wrong) — the
-- requesting agent passes the id of the task it is working on, and the backend validates that a
-- SUPPLIED id is a real task in this container the requester participates in (see main.py
-- create_request). ON DELETE SET NULL: if the originating task is later deleted, the request
-- survives with a null link rather than cascading away.
--
-- Migration number: 028 (027 = container_provider_keys). Pure additive, zero-behaviour-change:
-- a new nullable column, no backfill, applied on portal boot by the R1 migration runner.
ALTER TABLE requests
    ADD COLUMN IF NOT EXISTS originating_task_id UUID
    REFERENCES tasks(id) ON DELETE SET NULL;
