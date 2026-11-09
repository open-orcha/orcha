import { useMemo } from "react";
import { ArrowLeft, Columns2 } from "../../map/kit/icons";
import { Empty, Link, Skeleton } from "../../map/kit";
import type { QaNav } from "../../QaPage";
import { getSession, listSessions, type SessionDetail } from "../../qaApi";
import { useLoad } from "../../parts";
import { explorationOf } from "../adapt";
import { listDigests, type SessionDigest } from "../api";
import type { Exploration, ExplorationResult } from "../explorations";
import { qaHref } from "../../parts";
import { CompareView, type CompareOption } from "./compare-view";
import { orderPair } from "./exploration-compare";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * A session's findings, keyed the same way across sessions: a stored finding's id is its own, so
 * an agent's finding matches on its lens, screen and title. A measured one keeps its fingerprint.
 */
export function comparable(e: Exploration): Exploration {
  if (!e.result) return e;
  const result: ExplorationResult = {
    ...e.result,
    findings: e.result.findings.map((f) => (f.source === "agent" ? { ...f, fingerprint: `${f.lens}|${f.screen ?? ""}|${norm(f.title)}` } : f)),
  };
  return { ...e, result };
}

function sideOf(d: SessionDetail): Exploration {
  return explorationOf(d.session, { findings: d.findings, walks: d.walks, drafted: d.drafts.length, steps: d.steps_count ?? undefined, measured: d.measured });
}

/** Compare two sessions of this project (`?sub=compare&a=&b=`): the earlier one is always Before. */
export function ComparePage({ cid, nav }: { cid: string; nav: QaNav }) {
  const a = nav.get("a");
  const b = nav.get("b");
  const res = useLoad(
    async (s) => {
      if (!a || !b || a === b) return null;
      const [x, y, rows, digests] = await Promise.all([getSession(a, s), getSession(b, s), listSessions(cid, { platform: nav.platform }, s), listDigests(cid, nav.platform, s).catch(() => ({} as Record<string, SessionDigest>))]);
      return { x, y, rows, digests };
    },
    [cid, a, b, nav.platform],
    nav.nonce,
  );
  const options = useMemo<CompareOption[]>(() => {
    if (!res.data) return [];
    return res.data.rows.filter((s) => !s.archived_at || s.id === a || s.id === b).map((s) => {
      const d = res.data?.digests[s.id];
      const e = explorationOf(s, { findings: d?.findings ?? [], walks: d?.walks ?? [], drafted: d?.drafts.length ?? 0, steps: d?.steps_count, measured: d?.measured });
      return { id: e.id, name: e.name, created_at: e.created_at, scored: Boolean(e.result) };
    });
  }, [res.data, a, b]);
  const back = (
    <Link href={qaHref({ view: nav.get("view"), platform: nav.platform === "ios" ? null : nav.platform })} className="inline-flex w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg" data-back-to-explorations>
      <ArrowLeft className="size-3.5" /> All explorations
    </Link>
  );
  if (!a || !b || a === b || res.error) {
    return (
      <div className="flex flex-col gap-4 px-4.5 py-5">
        {back}
        <Empty icon={Columns2} title="Pick two explorations" description={res.error ?? "Compare needs two different explorations. Pick them in the history."} className="max-w-[520px] self-center rounded-lg border border-border bg-panel" />
      </div>
    );
  }
  if (!res.data) return <div className="px-4.5 py-5"><Skeleton className="h-64 w-full" /></div>;
  const [before, after] = orderPair(comparable(sideOf(res.data.x)), comparable(sideOf(res.data.y)));
  return (
    <div className="flex flex-col gap-4 px-4.5 py-5">
      {back}
      <CompareView a={{ exploration: before, build: null }} b={{ exploration: after, build: null }} options={options} />
    </div>
  );
}
