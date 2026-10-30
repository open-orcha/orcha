"""Immutable positive exit receipts, separate from administrative terminalization.

Only runner observation paths call this helper, under their lifecycle locks and
in the same transaction as terminalization. Existing local runner trust applies:
these are supplied observations, not an independent server-side process probe.
"""

from portal_backend import sql
from portal_backend.managed_run_auth import conflict


def record_stop(cur, run_id, *, source, execution_id=None, generation=None,
                process_id=None, exit_code=None, now=None):
    now = now or sql.utcnow()
    cur.execute('SELECT * FROM worker_stop_observations WHERE run_id=%s', (run_id,))
    existing = cur.fetchone()
    if existing:
        expected = dict(source=source, execution_id=execution_id, generation=generation,
                        process_id=process_id, exit_code=exit_code)
        if any(str(existing[k]) != str(v) for k, v in expected.items()):
            conflict('worker_stop_observation_conflict')
        return existing
    cur.execute('INSERT INTO worker_stop_observations'
                '(run_id,execution_id,generation,observed_at,source,process_id,exit_code) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                (run_id, execution_id, generation, now, source, process_id, exit_code))
    return cur.fetchone()
