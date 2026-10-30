"""Keep task-message references before delivery acknowledgements can hide events."""

from uuid import UUID

from .job_store import JobStore, JobStorageError, _private_directory, atomic_json, read_json


def capture(candidate):
    refs = candidate.get('task_message_refs')
    if not refs:
        return True  # Old servers still require authoritative thread recovery.
    base = candidate.get('headless_cwd')
    if not base:
        return False
    try:
        store = JobStore(base)
        with store.locked():
            directory = store.root / '.dispatch'
            _private_directory(directory)
            grouped = {}
            for ref in refs:
                tid, mid = (str(UUID(ref[k])) for k in ('task_id', 'message_id'))
                eid = ref['event_id']
                if type(eid) is not int or not 0 < eid <= 9223372036854775807:
                    raise ValueError('Invalid message event reference')
                grouped.setdefault(tid, []).append({'message_id': mid, 'event_id': eid})
            for tid, messages in grouped.items():
                path = directory / f'{tid}.json'
                existing = read_json(path) if path.exists() else {'task_id': tid, 'pending_messages': []}
                pending = {(r['message_id'], r['event_id']): r for r in existing['pending_messages']}
                pending.update({(r['message_id'], r['event_id']): r for r in messages})
                # A bounded pointer journal is a recovery hint, not a handled
                # cursor. Overflow and missing mappings require thread replay.
                atomic_json(path, {'task_id': tid, 'pending_messages': list(pending.values())[-1000:],
                                   'guidance_incomplete': True})
        return True
    except (OSError, JobStorageError, ValueError, KeyError, TypeError):
        return False


def references(directory, task_id):
    path = directory.parent / '.dispatch' / f'{UUID(task_id)}.json'
    if not path.exists():
        return []
    return read_json(path)['pending_messages']
