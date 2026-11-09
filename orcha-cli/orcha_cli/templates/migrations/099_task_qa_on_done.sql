-- A task's own choice to go to Quality when its agent finishes it: JSON {enabled, platform, device,
-- kind, by, at}. NULL follows the project's Quality trigger.

ALTER TABLE tasks ADD COLUMN qa_on_done TEXT;
