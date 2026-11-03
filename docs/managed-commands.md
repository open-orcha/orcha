# Managed commands and worker handoff

One-shot Claude and Codex work-lane workers can use `orcha job` to keep command output and task guidance across worker changes. Resident sessions and live-terminal sessions do not support managed continuation. Existing task approval, hold, cancellation and verification rules still apply.

Start a foreground command with a stable operation name, replacing `<task-id>` with the task identity from startup context:

```sh
orcha job --task <task-id> status
orcha job --task <task-id> start --key unit-tests --purpose "Run unit tests" -- python -m pytest
orcha job --task <task-id> wait <job-id> --seconds 100
```

Keep the same key when retrying or reconciling the same operation. A completed record cannot be relaunched. Never use a new key to bypass a live, uncertain, interrupted or exhausted command. Never reconstruct executable arguments from saved command descriptions: argument values are deliberately omitted.

If the first authority check fails or refuses mutations before any launch attempt, status is `not_started`. Retry `start` with the same key and original command: it reuses the reservation, directory, isolation contract and absolute budget. This exception requires an explicit saved pre-launch failure and an available controller lock; missing process files alone never authorize another launch. Any uncertain checkpoint or process launch remains fenced for reconciliation.

### Correcting an already-authorized read-only check

A wrong executable or input path can produce a **completed failure**, even when the intended check never ran: a wrapper or script may have launched successfully. This is different from `not_started`. Preserve the failed reservation, terminal record and result; do not reopen them or change their identity.

For a distinct corrective operation within the approved scope:

1. Inspect the original private record and result. Verify completed failure and termination, handle the exact outcome revision, and establish that the intended check did not run and no relevant side effects occurred. A nonzero exit alone does not establish this.
2. Verify the corrected executable, input paths and setup before starting. Save the original job reference, the reason for correction and a stable corrective key in private progress. Use that key with the ordinary supervised `start` command.
3. On restart or repeated delivery, inspect and reuse the corrective key. Apply the verified result once and use `result-handled` for its exact revision. A duplicate notification does not create another correction.

For example, a read-only version check that failed because its executable path did not exist may get a separately recorded check using the verified executable. The earlier failure remains visible. No renewed human permission is needed solely for this correction within already-approved work.

This is a guidance distinction, not an automatic retry policy or a new server exemption. It does not authorize replay of successful or destructive work, budget resets, evasion of a live/uncertain/interrupted/exhausted operation, a stop, hold or lost authority, or overriding an explicit human restriction. Reconcile uncertain evidence; if an actual policy conflict remains, request the precise missing decision.

When task autonomy is off, read the current approval records and task thread before asking for a plan approval. An existing valid human approval covers continued work within that scope, including routine reversible corrections and worker restarts. Changed scope, withdrawn approval and explicit restrictions still require the relevant decision. The initial plan gate and final human verification remain in place.

Declare relevant local ports and output paths with repeatable `start --port 8080 --artifact reports/result.json` options. Artifact paths are relative to the command directory. These declarations stay in the private record and handoff; they do not expose a port or upload a file. Mechanical checkpoints also record output file sizes and modification times without copying log contents.

The wait command returns for new guidance, completion, a preparation deadline or lost authority. It polls without model calls and targets delivery within 15 seconds while the local service is healthy. The worker applies or explains guidance before calling `handled <message-id> --outcome applied` or `--outcome not_applicable --note ...`. Receiving a message does not mark it handled. Reconnecting workers recover unhandled messages from the task thread even when wake notifications were cleared.

The first dispatch saves a task-and-agent message boundary, including pending instructions that triggered the worker. Its claim time is retained separately from notification acknowledgements and copied into taskless runs, so later task attribution still includes instructions received during startup. Accepting a task before worker registration also saves that task's boundary in the same transaction; recovery does not require repeating a successful acceptance, even if the first worker never registers. Earlier discussion remains startup context; the worker's own posts are excluded from new guidance. Replacement never advances this boundary, so a crash before the first poll cannot hide messages received during startup or leave gaps behind later handled messages.

For Claude, set the enclosing Bash timeout to at least 120000 milliseconds. For Codex, use `exec_command` with `yield_time_ms=1000`; if it returns a `session_id`, poll that same session with `write_stdin` and `yield_time_ms=50000`. An interrupted wait does not stop or relaunch the command. Keep the CLI wait within the enclosing tool's supported timeout or yield contract.

The independent supervisor saves mechanical progress before stopping and enforces a finite authority deadline even if the notifier pauses or crashes. A scheduling lease renewal gap alone does not kill an otherwise authorized command, but new mutations are refused until the exact worker lease is restored. Human stop, hold, cancellation and unexpected ownership loss stop managed commands. Commands must remain in their process group; ordinary supervision does not confine hostile programs that deliberately escape it.

A restarted notifier can use the last saved finite confirmation only while the original controller identity still matches. A temporary adoption refusal because the replacement is not yet registered leaves the source command under its existing deadline; retry `adopt` after registration. A refusal before any ambiguous attempt permits a new adoption attempt. Once any reply is lost, the controller keeps reconciling that exact operation even if a later retry is refused; a later refusal cannot prove the first attempt did not commit. Reconciliation never extends the last confirmed authority deadline.

On macOS, `start --isolate` enforces a narrow single-process contract using Seatbelt: file reads are allowed, writes are confined to a private `ORCHA_JOB_SCRATCH`, and shared writes, network/IPC, subprocess creation, signals and hard links are denied. An eligible isolated command can survive an ordinary host worker's planned replacement under its retained original supervisor. `adopt <job-id>` requires confirmed exit of the old worker and verified original launch evidence. No executable command is recreated during adoption. The default budget is three transfers and two hours from initial reservation; replacement never resets either limit. Unsupported isolation fails explicitly.

Workflow checkpointing keeps a still-running host command as well: the step's worker is checkpointed and exits, the command continues under its original supervisor, and the step's automatic continuation waits for that command's completion wake instead of starting another worker beside it. A command that already finished is handled as before. Workflow approval and generation gates remain in force; remote workflow spawning remains unsupported.

Sandbox commands use the path-identical workspace mount for durable files. They do not survive container shutdown. Recovery checks the recorded container ID prefix, original start interval and writable workspace mount against Docker inspection. An inspected exit can establish command termination while the command's own exit code remains unknown; a container exit code is never substituted for it. Reused names, restarts, missing containers and unavailable inspection remain uncertain and retain the launch/worktree fence. A verified command result already written by the guard is preserved unchanged.

After the old worker ends, `recover <job-id>` imports a verified saved result without launching or taking control of a process. If the original supervisor is still finishing, retry later. Missing evidence requires reconciliation; a saved identifier alone never authorizes signaling an unrelated process.

## Save progress and resume on command completion

Every new reservation registers a durable monitor in the same transaction. The original supervisor publishes results promptly; the existing notifier also walks the server registry after restart and on bounded five-second passes. Registration is independent of the worker's lifetime and local directory discovery. A missing record produces one actionable uncertainty, preserves the launch fence, and remains monitored for stronger evidence.

Every command a host worker starts keeps running after that worker exits, whatever ended the worker (a clean finish, the 20-minute hard cap, a failure or a watchdog). No flag is needed; `--continue-after-exit` is still accepted and changes nothing. The task is woken when the command finishes, with its saved result and logs available. A worker can also yield explicitly while it waits:

```sh
orcha job --task <task-id> start --key unit-tests --purpose "Run the unit tests" -- pytest -q
orcha job --task <task-id> yield <job-id> --context-file <private-progress.json>
```

The progress file contains `completed_steps` and `remaining_steps`, each a list of short descriptions. A successful yield saves the file and registers the task's wait before the model worker exits. The original supervisor retains control; the next worker does not adopt or relaunch it merely to inspect progress.

**The one automatic restriction is changing the project.** After its worker exits, the supervisor checks the checkout's Git-tracked files every few seconds. If a file that was tracked when the check started now has different content, or is gone, and neither a worker nor another managed command has been on that checkout since the last check, the server records `project_files_changed` and the command is stopped; the task is still woken with the result so the agent can read why. A checkout-wide change does not say which command made it, so while two commands share a checkout neither is stopped for the other's edits; another command stops counting only once its finish has been verified (an unknown or unverified outcome, or a passed budget, still counts). Content is compared the way Git stores it (after line-ending conversion and clean filters), so staging or committing unchanged content is not a change, and new files stay out of it even once they are staged. These never count: untracked or ignored files, the command's declared `--artifact` paths, Orcha's own job records, and log, cache, temp, dependency and build/test output folders (for example `logs/`, `tmp/`, `node_modules/`, `dist/`, `build/`, `coverage/`, `__pycache__/`, `*.log`), even when tracked. A human editing tracked files in that checkout while no worker is on it looks the same as the command doing it, and also stops the command. If Git cannot be read, or its index keeps changing while being read, the command keeps running. Git checks run beside supervision, so a slow check never delays a stop, and a stop ends any check in progress.

The command's own budget (`--max-seconds`, two hours by default, counted from the reservation) is its only time limit; the worker's 20-minute cap does not apply to it. A replacement worker, successful heartbeat or lifted hold never extends that budget. The human's original run-stop control still stops continuing commands after the model run ends. The current assigned worker can use `stop <job-id>` without taking ownership. Pause, holds, reassignment, task changes and cancellation stop continuing commands. Explicit stop suppresses automatic resumption for that command's result, while leaving it available for authorized inspection. Container sandbox commands do not continue; they end with their container.

Completion uses the ordinary scheduler and repeats exact task admission checks at the wake claim. Workflow completion remains an automatic continuation and consumes the existing workflow allowance. A running worker sees outcomes through `status` or `wait`; another worker is not launched beside it. Wait registrations suppress idle-only wakes and source-run recovery, while new guidance and answers remain actionable. Each job has its own wait, so one completed command does not erase another command's wait.

`status` reports pending outcome revisions. Check the original private result, including its exit code, and explicitly record how it was used:

```sh
orcha job --task <task-id> result-handled <job-id> --revision <revision> --disposition applied --note "Used the verified result."
```

Handling a result does not release the original checkout while saved `remaining_steps` still depend on it, such as ignored build artifacts. When the saved remaining work no longer needs that checkout, add `--release-checkout`; the release is bound to the exact saved progress file, so later saved steps retain the checkout again. Repeating the same handling command replays its receipt.

For missing or unverifiable evidence, use `--disposition uncertainty_resolved` with a concise explanation. This handles the warning without proving termination or releasing the launch fence. Later verified evidence has a new revision. Reading, receiving a notification, or cleanly exiting the worker never handles an outcome. Lost replies replay the same durable receipt; conflicting handling is refused. Arbitrary downstream effects still require their own stable operation and reconciliation.

Completion-only admission is limited to three attempts per outcome, with increasing delay. Blocked outcomes and exhausted results remain saved for review. Healthy-host latency includes the monitor pass (target five seconds), scheduler interval (default two seconds), remaining idle/cooldown gates (default thirty/fifteen seconds), and any retry delay. Workflow continuation also retains its 120-second not-before gate. A blocked task has no finite resume promise. The active wait command's fifteen-second guidance target is separate from completion-wake latency.

The monitor API accepts evidence on the existing machine trust boundary even after worker-token revocation, pause or execution expiry. It cannot launch, adopt, assign or complete work. Continuing execution requires a separate job-scoped capability held only in private storage and the original supervisor. Neither that capability nor command output enters scheduler payloads. Required private context and checkouts remain protected until handling, in addition to the existing positive-termination checks.

Records and logs live under the durable workspace's private `.claude/.orcha-jobs/` directory, outside disposable worktrees and excluded from Git, diffs and task attachments. Startup context contains private pointers, not command output or credentials. Do not copy these files into `.orcha/outputs/`. Commands receive a restricted environment without worker/provider tokens, but output may still contain sensitive data read by the command. The isolation contract protects integrity, not confidentiality. Moving recovery to another host requires access to the original durable evidence.

The API's generated OpenAPI schema is the contract for reservation, polling, handled receipts, deadlines, checkpoints, result reconciliation and transfer. Local runner-supplied evidence uses the existing machine trust boundary; the server does not independently probe the operating system.

## Acceptance checks

Follow `docs/orcha-test-runbook.md` for the isolated SQLite and PostgreSQL suites. The `tests/test_gh312_*.py` modules cover message recovery, authority, command supervision, transfer, cleanup and workflow continuation.
The `tests/test_gh388_*.py` modules exercise completion registration, late publication, exact handling, explicit continuation, waiting, notifier recovery and task/workflow admission.

To exercise actual installed, locally authenticated Claude and Codex programs, run `ORCHA_TEST_LIVE_RUNTIMES=1 pytest tests/integration/test_gh312_live_runtimes.py` in the test environment. This opt-in test uses model calls and covers ordinary and workflow startup against a disposable service. Keep its raw logs private.

The Docker acceptance modules `tests/integration/test_gh312_sandbox_cli.py` and `tests/integration/test_gh312_sandbox_lifecycle.py` require a running Docker engine and an already-installed Orcha runner image. They exercise the shipped CLI, API, Linux guard, durable mounts and shutdown, with deterministic tool selection; they do not execute Claude or Codex inside the container. They neither start Docker nor pull an image.
