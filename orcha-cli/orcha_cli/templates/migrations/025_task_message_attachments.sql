-- #301 ATTACHMENTS — local project-folder file attachments on task-thread messages.
-- Additive, path-only: each task_messages row carries an `attachments` JSONB array of
-- metadata + on-disk path REFS (never the bytes — per Kedar's ruling, files live on the
-- host project folder, mirroring Claude-Code/Codex pasted-image storage; the portal writes
-- them under a writable bind-mount at /app/orcha-attachments/<task-id>/ and serves them by
-- path). Each element shape:
--   {"id": "<stored basename>", "name": "<original display name>",
--    "size": <bytes>, "content_type": "<mime>", "kind": "image"|"file"}
-- Default '[]' keeps every existing row valid with zero backfill; the read paths
-- COALESCE so pre-migration rows surface an empty list.
ALTER TABLE task_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
