import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ChevronRight, Search } from "../../map/kit/icons";
import { pillClass } from "../../map/kit";
import { Empty } from "../../map/kit";
import { Input } from "../../map/kit";
import { SkeletonRows } from "../../map/kit";
import { StatusGlyph } from "../../map/kit";
import { fmtMs } from "../../map/kit";
import {
  API_REQUEST_KINDS,
  callSpeed,
  checkText,
  countByKind,
  fmtCallMs,
  filterRequests,
  groupChecks,
  pathOf,
  prettyBody,
  statusLabel,
  statusTone,
  type ApiRequestKind,
  type ApiRequestRow,
  type ApiRequestsResponse,
  type RequestCheckRow,
  type StatusTone,
} from "../lib/api-requests";
import { cn } from "../../map/kit";
import { listRequests } from "../api";

const STATUS_TEXT: Record<StatusTone, string> = {
  ok: "text-success",
  redirect: "text-fg-2",
  client: "text-warning",
  server: "text-danger",
  failed: "text-danger",
  pending: "text-muted",
};

const INITIAL_VISIBLE = 200;
const VISIBLE_STEP = 400;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: ApiRequestsResponse };

/**
 * The run page's API tab: every fetch/XHR the app sent (`qa_session_requests`), with the status it
 * got and how long it took. Rows expand to the request body. A running session re-reads the list.
 */
export function ApiRequestsPanel({ runId, className, live: running = false }: { runId: string; className?: string; live?: boolean }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setVersion((v) => v + 1), 2500);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    let live = true;
    listRequests(runId)
      .then((requests) => {
        if (live) setLoad({ state: "ready", data: { requests, checks: [] } });
      })
      .catch((e: unknown) => {
        if (live) setLoad((cur) => (cur.state === "ready" ? cur : { state: "error", message: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      live = false;
    };
  }, [runId, version]);

  if (load.state === "loading") return <SkeletonRows rows={5} className={className} />;
  if (load.state === "error") {
    return (
      <p className="py-6 text-center text-sm text-danger" data-api-error>
        Could not load the API requests: {load.message}
      </p>
    );
  }
  const { requests, checks } = load.data;
  if (requests.length === 0 && checks.length === 0) {
    return (
      <Empty
        icon={ArrowLeftRight}
        title="No API requests recorded"
        description="Run on the web: every fetch and XHR the page sends shows here. A native app's calls are not captured."
        className={className}
      />
    );
  }
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-4", className)} data-api-panel>
      {checks.length > 0 ? <RequestChecks checks={checks} /> : null}
      <RequestTable requests={requests} />
    </div>
  );
}

function RequestChecks({ checks }: { checks: readonly RequestCheckRow[] }) {
  const groups = useMemo(() => groupChecks(checks), [checks]);
  return (
    <section aria-label="Request checks" data-api-checks className="flex flex-col gap-2">
      <h3 className="px-2 text-xs font-medium text-muted">Request checks</h3>
      {groups.map((g) => (
        <div key={`${g.scenarioId ?? ""}:${g.scenario}`} className="rounded-lg border border-border bg-panel" data-api-check-group>
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
            <StatusGlyph status={g.failed ? "fail" : "pass"} decorative className="size-3" />
            <span className="min-w-0 truncate text-sm font-medium text-fg">{g.scenario}</span>
            <span className="ml-auto text-xs tabular text-muted">
              {g.failed ? `${g.failed} of ${g.checks.length} failed` : `${g.checks.length} passed`}
            </span>
          </div>
          <ul className="flex flex-col py-1">
            {g.checks.map((c) => (
              <li key={c.seq} className="flex items-start gap-2 px-3 py-1" data-api-check data-ok={c.ok ? "1" : "0"}>
                <StatusGlyph status={c.ok ? "pass" : "fail"} className="mt-0.5 size-3 shrink-0" />
                <span className={cn("min-w-0 break-words font-mono text-xs leading-5", c.ok ? "text-fg-2" : "text-fg")}>
                  {checkText(c.text)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function RequestTable({ requests }: { requests: readonly ApiRequestRow[] }) {
  const [kind, setKind] = useState<ApiRequestKind>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const counts = useMemo(() => countByKind(requests), [requests]);
  const filtered = useMemo(() => filterRequests(requests, kind, query), [requests, kind, query]);
  const shown = filtered.slice(0, visible);

  if (requests.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted" data-api-no-requests>
        No API requests recorded for this run.
      </p>
    );
  }

  return (
    <section aria-label="API requests" className="flex min-h-0 flex-1 flex-col gap-2.5" data-api-requests>
      <div className="flex flex-wrap items-center gap-2" data-api-filters>
        {API_REQUEST_KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            className={pillClass(kind === k.value, "h-6 px-2.5 text-xs")}
            aria-pressed={kind === k.value}
            onClick={() => setKind(k.value)}
            data-api-filter={k.value}
          >
            {k.label}
            <span className="tabular text-muted">{counts[k.value]}</span>
          </button>
        ))}
        <span className="relative min-w-[160px] flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            placeholder="Filter by path…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-6 pl-7 text-xs"
            aria-label="Filter by path"
            data-api-search
          />
        </span>
      </div>

      <div role="table" aria-label="API requests" className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-api-rows>
        {shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No requests match these filters.</p>
        ) : (
          shown.map((r) => (
            <RequestRow
              key={r.seq}
              request={r}
              expanded={open === r.seq}
              onToggle={() => setOpen((o) => (o === r.seq ? null : r.seq))}
            />
          ))
        )}
        {filtered.length > shown.length ? (
          <button
            type="button"
            onClick={() => setVisible((v) => v + VISIBLE_STEP)}
            className="mx-2 my-2 h-7 rounded-md border border-border text-xs text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            Show more ({filtered.length - shown.length} more)
          </button>
        ) : null}
      </div>
    </section>
  );
}

function RequestRow({ request: r, expanded, onToggle }: { request: ApiRequestRow; expanded: boolean; onToggle: () => void }) {
  const path = pathOf(r.url);
  const tone = statusTone(r);
  return (
    <div role="row" data-api-row data-seq={r.seq} data-tone={tone} className={cn("rounded-md", expanded && "bg-hover")}>
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="grid min-w-0 flex-1 grid-cols-[12px_54px_minmax(0,1fr)_auto_auto_108px_44px] items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover max-md:grid-cols-[12px_40px_minmax(0,1fr)_auto_48px_36px] max-md:gap-1.5"
        >
          <ChevronRight aria-hidden className={cn("size-3 text-muted transition-transform", expanded && "rotate-90")} />
          <span className="font-mono text-xs font-medium text-fg-2">{r.method ?? "–"}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-[3rem] truncate font-mono text-xs leading-5 text-fg" title={r.url ?? undefined}>
              {path || "–"}
            </span>
          </span>
          <span className={cn("justify-self-end font-mono text-xs font-medium tabular", STATUS_TEXT[tone])} data-api-status>
            {statusLabel(r)}
          </span>
          <span className="max-w-[160px] truncate text-xs text-muted max-md:hidden" title={r.scenario ?? undefined}>
            {r.scenario ?? ""}
          </span>
          <CallTime ms={r.ms} />
          <span className="justify-self-end font-mono text-xs tabular text-muted" title="When it was sent, from the start of the run">{fmtMs(r.at_ms)}</span>
        </button>
      </div>
      {expanded ? <RequestDetail request={r} /> : null}
    </div>
  );
}

/** The timing bar's span: three seconds, so the amber (1 s) and red (2 s) lines sit at its
 * thirds; a longer call fills it. */
const CALL_SCALE_MS = 3000;

/** How long the call took (#414), amber from a second and red from two: the time, and a bar on a
 * three-second scale with those two lines marked, growing in as the row appears. */
function CallTime({ ms }: { ms: number | null | undefined }) {
  const speed = callSpeed(ms);
  const label = fmtCallMs(ms);
  const fill = ms == null ? 0 : Math.max(0.04, Math.min(1, ms / CALL_SCALE_MS));
  return (
    <span className="flex items-center justify-end gap-2 justify-self-stretch">
      {ms != null ? (
        <span aria-hidden className="relative hidden h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg)_8%,transparent)] md:block" data-api-ms-bar>
          <span
            className={cn("v-grow-x absolute inset-y-0 left-0 rounded-full", speed === "very" ? "bg-danger" : speed === "slow" ? "bg-warning" : "bg-[color-mix(in_srgb,var(--color-fg-2)_55%,transparent)]")}
            style={{ width: `${(fill * 100).toFixed(1)}%` }}
          />
          <span className="absolute inset-y-0 left-1/3 w-px bg-panel" />
          <span className="absolute inset-y-0 left-2/3 w-px bg-panel" />
        </span>
      ) : null}
      <span
        className={cn("font-mono text-xs tabular", speed === "very" ? "font-semibold text-danger" : speed === "slow" ? "font-medium text-warning" : "text-fg-2")}
        title={ms == null ? "This run did not time its calls" : `Took ${label}, sent to answered${speed ? " (slow)" : ""}`}
        data-api-ms={ms ?? undefined}
        data-speed={speed ?? undefined}
      >
        {label}
        {speed ? <span className="sr-only"> (slow)</span> : null}
      </span>
    </span>
  );
}

function RequestDetail({ request: r }: { request: ApiRequestRow }) {
  const body = prettyBody(r.request_body);
  return (
    <div className="flex flex-col gap-2 px-8 pb-3 pt-1" data-api-detail>
      <p className="break-all font-mono text-xs text-fg-2">
        {r.method} {r.url}
      </p>
      {body.text ? (
        <pre
          className="max-h-72 overflow-auto rounded-md border border-border bg-panel p-2 font-mono text-xs leading-5 text-fg"
          data-api-body={body.json ? "json" : "text"}
        >
          {body.text}
        </pre>
      ) : (
        <p className="text-xs text-muted">No request body.</p>
      )}
    </div>
  );
}
