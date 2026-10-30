"""One-shot startup guidance with pointers only, never command/log contents."""

import json
from uuid import UUID

from .job_store import JobStore, JobStorageError, jobs_root


def startup_guidance(base_cwd, task_id):
    if not base_cwd or not task_id:
        return ''
    try:
        task_id = str(UUID(task_id))
    except (ValueError, TypeError, AttributeError):
        return ''
    command = f'orcha job --task {task_id}'
    pointers = []
    dispatch_pointer = None
    unavailable = False
    try:
        if jobs_root(base_cwd).exists():
            store = JobStore(base_cwd)
            dispatch = store.root / '.dispatch' / f'{task_id}.json'
            if dispatch.is_file():
                dispatch_pointer = str(dispatch)
            with store.locked():
                for job_id, record in store.entries():
                    if record is None:
                        unavailable = True
                        continue
                    if record.get('task_id') == task_id:
                        if str(UUID(record['job_id'])) != job_id:
                            raise JobStorageError('Managed command identity changed')
                        pointers.append({'job_id': job_id, 'record': str(store.root / job_id / 'record.json')})
    except (OSError, JobStorageError, KeyError, ValueError, TypeError):
        unavailable = True
    return (
        '\n\n## Long commands and saved work\n'
        f'Before launching a long test/build/foreground command, run `{command} status` to inspect '
        'existing reservations and saved results. Reuse the stable operation key on every retry; '
        'never choose a new key to bypass an uncertain, interrupted or exhausted command. '
        'Check its private record and result before continuing; report an uncertain outcome '
        'and reconcile it before deciding whether a new command is necessary. '
        f'After an earlier worker ends, use `{command} recover <job-id>` to publish its verified '
        'saved result. Recovery never launches or takes control of a process; if the original '
        'supervisor is still finishing, retry recovery later. Missing or uncertain results remain fenced.\n'
        f'Start with `{command} start --key <stable-operation-name> --purpose <brief-safe-description> '
        '-- <executable> <arguments>`. Commands must stay in the foreground and keep descendants '
        'in their process group. The child receives a restricted environment without Orcha/provider tokens. '
        'Declare relevant local ports and relative output paths with repeatable --port and --artifact options; '
        'these remain private recovery metadata and never upload files. '
        'This is supervision, not a security sandbox. Generic commands stop before worker transfer.\n'
        'For a single-process read-only check on macOS, --isolate enforces no shared writes, '
        'network/IPC or subprocesses, with private output in ORCHA_JOB_SCRATCH. Only that contract '
        'can survive a planned handoff under its retained original supervisor. '
        f'Use `{command} adopt <job-id>` for a prepared surviving command; successful adoption '
        'requires positive old-worker exit and consumes its durable handoff limit. If the command '
        'has finished, use recover instead. A failed adoption never authorizes a new launch.\n'
        f'While it runs, use `{command} wait <job-id> --seconds 100`. Claude: set the enclosing '
        'Bash timeout to at least 120000 milliseconds. Codex: use exec_command with yield_time_ms=1000; '
        'if it returns a session_id, poll that same session with write_stdin (yield_time_ms=50000). '
        'Do not start another wait while the first shell session is still active. Interrupted waits '
        'do not stop or relaunch the command. The CLI polls without model calls and returns guidance '
        'within a 15-second target when the local service is healthy. Do not post routine waiting messages.\n'
        'On every return, reread the full task scope/definition of done and inbox; respect owner/member '
        'precedence, holds, stops and approval gates. Apply or explain guidance before recording '
        f'`{command} handled <message-id> --outcome applied` (or `not_applicable --note <reason>`). '
        'Delivery is not handling. Use the message operation key for idempotent managed effects; '
        'an uncertain external effect must be reconciled, never blindly repeated.\n'
        f'At a preparation deadline, save completed_steps and remaining_steps using `{command} checkpoint '
        '<job-id> --context-file <private-json-path>`. Keep private records, logs, credentials and raw '
        'commands out of task posts, deliverables and Git. The supervisor saves mechanical evidence even '
        'if no reasoning checkpoint is supplied. Startup binding/limit publication can briefly be pending; '
        'retry the same operation after the service confirms this run. Never fall back to an unsupervised '
        'duplicate. Resident/live-terminal sessions do not support this continuation contract.\n'
        'Private recovery pointers (list may be truncated; status lists all task reservations): '
        + json.dumps(pointers[:20])
        + ('\nPrivate dispatch reference journal (replay the thread; these are not handled receipts): '
           + json.dumps(dispatch_pointer) if dispatch_pointer else '')
        + ('\nSome local evidence could not be read; preserve its launch fence and working directory.'
           if unavailable else '')
    )
