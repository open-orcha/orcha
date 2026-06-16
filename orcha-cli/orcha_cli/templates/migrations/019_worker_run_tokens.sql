-- #289 (EFFICIENCY epic, measurement backbone): persist per-wake TOKEN usage on a worker run.
-- The headless/resident worker is spawned with `--output-format stream-json`, whose terminal
-- `result` event carries a `usage` object (input_tokens, output_tokens, cache_creation_input_tokens,
-- cache_read_input_tokens) plus `total_cost_usd`. The notifier parsed that event for reply text
-- (notifier._result_after) but DROPPED the usage — so nothing ever measured what a wake actually
-- spent. These columns close that gap: the daemon reads usage from the per-wake log on /finish and
-- records it here, and GET /api/containers/{cid}/token-usage aggregates them into a tokens-vs-quota
-- meter. The critical accounting point: cache-READS count against the plan quota even though they
-- are cheap in dollars (that is what hid the burn), so the meter sums all four token kinds, not $.
-- ADD-only + nullable: every pre-#289 / clean-exit / kill row keeps NULL (zero behaviour change).
-- BIGINT because a single cache-heavy wake can read millions of cached tokens. Applied on portal
-- boot by the R1 runner (no wipe).
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS input_tokens                 BIGINT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS output_tokens                BIGINT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS cache_read_input_tokens      BIGINT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS cache_creation_input_tokens  BIGINT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS total_cost_usd               NUMERIC(14,6);
