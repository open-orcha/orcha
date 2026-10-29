"""Private snapshots for mechanical recovery; never copy raw logs or argv."""

from .job_store import JobStorageError, read_json


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
    return value
