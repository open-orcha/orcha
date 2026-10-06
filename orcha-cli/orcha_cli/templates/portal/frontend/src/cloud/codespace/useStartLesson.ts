/**
 * Learn — the ONE place a lesson request is created (Learn quick starts,
 * follow-up chips, the editor's floating Teach · Why lens). It is exactly the
 * thread composer's POST (codespaceApi.createThread, kind teach|why, anchored to
 * a file + lines, @agent tagged) with the same gates: a viewer can't write, an
 * acting human is required, and a question-like thread needs an AI agent to
 * answer it (otherwise it would sit orphaned — ThreadComposer's rule).
 */
import { useCallback, useState } from "react";
import { useToast } from "../../components/ui";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { createThread } from "./codespaceApi";
import type { CreateThreadResponse, ThreadKind } from "./codespaceTypes";
import { useCodeWriteBlock } from "./writeAccess";

export interface LessonRequest {
  kind: Extract<ThreadKind, "teach" | "why">;
  path: string;
  start: number;
  end: number;
  body: string;
}

export function aiAgentsOf(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.kind === "ai");
}

export function useStartLesson(cid: string, gitRef: string, agents: Agent[]) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const writeBlock = useCodeWriteBlock();
  const [busy, setBusy] = useState<string | null>(null);
  const ai = aiAgentsOf(agents);
  const blocked: string | null = writeBlock || (ai.length ? null : "Register an AI agent first — nobody can answer yet");

  const start = useCallback(
    async (req: LessonRequest, agentId?: string | null, busyKey = "lesson"): Promise<CreateThreadResponse | null> => {
      if (writeBlock) { toast(writeBlock, "warn"); return null; }
      const who = actingHuman(snap);
      if (!who) { toast("Pick an acting human first", "warn"); return null; }
      if (!ai.length) { toast("Register an AI agent first — nobody can answer yet", "warn"); return null; }
      setBusy(busyKey);
      const res = await createThread(cid, {
        ref: gitRef,
        path: req.path,
        start_line: Math.max(1, req.start),
        end_line: Math.max(req.start, req.end),
        kind: req.kind,
        body: req.body,
        tagged_agent_id: agentId || ai[0].id,
        actor_agent_id: who.id,
      });
      setBusy(null);
      if (!res.ok) {
        toast("Couldn't start the lesson" + (res.error.detail ? ": " + res.error.detail : ""), "danger");
        return null;
      }
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cid, gitRef, snap, writeBlock, ai.map((a) => a.id).join(",")],
  );

  return { start, busy, blocked, aiAgents: ai };
}
