-- A task's own choice to go to Quality when its agent finishes it: JSON {enabled, platform, device,
-- kind, by, at}. NULL follows the project's Quality trigger.

ALTER TABLE tasks ADD COLUMN qa_on_done TEXT;

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('029_task_qa_on_done.sql'), ('099_task_qa_on_done.sql');
