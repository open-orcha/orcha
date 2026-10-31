"""Private snapshots for mechanical recovery; never copy raw logs or argv."""

import stat

from .job_store import JobStorageError, read_json


def committed_adoption(record, job):
    """The server's same-launch owner/count receipt after a lost adoption reply."""
    return (bool(record.get('launch_owner_run_id'))
            and job['transfers_used'] > record.get('transfers_used', 0)
            and job['continuation_contract'] == record.get('continuation'))


def verified_result(directory, record, result):
    if (any(result.get(k) != record.get(k) for k in ('job_id', 'launch_nonce'))
            or result.get('owner_run_id') != record.get('launch_owner_run_id', record['owner_run_id'])
            or not result.get('termination_verified')
            or result.get('status') not in {'completed', 'interrupted', 'exhausted'}):
        return False
    if result.get('termination_source') == 'container_exit':
        from .job_sandbox import verified_container_result
        return verified_container_result(directory, record, result)
    code = result.get('exit_code')
    return type(code) is int and result.get('signal') == (-code if code < 0 else None)


def daemon_stop_reason(directory, identity):
    path = directory / 'daemon-stop.json'
    if not path.exists():
        return None
    request = read_json(path)
    if (request.get('launch_nonce') == identity.get('launch_nonce')
            and request.get('owner_run_id') == identity.get('controller_run_id', identity.get('owner_run_id'))):
        return request.get('reason') or 'daemon_stop_requested'
    return None


def daemon_stop_requested(directory, identity):
    return daemon_stop_reason(directory, identity) is not None


def context_snapshot(directory):
    value = {'completed_steps': [], 'remaining_steps': [], 'received_position': None,
             'handled_position': None, 'pending_messages': [], 'guidance_incomplete': True}
    try:
        context = read_json(directory / 'context.json')
        value.update({k: context.get(k, []) for k in ('completed_steps', 'remaining_steps')})
        guidance = read_json(directory / 'guidance.json')
        value.update({k: guidance.get(k) for k in
                      ('received_position', 'handled_position', 'pending_messages')})
        value['guidance_incomplete'] = guidance.get('has_more', True)
    except JobStorageError:
        # Forward task-thread recovery is mandatory after any incomplete snapshot.
        pass
    try:
        from .job_dispatch import references
        record = read_json(directory / 'record.json')
        value['dispatch_message_refs'] = references(directory, record['task_id'])
        value['ports'] = record.get('ports', [])
        value['artifacts'] = record.get('artifacts', [])
    except (JobStorageError, KeyError, ValueError, TypeError):
        value['dispatch_message_refs'] = []
    # Dispatch references are delivery hints, never evidence of handling.
    if value['dispatch_message_refs']:
        value['guidance_incomplete'] = True
    value['output_progress'] = {}
    for stream in ('stdout', 'stderr'):
        try:
            metadata = (directory / f'{stream}.log').lstat()
            if stat.S_ISREG(metadata.st_mode):
                value['output_progress'][stream] = {
                    'bytes': metadata.st_size, 'modified_at': metadata.st_mtime,
                }
        except OSError:
            pass
    return value
