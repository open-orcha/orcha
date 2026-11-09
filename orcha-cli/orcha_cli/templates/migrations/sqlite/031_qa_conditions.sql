-- Run conditions (qa_conditions.py): the state a case needs before it can be judged (an OS
-- version, a language and region, text size, appearance, a time zone, a network, the kind of
-- account, setup steps for the agent). JSON text; NULL asks for nothing.

ALTER TABLE qa_scenarios ADD COLUMN conditions TEXT;
ALTER TABLE qa_findings ADD COLUMN conditions TEXT;
ALTER TABLE qa_requests ADD COLUMN conditions TEXT;
ALTER TABLE qa_sessions ADD COLUMN conditions TEXT;

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('031_qa_conditions.sql'), ('101_qa_conditions.sql');
