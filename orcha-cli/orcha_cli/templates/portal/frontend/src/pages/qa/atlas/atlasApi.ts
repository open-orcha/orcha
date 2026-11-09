/** The Screen atlas's one read (`GET /api/containers/<id>/qa/atlas`, `qa_atlas.py`). */
import { getJSON } from "../../../api/client";

export const getAtlas = (cid: string, since: string | null, signal?: AbortSignal): Promise<unknown> =>
  getJSON<unknown>(`/api/containers/${encodeURIComponent(cid)}/qa/atlas${since ? `?since=${encodeURIComponent(since)}` : ""}`, signal);
