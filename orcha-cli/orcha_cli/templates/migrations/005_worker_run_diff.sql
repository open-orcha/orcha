-- ISS-8: capture each code-touching worker's NET git diff (vs origin/main) on its run row,
-- so the portal (B1.3) can render a full-fidelity diff — including Bash/sed/formatter edits
-- the stream-json Edit/Write parse misses. Applied on portal boot by the R1 runner (no wipe).
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS diff TEXT;
