/**
 * Requests (`?view=requests`): what agents and people asked QA to do, where it came from and what
 * came back. `?status=` narrows the list, `?request=<id>` opens one in the inspector.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Chip, EmptyState, FilterPills, List, Row, Skeleton, SplitPane, StatusIcon } from "../../../components/primitives";
import { relTime } from "../../../lib/format";
import { taskById, useSnapshot } from "../../../state/SnapshotProvider";
import type { QaAuthority } from "../authority";
import { useLoad } from "../parts";
import type { QaNav } from "../QaPage";
import { QaSubEnd } from "../SubNav";
import type { Platform } from "../qaApi";
import { platformWord } from "../qaWords";
import { LIVE_POLL_MS } from "../sessions/detail/use-session-live";
import { requestsChanged, useRequestsChanged } from "../../../state/qaRequestBus";
import { listRequests, type QaRequest } from "./api";
import { isOpenRequest, linesTally, newestFirst } from "./model";
import { RequestDetail } from "./RequestDetail";
import { sourceWords } from "./RequestSource";
import { requestKindWord, requestStatusGlyph, requestStatusWord, requestTitle, requestTone, roundWord } from "./words";

const FILTERS = [
  { key: "all", label: "All", test: () => true },
  { key: "open", label: "Open", test: isOpenRequest },
  { key: "passed", label: "Passed", test: (r: QaRequest) => r.status === "passed" },
  { key: "failed", label: "Failed", test: (r: QaRequest) => r.status === "failed" || r.status === "blocked" },
] as const;

/** The row's result: how many lines passed, else the status in words. */
function resultWord(r: QaRequest): string | null {
  if (isOpenRequest(r)) return null;
  return linesTally(r) ?? (r.result?.finding_ids.length ? `${r.result.finding_ids.length} ${r.result.finding_ids.length === 1 ? "finding" : "findings"}` : null);
}

function RequestRow({ r, selected, onOpen }: { r: QaRequest; selected: boolean; onOpen: () => void }) {
  const { snap } = useSnapshot();
  const taskTitle = r.source_task_id ? taskById(snap, r.source_task_id)?.title ?? null : null;
  const result = resultWord(r);
  return (
    <Row id={r.id} selected={selected} onActivate={onOpen} className="qa-req-row" title={[requestTitle(r), result, requestKindWord(r.kind), roundWord(r.round, r.max_rounds)].filter(Boolean).join(" · ")}>
      <StatusIcon status={requestStatusGlyph(r.status)} label={requestStatusWord(r.status, r.kind)} size={14} />
      <span className="qa-req-main">
        <span className="qa-req-title">{requestTitle(r)}</span>
        <span className="qa-req-source">{[sourceWords(r, taskTitle), result, requestKindWord(r.kind), r.platform ? platformWord(r.platform as Platform) : null, roundWord(r.round, r.max_rounds)].filter(Boolean).join(" · ")}</span>
      </span>
      <Chip size="sm" dot={requestTone(r.status)}>{requestStatusWord(r.status, r.kind)}</Chip>
      <span className="qa-muted qa-req-at">{relTime(r.created_at)}</span>
    </Row>
  );
}

export function QaRequests({ cid, nav, auth }: { cid: string; nav: QaNav; auth: QaAuthority }) {
  const [tick, setTick] = useState(0);
  const changed = useRequestsChanged();
  const res = useLoad((s) => listRequests(cid, {}, s), [cid], nav.nonce + tick + changed);
  const rows = useMemo(() => newestFirst(res.data ?? []), [res.data]);
  const open = rows.some(isOpenRequest);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), LIVE_POLL_MS * 2);
    return () => clearInterval(t);
  }, [open]);
  const raw = nav.get("status");
  const filter = FILTERS.find((f) => f.key === raw) ?? FILTERS[0];
  const shown = rows.filter(filter.test);
  const selected = nav.get("request");

  if (res.error && !res.data) return <EmptyState tone="danger" title="Couldn't load the requests" body={res.error} action={<Button size="sm" onClick={nav.refresh}>Retry</Button>} />;
  if (!res.data) return <div className="qa-pad"><Skeleton lines={5} label="Loading the requests" /></div>;

  const list = (
    <div className="qa-listwrap" data-qa-requests>
      {!rows.length ? (
        <EmptyState title="No requests yet" body="When an agent or a person sends a task to QA, the request and its result show up here." />
      ) : !shown.length ? (
        <EmptyState title="Nothing here" body="No request matches this filter." />
      ) : (
        <List label="QA requests" className="qa-req-list">
          {shown.map((r) => <RequestRow key={r.id} r={r} selected={selected === r.id} onOpen={() => nav.set({ request: r.id })} />)}
        </List>
      )}
    </div>
  );
  const row = rows.find((r) => r.id === selected) ?? null;
  return (
    <>
      <QaSubEnd slot={nav.subEnd}>
        <FilterPills size="sm" label="Show requests" value={filter.key} onChange={(k) => nav.set({ status: k === "all" ? null : k })}
          items={FILTERS.map((f) => ({ key: f.key, label: f.label, count: rows.filter(f.test).length }))} />
      </QaSubEnd>
      <SplitPane storageKey="orcha:v2:qaRequestInspector" defaultSize={520} list={list}
        inspector={selected ? <RequestDetail key={selected} id={selected} seed={row} auth={auth} nonce={nav.nonce + tick + changed} onClose={() => nav.set({ request: null })} onChanged={requestsChanged} /> : null} />
    </>
  );
}
