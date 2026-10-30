# Managed commands and worker handoff

One-shot Claude and Codex work-lane workers can use `orcha job` to keep command output and task guidance across worker changes. Resident sessions and live-terminal sessions do not support managed continuation. Existing task approval, hold, cancellation and verification rules still apply.

Start a foreground command with a stable operation name, replacing `<task-id>` with the task identity from startup context:

```sh
orcha job --task <task-id> status
orcha job --task <task-id> start --key unit-tests --purpose "Run unit tests" -- python -m pytest
orcha job --task <task-id> wait <job-id> --seconds 100
```

Keep the same key when retrying. An existing reservation, uncertain launch, interrupted command or exhausted budget must be inspected before choosing a new operation. Never reconstruct executable arguments from saved command descriptions: argument values are deliberately omitted.

Declare relevant local ports and output paths with repeatable `start --port 8080 --artifact reports/result.json` options. Artifact paths are relative to the command directory. These declarations stay in the private record and handoff; they do not expose a port or upload a file. Mechanical checkpoints also record output file sizes and modification times without copying log contents.

The wait command returns for new guidance, completion, a preparation deadline or lost authority. It polls without model calls and targets delivery within 15 seconds while the local service is healthy. The worker applies or explains guidance before calling `handled <message-id> --outcome applied` or `--outcome not_applicable --note ...`. Receiving a message does not mark it handled. Reconnecting workers recover unhandled messages from the task thread even when wake notifications were cleared.

For Claude, set the enclosing Bash timeout to at least 120000 milliseconds. For Codex, use `exec_command` with `yield_time_ms=1000`; if it returns a `session_id`, poll that same session with `write_stdin` and `yield_time_ms=50000`. An interrupted wait does not stop or relaunch the command. Keep the CLI wait within the enclosing tool's supported timeout or yield contract.

The independent supervisor saves mechanical progress before stopping and enforces a finite authority deadline even if the notifier pauses or crashes. A scheduling lease renewal gap alone does not kill an otherwise authorized command, but new mutations are refused until the exact worker lease is restored. Human stop, hold, cancellation and unexpected ownership loss stop managed commands. Commands must remain in their process group; ordinary supervision does not confine hostile programs that deliberately escape it.

Generic commands stop before worker replacement. On macOS, `start --isolate` enforces a narrow single-process contract using Seatbelt: file reads are allowed, writes are confined to a private `ORCHA_JOB_SCRATCH`, and shared writes, network/IPC, subprocess creation, signals and hard links are denied. An eligible isolated command can survive an ordinary host worker's planned replacement under its retained original supervisor. `adopt <job-id>` requires confirmed exit of the old worker and verified original launch evidence. No executable command is recreated during adoption. The default budget is three transfers and two hours from initial reservation; replacement never resets either limit. Unsupported isolation fails explicitly.

Workflow checkpointing stops commands and uses the existing confirmed-stop and scheduled continuation path. Its approval and generation gates remain in force. Automated workflow handoff currently does not preserve a live command; remote workflow spawning remains unsupported.

Sandbox commands use the path-identical workspace mount for durable files. They do not survive container shutdown. Recovery checks the recorded container ID prefix, original start interval and writable workspace mount against Docker inspection. An inspected exit can establish command termination while the command's own exit code remains unknown; a container exit code is never substituted for it. Reused names, restarts, missing containers and unavailable inspection remain uncertain and retain the launch/worktree fence. A verified command result already written by the guard is preserved unchanged.

After the old worker ends, `recover <job-id>` imports a verified saved result without launching or taking control of a process. If the original supervisor is still finishing, retry later. Missing evidence requires reconciliation; a saved identifier alone never authorizes signaling an unrelated process.

Records and logs live under the durable workspace's private `.claude/.orcha-jobs/` directory, outside disposable worktrees and excluded from Git, diffs and task attachments. Startup context contains private pointers, not command output or credentials. Do not copy these files into `.orcha/outputs/`. Commands receive a restricted environment without worker/provider tokens, but output may still contain sensitive data read by the command. The isolation contract protects integrity, not confidentiality. Moving recovery to another host requires access to the original durable evidence.

The API's generated OpenAPI schema is the contract for reservation, polling, handled receipts, deadlines, checkpoints, result reconciliation and transfer. Local runner-supplied evidence uses the existing machine trust boundary; the server does not independently probe the operating system.
