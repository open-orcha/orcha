-- 919050a5: persist the HOST process id of each worker on its run row. The notifier/residents run
-- on the host; the API runs in Docker and CANNOT see host PIDs (which is why ISS-60-B keys on a
-- heartbeat, not a PID). Storing the pid lets the notifier — the only process that can evaluate
-- os.kill(pid, 0) — detect a run whose row says 'running' but whose backing process is dead, then
-- reap it + release the held resident wake-lease IMMEDIATELY (seconds, not the >1260s heartbeat
-- window). This is the cross-daemon single-flight truth: the shared DB row + a host liveness check.
-- ADD-only and nullable: pre-existing rows and non-pid spawns keep NULL (treated as "unknown/dead").
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS pid INTEGER;
