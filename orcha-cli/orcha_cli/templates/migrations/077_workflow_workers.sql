-- Workflow worker capabilities and durable stop delivery. Requires 075_workflows.sql.
-- Provision runner credentials through trusted installation tooling, never a body actor ID.
CREATE TABLE workflow_runner_credentials (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    runner_instance TEXT NOT NULL,
    token_sha256 TEXT NOT NULL UNIQUE,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_launch_permits (
    run_id UUID PRIMARY KEY NOT NULL REFERENCES worker_runs(run_id) ON DELETE CASCADE,
    execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CONSTRAINT workflow_launch_permits_generation_check CHECK (generation > 0),
    runner_credential_id UUID NOT NULL REFERENCES workflow_runner_credentials(id),
    operation_key TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    permit_sha256 TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    process_key TEXT,
    pid INTEGER,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (runner_credential_id, operation_key),
    UNIQUE (execution_id, generation)
);

CREATE TABLE workflow_stop_intents (
    id UUID PRIMARY KEY NOT NULL,
    execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    origin TEXT NOT NULL CONSTRAINT workflow_stop_intents_origin_check CHECK (origin IN ('task_stop','rejection','task_cancel','workflow_cancel','recovery_reissue')),
    requested_by UUID NOT NULL REFERENCES agents(id),
    reason TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivery_state TEXT NOT NULL DEFAULT 'sent' CONSTRAINT workflow_stop_intents_delivery_state_check CHECK (delivery_state IN ('sent','delivery_failed','acknowledged')),
    delivered_at TIMESTAMPTZ,
    satisfied_at TIMESTAMPTZ,
    operation_key TEXT NOT NULL,
    UNIQUE (execution_id, operation_key)
);
CREATE INDEX idx_workflow_stops_pending ON workflow_stop_intents(execution_id, satisfied_at);
