-- The device a Quality step runs on: the name a person picked, or NULL for the agent to pick.

ALTER TABLE qa_requests ADD COLUMN device TEXT;

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('028_qa_request_device.sql'), ('098_qa_request_device.sql');
