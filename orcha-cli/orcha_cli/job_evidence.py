"""Private snapshots for mechanical recovery; never copy raw logs or argv."""

from .job_store import JobStorageError, read_json


def daemon_stop_requested(directory, identity):
    path = directory / 'daemon-stop.json'
    if not path.exists():
        return False
    request = read_json(path)
    return all(request.get(k) == identity.get(k) for k in ('owner_run_id', 'launch_nonce'))


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
    except (JobStorageError, KeyError, ValueError, TypeError):
        value['dispatch_message_refs'] = []
    # Dispatch references are delivery hints, never evidence of handling.
    if value['dispatch_message_refs']:
        value['guidance_incomplete'] = True
    return value
