"""Define notifier timing policy and process-scoped resident fallback state.

The notifier facade re-exports these names for compatibility. Keeping the policy
in one small module makes the worker and resident lifecycle limits reviewable
without mixing them into transport or orchestration code.
"""

# A progressing worker may legitimately run for many minutes. The stall detector
# remains the primary intervention; this floor only catches true runaways.
HARD_CAP_MIN_SECS = 1200.0

# Progressing workers checkpoint and respawn at the hard cap. This bound preserves
# a final runaway backstop if repeated clean-context restarts do not finish the task.
HARD_CAP_RESPAWN_MAX = 3

# The daemon renews this short single-flight lease every tick. A crashed worker
# therefore stops blocking fresh high-priority work well before the hard cap.
WAKE_LEASE_TTL_SECS = 180.0

# Durable task worktrees are reclaimed only after these terminal task states.
TERMINAL_TASK_STATES = ("completed", "cancelled")

# Terminal task history is append-only, so cleanup is paginated with a generous
# runaway ceiling rather than assuming one bounded response.
TERMINAL_SWEEP_MAX_PAGES = 200
TERMINAL_SWEEP_PAGE_SIZE = 100

# A completed worker may linger briefly while its SessionEnd digest is written.
GRACEFUL_EXIT_SECS = 180.0

# Warm conversations stay resident across ordinary human pauses. A failed warm
# resume inside the smaller window is treated as an invalid session and retried cold.
RESIDENT_IDLE_REAP_SECS = 1200.0
RESUME_FAIL_WINDOW_SECS = 20.0

# Repeated drain yields at the same inbox watermark are throttled to prevent a
# resident teardown/restart loop around an event that cannot be acknowledged.
RESIDENT_DRAIN_COOLDOWN_SECS = 60.0

# Independent work and conversation lanes supersede resident-side work teardown.
# The switch remains explicit so the legacy fallback can be restored if needed.
RESIDENT_WORK_TEARDOWN_ENABLED = False

# Process-scoped fallback state survives resident replacement within one daemon.
RESIDENT_DRAIN_YIELD: dict = {}
RESIDENT_RESUME_FAILED: set = set()
CODEX_RESUME_FAILED: set = set()
