/**
 * Which tasks are Quality runs (`GET C/run-tasks`), shared by every view of the project. Read once per
 * project, and again when a request changes or a task appears; a row needs no read of its own.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getJSON } from "../../../api/client";
import { useRequestsChanged } from "../../../state/qaRequestBus";
import { useSnapshot } from "../../../state/SnapshotProvider";
import { isObj, listOf, text } from "./read";

const NONE: ReadonlySet<string> = new Set();
const known = new Map<string, ReadonlySet<string>>();
const reading = new Set<string>();
const listeners = new Set<() => void>();

async function read(cid: string) {
  if (reading.has(cid)) return;
  reading.add(cid);
  try {
    const raw = await getJSON<unknown>(`/api/containers/${encodeURIComponent(cid)}/qa/run-tasks?limit=500`);
    const ids = listOf<unknown>(isObj(raw) ? raw.run_tasks : null).map((r) => (isObj(r) ? text(r.task_id) : null)).filter((id): id is string => !!id);
    const was = known.get(cid);
    if (was && was.size === ids.length && ids.every((id) => was.has(id))) return;
    known.set(cid, new Set(ids));
    listeners.forEach((l) => l());
  } catch {
    /* an older server has no marks: the rows' own text still marks most */
  } finally {
    reading.delete(cid);
  }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useRunTaskIds(): ReadonlySet<string> {
  const { cid, snap } = useSnapshot();
  const changed = useRequestsChanged();
  const tasks = snap?.tasks?.length ?? 0;
  useEffect(() => { if (cid) void read(cid); }, [cid, changed, tasks]);
  return useSyncExternalStore(subscribe, () => (cid ? known.get(cid) ?? NONE : NONE));
}

export const _resetRunTasksForTests = () => { known.clear(); reading.clear(); };
