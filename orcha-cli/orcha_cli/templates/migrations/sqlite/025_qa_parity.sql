-- Orcha QA parity (docs/orcha-qa-ui-parity.md): what the QA screens show that 093 and 094 do not
-- store. ADD-only: new tables and new nullable or defaulted columns, no change to existing rows.

-- ==== exploration ====
-- A session as a person keeps it: its own name and notes, archived or pinned, the series it
-- belongs to (Run again stays in the series, Duplicate starts one), and queued until an agent
-- takes it (a queued row has queued_at and no claimed_at; its status stays running).
ALTER TABLE qa_sessions ADD COLUMN name TEXT;
ALTER TABLE qa_sessions ADD COLUMN notes TEXT;
ALTER TABLE qa_sessions ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE qa_sessions ADD COLUMN pinned_at TIMESTAMPTZ;
ALTER TABLE qa_sessions ADD COLUMN series_id UUID;
ALTER TABLE qa_sessions ADD COLUMN previous_session_id UUID REFERENCES qa_sessions(id) ON DELETE SET NULL;
ALTER TABLE qa_sessions ADD COLUMN queued_at TIMESTAMPTZ;
ALTER TABLE qa_sessions ADD COLUMN claimed_at TIMESTAMPTZ;
CREATE INDEX qa_sessions_series ON qa_sessions (container_id, series_id);
CREATE INDEX qa_sessions_task_queue ON qa_sessions (task_id, queued_at);

-- A finding's lens and fix prompt, who set its severity (the agent's stays in severity_reported),
-- and the one scenario drafted from it.
ALTER TABLE qa_findings ADD COLUMN lens TEXT;
ALTER TABLE qa_findings ADD COLUMN fix_prompt TEXT;
ALTER TABLE qa_findings ADD COLUMN severity_reported TEXT;
ALTER TABLE qa_findings ADD COLUMN severity_by TEXT;
ALTER TABLE qa_findings ADD COLUMN severity_reason TEXT;
ALTER TABLE qa_findings ADD COLUMN scenario_id UUID REFERENCES qa_scenarios(id) ON DELETE SET NULL;

-- What the audit measured on each screen a session reached (contrast, tap targets, labels,
-- bounds, overlap), apart from what an agent judged. One row per fingerprint per session.
CREATE TABLE qa_measured (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    summary TEXT NOT NULL,
    measured REAL,
    threshold REAL,
    unit TEXT,
    rect JSONB,
    element_label TEXT,
    element_identifier TEXT,
    appearance TEXT,
    confident BOOLEAN NOT NULL DEFAULT 1,
    extra JSONB NOT NULL DEFAULT '{}',
    screen_key TEXT,
    screen_hash TEXT,
    frame_id UUID REFERENCES qa_frames(id) ON DELETE SET NULL,
    step_seq INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (session_id, fingerprint)
);

-- The App model: what the agents understand the app to be, one numbered version per change.
CREATE TABLE qa_app_models (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    version INTEGER NOT NULL,
    source TEXT NOT NULL,
    summary TEXT,
    model JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (container_id, platform, version)
);

-- ==== runs ====
-- What a session's run page shows that qa_steps does not: its log lines, its network calls and a
-- person's answer to a criterion's verdict. seq is per session and the batch is idempotent on it.
CREATE TABLE IF NOT EXISTS qa_session_logs (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    step_seq INTEGER,
    at_ms INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL DEFAULT 'info',
    source TEXT NOT NULL DEFAULT 'console',
    text TEXT NOT NULL,
    detail JSONB,
    UNIQUE (session_id, seq),
    CONSTRAINT qa_session_logs_level_check CHECK (level IN ('error', 'warn', 'info', 'debug')),
    CONSTRAINT qa_session_logs_source_check CHECK (source IN ('console', 'network', 'device', 'crash'))
);

CREATE TABLE IF NOT EXISTS qa_session_requests (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    step_seq INTEGER,
    at_ms INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'fetch',
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    status INTEGER,
    duration_ms INTEGER,
    failure TEXT,
    request_body TEXT,
    UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS qa_criterion_feedback (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    criterion_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (session_id, scenario_id, criterion_index),
    CONSTRAINT qa_criterion_feedback_status_check CHECK (status IN ('not_a_bug', 'acknowledged', 'resolved'))
);

-- ==== scenarios ====
-- Scenario lifecycle (until / issue / replaced by), flaky quarantine, the run options a check honours
-- (fresh state, permissions, session), the scenario's own test data (examples, seed, cleanup, events)
-- and `shared`: a scenario that runs on every platform of the project.
ALTER TABLE qa_scenarios ADD COLUMN status_until TEXT;
ALTER TABLE qa_scenarios ADD COLUMN status_issue TEXT;
ALTER TABLE qa_scenarios ADD COLUMN replaced_by UUID REFERENCES qa_scenarios(id) ON DELETE SET NULL;
ALTER TABLE qa_scenarios ADD COLUMN quarantined_at TIMESTAMPTZ;
ALTER TABLE qa_scenarios ADD COLUMN quarantine_reason TEXT;
ALTER TABLE qa_scenarios ADD COLUMN quarantine_clean_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE qa_scenarios ADD COLUMN quarantine_released_at TIMESTAMPTZ;
ALTER TABLE qa_scenarios ADD COLUMN fresh BOOLEAN;
ALTER TABLE qa_scenarios ADD COLUMN permissions TEXT;
ALTER TABLE qa_scenarios ADD COLUMN session TEXT;
ALTER TABLE qa_scenarios ADD COLUMN shared BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE qa_scenarios ADD COLUMN examples JSONB;
ALTER TABLE qa_scenarios ADD COLUMN seed JSONB NOT NULL DEFAULT '[]';
ALTER TABLE qa_scenarios ADD COLUMN cleanup JSONB NOT NULL DEFAULT '[]';
ALTER TABLE qa_scenarios ADD COLUMN events JSONB NOT NULL DEFAULT '[]';

-- What a run said about a check line: a correction it proposes, the repairs it applied.
ALTER TABLE qa_verdicts ADD COLUMN check_fix JSONB;
ALTER TABLE qa_verdicts ADD COLUMN check_repairs JSONB NOT NULL DEFAULT '[]';
ALTER TABLE qa_verdicts ADD COLUMN example_row INTEGER;

-- Every save of a scenario, for History and Restore.
CREATE TABLE qa_scenario_versions (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    snapshot JSONB NOT NULL DEFAULT '{}',
    saved_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (scenario_id, version)
);

-- The scenario audit: its flags (a dismissal survives a flag coming and going) and when it last ran.
CREATE TABLE qa_scenario_health_flags (
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT 'open',
    detail JSONB NOT NULL DEFAULT '{}',
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    seen_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    dismissed_at TIMESTAMPTZ,
    dismissed_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    PRIMARY KEY (scenario_id, kind)
);
CREATE INDEX qa_scenario_health_flags_container ON qa_scenario_health_flags (container_id);

CREATE TABLE qa_scenario_health_audits (
    container_id UUID PRIMARY KEY NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    total INTEGER NOT NULL DEFAULT 0,
    counts JSONB NOT NULL DEFAULT '{}'
);

-- A check correction a person said no to: not offered again.
CREATE TABLE qa_check_fix_dismissals (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    criterion_index INTEGER NOT NULL,
    expression TEXT NOT NULL,
    proposed TEXT NOT NULL DEFAULT '',
    dismissed_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (scenario_id, criterion_index, expression, proposed)
);

-- Coverage growth: frozen baselines (the current one has superseded_at NULL) and one point a day.
CREATE TABLE qa_coverage_baselines (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    reason TEXT,
    app_build TEXT,
    evidence_version INTEGER NOT NULL DEFAULT 1,
    data JSONB NOT NULL DEFAULT '{}',
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    superseded_at TIMESTAMPTZ,
    CONSTRAINT qa_coverage_baselines_trigger_check CHECK (trigger_kind IN ('onboarding', 'first_mapping', 'rebaseline', 'manual'))
);
CREATE INDEX qa_coverage_baselines_container ON qa_coverage_baselines (container_id, created_at);

CREATE TABLE qa_coverage_points (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    evidence_version INTEGER NOT NULL DEFAULT 1,
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (container_id, day)
);

-- A person's decision about which scenario tests which feature area: it survives every recompute.
CREATE TABLE qa_coverage_links (
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    state TEXT NOT NULL,
    decided_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    PRIMARY KEY (scenario_id, feature_key),
    CONSTRAINT qa_coverage_links_state_check CHECK (state IN ('linked', 'confirmed', 'rejected'))
);
CREATE INDEX qa_coverage_links_container ON qa_coverage_links (container_id);

-- Data rows suggested for a scenario's Examples table: applied only when a person approves them.
CREATE TABLE qa_data_variations (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    technique TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    row_values JSONB NOT NULL DEFAULT '{}',
    row_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'suggested',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    decided_at TIMESTAMPTZ,
    UNIQUE (scenario_id, row_key),
    CONSTRAINT qa_data_variations_status_check CHECK (status IN ('suggested', 'applied', 'dismissed'))
);
CREATE INDEX qa_data_variations_container ON qa_data_variations (container_id, status);

-- Files attached to a scenario (stored on disk beside the frames), and the sealed cells of a secret
-- Examples column: the table holds `secret:sec_<id>`, the value lives here.
CREATE TABLE qa_scenario_files (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    size_bytes INTEGER,
    path TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00')
);
CREATE INDEX qa_scenario_files_scenario ON qa_scenario_files (scenario_id);

CREATE TABLE qa_example_secrets (
    id TEXT PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00')
);
CREATE INDEX qa_example_secrets_scenario ON qa_example_secrets (scenario_id);

-- ==== scenario drafting ====
-- What a drafting session reads (the Run QA source picker: code, exploration or both), and what
-- its drafter says while it works: its notes, the files it reads, its plan, each draft as it lands,
-- what it asks an explorer of the same task and the answers, revisions and a person's feedback.
ALTER TABLE qa_sessions ADD COLUMN draft_sources TEXT;

CREATE TABLE qa_session_messages (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body JSONB NOT NULL DEFAULT '{}',
    scenario_id UUID REFERENCES qa_scenarios(id) ON DELETE SET NULL,
    frame_id UUID REFERENCES qa_frames(id) ON DELETE SET NULL,
    reply_to UUID REFERENCES qa_session_messages(id) ON DELETE SET NULL,
    status TEXT,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT qa_session_messages_kind_check CHECK (kind IN ('note', 'read', 'search', 'draft', 'plan',
        'request', 'answer', 'correction', 'feedback')),
    CONSTRAINT qa_session_messages_status_check CHECK (status IS NULL OR status IN ('open', 'claimed',
        'answered', 'timed_out', 'cancelled'))
);
CREATE INDEX qa_session_messages_session ON qa_session_messages (session_id, seq);
CREATE INDEX qa_session_messages_scenario ON qa_session_messages (scenario_id);

-- ==== map and atlas ====
-- What a capture says, recorded by the CLI as it takes it (the portal never decodes a frame): the
-- frame's perceptual fingerprint ("<16 hex dHash>-<rrggbb>-<w>x<h>"), what it shows (light | dark)
-- and why it has no picture (uniform | flag_secure). A session's build and the appearance its
-- device was set to; a planned crawl's queue as `crawl_next` moves it. An action's time and how
-- it settled (appear_ms, settle_ms, settled, load per core). A person's speed budgets.
ALTER TABLE qa_sessions ADD COLUMN build_label TEXT;
ALTER TABLE qa_sessions ADD COLUMN device_appearance TEXT;
ALTER TABLE qa_sessions ADD COLUMN crawl_queue JSONB;
ALTER TABLE qa_frames ADD COLUMN fingerprint TEXT;
ALTER TABLE qa_frames ADD COLUMN appearance TEXT;
ALTER TABLE qa_frames ADD COLUMN blank TEXT;
ALTER TABLE qa_steps ADD COLUMN duration_ms INTEGER;
ALTER TABLE qa_steps ADD COLUMN timing JSONB;
CREATE TABLE qa_perf_settings (
    container_id UUID PRIMARY KEY NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    settings JSONB NOT NULL DEFAULT '{}',
    updated_by UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00')
);

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('025_qa_parity.sql'), ('095_qa_parity.sql');
