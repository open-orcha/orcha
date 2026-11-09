-- The device a Quality step runs on: the name a person picked, or NULL for the agent to pick.

ALTER TABLE qa_requests ADD COLUMN device TEXT;
