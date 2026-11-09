-- Orcha QA (docs/orcha-qa-plan.md): an app's map, the agents' QA sessions on an iOS simulator,
-- an Android emulator or a web browser (steps, frames, findings, flows, walks), and the scenarios drafted
-- from them, which only a human validates. Every table hangs off a container. A task or agent
-- that goes away leaves the QA history in place (SET NULL), a container takes it with it.
-- ADD-only: new tables, no change to existing ones.

CREATE TABLE qa_targets (
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    app_id TEXT,
    app_name TEXT,
    build_path TEXT,
    device_name TEXT,
    notes TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    PRIMARY KEY (container_id, platform),
    CONSTRAINT qa_targets_platform_check CHECK (platform IN ('ios', 'android', 'web'))
);

CREATE TABLE qa_features (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT,
    entry TEXT,
    paths JSONB NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    last_explored_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (container_id, key),
    CONSTRAINT qa_features_source_check CHECK (source IN ('code', 'exploration', 'manual'))
);

CREATE TABLE qa_sessions (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    platform TEXT NOT NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    device_name TEXT,
    device_udid TEXT,
    app_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    budget_minutes INTEGER,
    goal TEXT,
    briefing JSONB,
    charter JSONB,
    result JSONB,
    report_md TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    ended_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    CONSTRAINT qa_sessions_kind_check CHECK (kind IN ('map', 'explore', 'draft', 'check')),
    CONSTRAINT qa_sessions_platform_check CHECK (platform IN ('ios', 'android', 'web')),
    CONSTRAINT qa_sessions_status_check CHECK (status IN ('running', 'done', 'failed', 'cancelled', 'abandoned'))
);
CREATE INDEX qa_sessions_container ON qa_sessions (container_id, started_at);
CREATE INDEX qa_sessions_task ON qa_sessions (task_id);

CREATE TABLE qa_frames (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    screen_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00')
);
CREATE INDEX qa_frames_session ON qa_frames (session_id);

CREATE TABLE qa_map_nodes (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    feature_key TEXT,
    state TEXT NOT NULL DEFAULT 'declared',
    blocked_kind TEXT,
    blocked_reason TEXT,
    sources JSONB NOT NULL DEFAULT '[]',
    evidence JSONB NOT NULL DEFAULT '{}',
    detail JSONB NOT NULL DEFAULT '{}',
    frame_id UUID REFERENCES qa_frames(id) ON DELETE SET NULL,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (container_id, platform, kind, key),
    CONSTRAINT qa_map_nodes_platform_check CHECK (platform IN ('ios', 'android', 'web')),
    CONSTRAINT qa_map_nodes_kind_check CHECK (kind IN ('screen', 'endpoint', 'entity', 'flow')),
    CONSTRAINT qa_map_nodes_state_check CHECK (state IN ('seen', 'declared', 'blocked')),
    CONSTRAINT qa_map_nodes_blocked_kind_check CHECK (blocked_kind IS NULL OR blocked_kind IN
        ('needs_sign_in', 'needs_data', 'needs_permission', 'paywall', 'external', 'crash', 'other'))
);

CREATE TABLE qa_map_edges (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    kind TEXT NOT NULL,
    from_node_id UUID NOT NULL REFERENCES qa_map_nodes(id) ON DELETE CASCADE,
    to_node_id UUID NOT NULL REFERENCES qa_map_nodes(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 0,
    sources JSONB NOT NULL DEFAULT '[]',
    evidence JSONB NOT NULL DEFAULT '{}',
    detail JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (container_id, platform, kind, from_node_id, to_node_id, label),
    CONSTRAINT qa_map_edges_platform_check CHECK (platform IN ('ios', 'android', 'web')),
    CONSTRAINT qa_map_edges_kind_check CHECK (kind IN ('navigates', 'calls', 'reads', 'writes', 'steps'))
);
CREATE INDEX qa_map_edges_to ON qa_map_edges (to_node_id);

CREATE TABLE qa_map_builds (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    counts JSONB NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    ended_at TIMESTAMPTZ,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    CONSTRAINT qa_map_builds_platform_check CHECK (platform IN ('ios', 'android', 'web')),
    CONSTRAINT qa_map_builds_status_check CHECK (status IN ('running', 'done', 'failed'))
);
CREATE INDEX qa_map_builds_container ON qa_map_builds (container_id, platform, started_at);

CREATE TABLE qa_steps (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    args JSONB NOT NULL DEFAULT '{}',
    result TEXT,
    screen_key TEXT,
    screen_hash TEXT,
    frame_id UUID REFERENCES qa_frames(id) ON DELETE SET NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (session_id, seq),
    CONSTRAINT qa_steps_kind_check CHECK (kind IN ('screen', 'tap', 'type', 'swipe', 'press', 'open_url',
        'launch', 'terminate', 'wait', 'note'))
);

CREATE TABLE qa_findings (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    expected TEXT,
    actual TEXT,
    frame_ids JSONB NOT NULL DEFAULT '[]',
    start_seq INTEGER,
    end_seq INTEGER,
    screen_key TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    filed_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT qa_findings_severity_check CHECK (severity IN ('blocker', 'major', 'minor', 'trivial')),
    CONSTRAINT qa_findings_status_check CHECK (status IN ('open', 'filed', 'dismissed'))
);
CREATE INDEX qa_findings_session ON qa_findings (session_id);
CREATE INDEX qa_findings_task ON qa_findings (task_id);

CREATE TABLE qa_flows (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    persona TEXT,
    criticality TEXT NOT NULL DEFAULT 'medium',
    steps JSONB NOT NULL DEFAULT '[]',
    data JSONB NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'plan',
    status TEXT NOT NULL DEFAULT 'queued',
    score INTEGER NOT NULL DEFAULT 0,
    rank_reasons JSONB NOT NULL DEFAULT '[]',
    last_walk_id UUID,
    last_walked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (container_id, platform, key),
    CONSTRAINT qa_flows_platform_check CHECK (platform IN ('ios', 'android', 'web')),
    CONSTRAINT qa_flows_criticality_check CHECK (criticality IN ('high', 'medium', 'low')),
    CONSTRAINT qa_flows_source_check CHECK (source IN ('code', 'plan', 'briefing', 'person')),
    CONSTRAINT qa_flows_status_check CHECK (status IN ('queued', 'walking', 'passed', 'failed', 'unreachable', 'skipped'))
);

CREATE TABLE qa_walks (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    flow_id UUID NOT NULL REFERENCES qa_flows(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'walking',
    blocked_kind TEXT,
    reason TEXT,
    steps JSONB NOT NULL DEFAULT '[]',
    start_seq INTEGER,
    end_seq INTEGER,
    scenario_id UUID,
    finding_ids JSONB NOT NULL DEFAULT '[]',
    started_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    ended_at TIMESTAMPTZ,
    CONSTRAINT qa_walks_status_check CHECK (status IN ('walking', 'passed', 'failed', 'unreachable', 'abandoned'))
);
CREATE INDEX qa_walks_session ON qa_walks (session_id);
CREATE INDEX qa_walks_flow ON qa_walks (flow_id);

CREATE TABLE qa_scenarios (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    persona TEXT,
    description TEXT,
    criteria JSONB NOT NULL DEFAULT '[]',
    checks JSONB NOT NULL DEFAULT '[]',
    data JSONB NOT NULL DEFAULT '{}',
    needs JSONB NOT NULL DEFAULT '[]',
    tags JSONB NOT NULL DEFAULT '[]',
    depends_on JSONB NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'authored',
    status TEXT NOT NULL DEFAULT 'draft',
    status_reason TEXT,
    walk_id UUID REFERENCES qa_walks(id) ON DELETE SET NULL,
    session_id UUID REFERENCES qa_sessions(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    validated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    validated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    UNIQUE (container_id, platform, name),
    CONSTRAINT qa_scenarios_platform_check CHECK (platform IN ('ios', 'android', 'web')),
    CONSTRAINT qa_scenarios_source_check CHECK (source IN ('authored', 'generated', 'walk')),
    CONSTRAINT qa_scenarios_status_check CHECK (status IN ('draft', 'validated', 'paused', 'retired'))
);
CREATE INDEX qa_scenarios_task ON qa_scenarios (task_id);

CREATE TABLE qa_scenario_evidence (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    criterion_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    frame_id UUID REFERENCES qa_frames(id) ON DELETE SET NULL,
    code_ref TEXT,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT qa_scenario_evidence_status_check CHECK (status IN ('verified', 'unconfirmed', 'code_only'))
);
CREATE INDEX qa_scenario_evidence_scenario ON qa_scenario_evidence (scenario_id);

CREATE TABLE qa_scenario_suggestions (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    proposed JSONB NOT NULL DEFAULT '{}',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'proposal',
    session_id UUID REFERENCES qa_sessions(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    decided_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    decided_at TIMESTAMPTZ,
    CONSTRAINT qa_scenario_suggestions_status_check CHECK (status IN ('proposal', 'accepted', 'dismissed'))
);
CREATE INDEX qa_scenario_suggestions_scenario ON qa_scenario_suggestions (scenario_id);

CREATE TABLE qa_verdicts (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
    scenario_id UUID NOT NULL REFERENCES qa_scenarios(id) ON DELETE CASCADE,
    criterion_index INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    note TEXT,
    frame_ids JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT qa_verdicts_verdict_check CHECK (verdict IN ('pass', 'fail', 'blocked', 'inconclusive'))
);
CREATE INDEX qa_verdicts_session ON qa_verdicts (session_id);
CREATE INDEX qa_verdicts_scenario ON qa_verdicts (scenario_id);

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('023_qa.sql'), ('093_qa.sql');
