-- GH #312: retry-safe anonymous handoff notices, including interleaved posts.
CREATE TABLE system_notice_receipts (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    notice_key UUID NOT NULL,
    message_id UUID NOT NULL REFERENCES task_messages(id) ON DELETE CASCADE,
    body_digest TEXT NOT NULL,
    PRIMARY KEY(task_id, notice_key)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES ('016_system_notice_receipts.sql'),('086_system_notice_receipts.sql');
