"""Bounded registry traversal, independent of live worker rows and event cursors."""

import time

from .job_api import JobAPI, JobAPIError
from .job_monitor import publish
from .job_store import JobStore, JobStorageError, atomic_json, read_json

_last_pass = {}


def tick(api_base, container_id, base_cwd, services):
    if not base_cwd:
        return
    key = (api_base, str(container_id), str(base_cwd))
    now = time.monotonic()
    if now - _last_pass.get(key, -float('inf')) < 5:
        return
    _last_pass[key] = now
    try:
        store = JobStore(base_cwd)
        cursor_path = store.root / f'.monitor-cursor-{container_id}.json'
        after = read_json(cursor_path).get('after') if cursor_path.exists() else None
        suffix = f'&after={after}' if after else ''
        page = services._get_json(f'{api_base}/api/containers/{container_id}/job-monitors?limit=10{suffix}')
        if not page or 'monitors' not in page:
            return
        rows = page['monitors']
        for index, monitor in enumerate(rows):
            job = monitor['job']
            try:
                api = JobAPI(api_base, None, job['task_id'], machine=True)
                refreshed = api.request(f"job-monitors/{job['job_id']}/reconcile", {})
                job, monitor = refreshed['job'], refreshed
                publish(api, store, job, monitor['outcome'])
            except (JobAPIError, JobStorageError, OSError, KeyError, ValueError, TypeError):
                pass  # Keep its fence; an unavailable record cannot starve the next job.
            next_after = job['job_id'] if index < len(rows)-1 or page['next_after'] else None
            atomic_json(cursor_path, {'after':next_after})
            if time.monotonic() - now >= 5:
                break
        if not rows:
            atomic_json(cursor_path, {'after':None})
    except (JobStorageError, OSError, KeyError, ValueError, TypeError):
        return
