"""Only validated message/event identities are copied into private dispatch state."""

from portal_backend import sql
from portal_backend.guards import valid_uuid


def message_references(cur, aid, event_ids):
    if not event_ids:
        return []
    cur.execute(f'SELECT id,payload FROM agent_events WHERE event_key=%s '
                f"AND event_name='task_message' AND {sql.in_list('id')}",
                (aid, sql.list_param(event_ids)))
    refs = []
    for event in cur.fetchall():
        payload = event['payload'] or {}
        mid, tid = payload.get('message_id'), payload.get('task_id')
        if not valid_uuid(mid) or not valid_uuid(tid):
            continue
        cur.execute('SELECT id FROM task_messages WHERE id=%s AND task_id=%s', (mid, tid))
        if cur.fetchone():
            refs.append({'task_id': str(tid), 'message_id': str(mid), 'event_id': event['id']})
    return refs
