-- Task-only autonomy. Existing and new tasks start OFF; legacy project/agent
-- settings are retained as immutable migration history but no longer grant authority.
ALTER TABLE tasks ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'off'
    CONSTRAINT tasks_autonomy_check CHECK (autonomy IN ('off','on'));
ALTER TABLE tasks ADD COLUMN autonomy_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN autonomy_changed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN autonomy_changed_by UUID REFERENCES agents(id);

CREATE TABLE legacy_autonomy_history (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    project_autonomy_level TEXT NOT NULL,
    project_autonomy_enforced BOOLEAN NOT NULL,
    agent_autonomy_override TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (container_id, agent_id)
);
INSERT INTO legacy_autonomy_history
    (id, container_id, agent_id, project_autonomy_level,
     project_autonomy_enforced, agent_autonomy_override)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))),2) || '-' ||
       substr('89ab',abs(random()) % 4 + 1,1) ||
       substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
       c.id, NULL, c.autonomy_level, c.autonomy_enforced, NULL
FROM containers c;
INSERT INTO legacy_autonomy_history
    (id, container_id, agent_id, project_autonomy_level,
     project_autonomy_enforced, agent_autonomy_override)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))),2) || '-' ||
       substr('89ab',abs(random()) % 4 + 1,1) ||
       substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
       a.container_id, a.id, c.autonomy_level, c.autonomy_enforced, a.autonomy_override
FROM agents a JOIN containers c ON c.id = a.container_id
WHERE a.autonomy_override IS NOT NULL;

CREATE TABLE task_approval_records (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CONSTRAINT task_approval_phase_check CHECK (phase IN ('plan','completion')),
    work_revision INTEGER NOT NULL,
    requirements_sha256 TEXT NOT NULL,
    submission_sha256 TEXT NOT NULL,
    actor_id UUID NOT NULL REFERENCES agents(id),
    actor_kind TEXT NOT NULL CONSTRAINT task_approval_actor_check CHECK (actor_kind IN ('human','ai')),
    autonomy_at_approval TEXT NOT NULL CONSTRAINT task_approval_autonomy_check CHECK (
        autonomy_at_approval IN ('off','on')
        AND (actor_kind = 'human' OR autonomy_at_approval = 'on')
    ),
    autonomy_revision INTEGER NOT NULL,
    permission_source TEXT NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT task_approval_revision_check CHECK (work_revision > 0 AND autonomy_revision > 0),
    UNIQUE (task_id, phase, work_revision, submission_sha256)
);
CREATE INDEX idx_task_approval_records_task
    ON task_approval_records(task_id, phase, approved_at, id);

INSERT OR IGNORE INTO schema_migrations(version)
VALUES ('004_task_autonomy.sql'), ('074_task_autonomy.sql');
