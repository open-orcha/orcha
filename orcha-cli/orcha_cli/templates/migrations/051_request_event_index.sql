-- Parity r1 (escalations): the portal snapshot / request list now resolve each request's
-- latest `escalated` audit event (escalated_at + who it was escalated from) with a
-- per-row lookup on events. events had no index on entity_id, so that lookup would
-- seq-scan the whole audit log once per request row on every snapshot poll.
--
-- ADD-only: a partial index over request events. No data is read, changed or reset.
CREATE INDEX IF NOT EXISTS idx_events_request_entity
    ON events (entity_id, event_type, created_at)
    WHERE entity_type = 'request';
