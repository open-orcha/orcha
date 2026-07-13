-- GH #51: per-agent reasoning effort (low|medium|high|xhigh), carried through to the worker
-- spawn (`claude --effort <level>`, or Codex `model_reasoning_effort`). NULL = use the server
-- default (medium) at spawn; humans stay NULL. Like agents.model, it's a free-text column —
-- the curated AVAILABLE_REASONING_EFFORTS list in the portal is the source of truth, and an
-- unknown/stale value resolves to the default rather than reaching the argv.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;
