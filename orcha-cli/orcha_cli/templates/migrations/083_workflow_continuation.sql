-- GH #380: distinguish an automatic continuation from an agent-recorded wait.
ALTER TABLE agent_self_wake ADD COLUMN auto_continue_run_id UUID REFERENCES worker_runs(run_id) ON DELETE CASCADE;
