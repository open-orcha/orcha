"""Save workflow work and let its existing scheduler admit the replacement.

Activation gives the token only to the bootstrap. Commands stop before this
handoff; continuation uses the confirmed-exit schedule and durable launch count,
never the ordinary notifier's token-minting or immediate respawn path.
"""

import json

from . import notifier_managed_jobs, notifier_workflow


def checkpoint_and_continue(api_base, aid, worker, live_workers, quiet, services):
    if not (worker.get('respawn_ctx') or {}).get('task_id') or worker.get('sandbox_container_id'):
        worker['workflow_checkpoint_unsupported'] = True
        worker['respawns'] = services.HARD_CAP_RESPAWN_MAX
        return  # Remote workflow launch is not supported by spawn_headless.
    stopped = notifier_managed_jobs.prepare(
        api_base, worker, services, reason='checkpoint_transfer', stop=True)
    services._kill_worker(worker['proc'], graceful=True)
    worker['respawns'] = services.HARD_CAP_RESPAWN_MAX
    if not stopped or worker['proc'].poll() is None:
        return
    diff = services._capture_diff(worker.get('worktree') or worker.get('base_cwd'))
    if not services._finish_run(
            api_base, worker['run_id'], 'killed', worker['proc'].returncode,
            worker.get('log_path'), diff,
            kill_reason=json.dumps({'cause': 'managed_checkpoint'})):
        return
    worker['workflow_checkpoint_finished'] = True
    # Confirmation schedules eligible work through the same holds, approval,
    # pending-request and durable attempt limits as other automatic continuation.
    # The ordinary completion path saves the worktree and retires this worker;
    # the later wake calls continue-reserve and launches the inert bootstrap.
    notifier_workflow.confirm_exit(api_base, aid, worker)
