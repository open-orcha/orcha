-- ISS-70 (#169): cross-embodiment digest re-sync. A resident warm-resumes its pinned claude
-- session and never re-reads agent_memory_digests, so a digest written by ANOTHER embodiment
-- (e.g. a live-terminal close → C1 snapshot) is invisible to the resident — the "wrong codeword"
-- repro. Fix: stamp WHEN the resident's session was pinned, so the server can tell the notifier to
-- force a one-shot COLD boot (which re-injects persona+digest) when the latest digest is NEWER than
-- the pin. Self-limiting: the cold boot re-pins session_pinned_at = now() (> the digest snapshot_ts),
-- so the signal flips back to false and subsequent turns warm-resume normally.
--
-- session_pinned_at is stamped now() wherever conversations.session_id is set (the
-- POST /api/conversations/{id}/session endpoint). Backfill: existing rows stay NULL → treated as
-- "needs one cold boot" (a pinned session with no pin timestamp re-injects the digest once), safe.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_pinned_at TIMESTAMPTZ;
