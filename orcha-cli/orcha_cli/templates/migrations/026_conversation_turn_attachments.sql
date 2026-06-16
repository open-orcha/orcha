-- #338 ATTACHMENTS (feed-to-agent) — mirror mig 025 onto conversation turns.
-- Conversations get the SAME local-file attachment model as task-thread messages (#330/#301):
-- each conversation_turns row carries an `attachments` JSONB array of metadata + on-disk path
-- REFS (never the bytes — files live on the host project folder under the writable bind-mount,
-- now in a conversation-scoped subdir /app/orcha-attachments/conversations/<conv-id>/). Each
-- element shape mirrors the task-message ref exactly:
--   {"id": "<stored basename>", "name": "<original display name>",
--    "size": <bytes>, "content_type": "<mime>", "kind": "image"|"file",
--    "url": "/api/conversations/<conv-id>/attachments/<stored>"}
-- Default '[]' keeps every existing turn valid with zero backfill; the read paths COALESCE so
-- pre-migration rows surface an empty list. The feed-to-agent layer (#338) reads this column at
-- every injection point so an attached file actually reaches the agent's next turn.
ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
