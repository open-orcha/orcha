/**
 * <AgentConfigHistory agent={a} /> — the agent's configuration history + rollback, a
 * self-contained section for the agent Configuration tab ("History").
 *
 * Linear activity rows: round actor avatar · "Boss changed prompt, model" · #N · time.
 * A row expands to its field-level diff (prompt = line diff in mono, scalars = old → new)
 * and "Restore this version". Restore opens a confirm listing EXACTLY what would change
 * now (server-computed preview) and re-applies it through the normal authorized edit
 * routes — a NEW revision "Restored from #N"; history is never rewritten.
 *
 * Truthful: an actor the server didn't record reads "Unattributed" (never a guessed
 * human); a redacted secret is labelled as such; a revision that already matches the
 * live config says so instead of offering a no-op restore.
 * Gating: restore needs the acting human + the same grants the underlying edits need
 * (manage_agents / manage_autonomy); viewers see the history read-only.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Avatar, Button, ConfirmDialog, FilterPills, RelTime } from "../../../components/primitives";
import { Icon, useToast } from "../../../components/ui";
import { useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import type { Agent } from "../../../types";
import { GRANT_REASON, NO_ACTING_HUMAN } from "../agentModel";
import {
  actorName,
  changedSummary,
  fetchRevision,
  fetchRevisions,
  FIELD_ORDER,
  fieldLabel,
  formatValue,
  HISTORY_FILTERS,
  isTextField,
  restoreRevision,
  UNATTRIBUTED_TIP,
  type ConfigRevision,
  type ConfigValue,
  type HistoryFilter,
  type RevisionDetail,
} from "./configHistoryModel";
import { diffStats, lineDiff, withContext } from "./textDiff";
import "./configHistory.css";

/* ------------------------------------------------------------------ diffs */

export function TextDiff({ before, after, label }: { before: ConfigValue; after: ConfigValue; label: string }) {
  const ops = lineDiff(before == null ? "" : String(before), after == null ? "" : String(after));
  const { added, removed } = diffStats(ops);
  const rows = withContext(ops, 2);
  return (
    <div className="ach-tdiff">
      <div className="ach-tdiff-h">
        <span className="ach-ct" aria-label={`${added} lines added, ${removed} removed`}>
          <span className="a">+{added}</span> <span className="d">−{removed}</span>
        </span>
      </div>
      <pre className="ach-tdiff-b" aria-label={label + " text diff"}>
        {rows.map((r, i) =>
          r.kind === "gap" ? (
            <span key={i} className="ach-dl gap">
              ··· {r.count} unchanged line{r.count === 1 ? "" : "s"}
            </span>
          ) : (
            <span key={i} className={"ach-dl " + r.kind} data-kind={r.kind}>
              <span className="ach-dl-sign" aria-hidden="true">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
              <span className="ach-dl-t">{r.text || " "}</span>
            </span>
          ),
        )}
      </pre>
    </div>
  );
}

function ValueChange({ field, before, after, derived }: { field: string; before: ConfigValue; after: ConfigValue; derived?: boolean }) {
  return (
    <div className="ach-field">
      <div className="ach-field-k">
        {fieldLabel(field)}
        {derived ? <span className="ach-derived" title="Follows the model — not set on its own"> · from model</span> : null}
      </div>
      {isTextField(field) ? (
        <TextDiff before={before} after={after} label={fieldLabel(field)} />
      ) : (
        <div className="ach-field-v">
          <span className="ach-old">{formatValue(field, before)}</span>
          <Icon name="arrow" cls="v2-ico ach-arrow" />
          <span className="ach-new">{formatValue(field, after)}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ rows */

function RowGlyph({ r }: { r: ConfigRevision }) {
  if (r.kind === "initial") return <span className="ach-glyph"><Icon name="clock" cls="v2-ico" /></span>;
  if (!r.actor) return <span className="ach-glyph" title={UNATTRIBUTED_TIP}><Icon name="person" cls="v2-ico" /></span>;
  return <Avatar alias={r.actor.alias || "?"} kind={r.actor.kind === "human" ? "human" : "ai"} size={20} decorative />;
}

function rowSentence(r: ConfigRevision) {
  if (r.kind === "initial") return <>Initial configuration captured</>;
  const who = (
    <b className="ach-who" title={r.actor ? undefined : UNATTRIBUTED_TIP}>
      {actorName(r)}
    </b>
  );
  if (r.kind === "restore")
    return (
      <>
        {who} restored <b>{changedSummary(r)}</b> from <span className="ach-id">#{r.restored_from}</span>
      </>
    );
  return (
    <>
      {who} changed <b>{changedSummary(r)}</b>
    </>
  );
}

/* ------------------------------------------------------------------ main */

export interface AgentConfigHistoryProps {
  agent: Agent;
  className?: string;
}

export function AgentConfigHistory({ agent, className }: AgentConfigHistoryProps) {
  const { identity } = useSnapshot();
  const authority = useActingAuthority();
  const toast = useToast();
  const noHuman = authority.reason || NO_ACTING_HUMAN;
  const headId = useId();

  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [rows, setRows] = useState<ConfigRevision[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [latest, setLatest] = useState<number | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string>("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, RevisionDetail | "error">>({});
  const [confirm, setConfirm] = useState<RevisionDetail | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  // refetch when the live config changes (an edit elsewhere on the tab appends a revision)
  const configKey = [agent.id, agent.alias, agent.role, agent.model, agent.reasoning_effort, agent.auto_wake_interval_secs, agent.autonomy_override, agent.prompt_preview].join("\u0001");

  const aid = agent.id;
  useEffect(() => {
    const ac = new AbortController();
    setError("");
    fetchRevisions(aid, filter, null, ac.signal)
      .then((p) => {
        setRows(p.revisions);
        setTotal(p.total);
        setLatest(p.latest_revision_no);
        setNextBefore(p.next_before);
        setDetails({}); // previews are "vs the live config" — stale once it changed
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError((e as { detail?: string; message?: string }).detail || (e as { message?: string }).message || "the server didn't answer");
      });
    return () => ac.abort();
  }, [aid, filter, configKey, reload]);

  const loadMore = () => {
    if (nextBefore == null) return;
    setLoadingMore(true);
    fetchRevisions(aid, filter, nextBefore)
      .then((p) => {
        setRows((cur) => [...(cur || []), ...p.revisions]);
        setNextBefore(p.next_before);
      })
      .catch((e) => toast((e as { detail?: string }).detail || "Couldn't load older revisions", "danger"))
      .finally(() => setLoadingMore(false));
  };

  const loadDetail = useCallback(
    (n: number) => {
      fetchRevision(aid, n)
        .then((d) => setDetails((m) => ({ ...m, [n]: d })))
        .catch(() => setDetails((m) => ({ ...m, [n]: "error" })));
    },
    [aid],
  );

  const toggle = (n: number) => {
    const next = open === n ? null : n;
    setOpen(next);
    if (next != null && !details[next]) loadDetail(next);
  };

  // gating: the acting human (from the authority — the same pick every other control
  // uses) + every grant the preview's fields need
  const deniedFor = (d: RevisionDetail): string | null => {
    if (!authority.human || identity?.member_role === "viewer") return noHuman;
    const grants = Array.from(new Set(d.restore_preview.map((p) => p.grant)));
    for (const g of grants) {
      if (!identity || identity.member_role === "owner" || (identity.grants || []).includes(g)) continue;
      return GRANT_REASON[g];
    }
    return null;
  };

  const doRestore = () => {
    if (!confirm) return;
    const h = authority.human;
    setBusy(true);
    restoreRevision(aid, confirm.revision_no, h ? String(h.id) : null, reason)
      .then((res) => {
        toast(res.applied.length ? "Restored from #" + res.restored_from : "Already matches #" + res.restored_from, "ok");
        setConfirm(null);
        setReason("");
        setOpen(null);
        setReload((x) => x + 1);
      })
      .catch((e) => toast((e as { detail?: string }).detail || "Restore failed", "danger"))
      .finally(() => setBusy(false));
  };

  const body = (() => {
    // E02: same recoverable shape as the Budget / Routines sections — the reason + Retry
    if (error)
      return (
        <div className="ach-empty ach-err" role="alert">
          <span>Couldn't load history — {error}</span>{" "}
          <Button variant="ghost" size="sm" onClick={() => { setRows(null); setReload((x) => x + 1); }}>Retry</Button>
        </div>
      );
    if (rows == null) return <div className="ach-empty" aria-busy="true">Loading history…</div>;
    if (!rows.length) return <div className="ach-empty">{filter === "all" ? "No configuration changes yet." : "No revisions match this filter."}</div>;
    return (
      <ol className="ach-list" aria-labelledby={headId}>
        {rows.map((r) => {
          const isOpen = open === r.revision_no;
          const d = details[r.revision_no];
          const panelId = `${headId}-rev-${r.revision_no}`;
          return (
            <li key={r.revision_no} className={"ach-item" + (isOpen ? " is-open" : "")}>
              <button type="button" className="ach-row" aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(r.revision_no)}>
                <RowGlyph r={r} />
                <span className="ach-text">{rowSentence(r)}</span>
                {r.revision_no === latest ? <span className="ach-chip">Current</span> : null}
                <span className="ach-id">#{r.revision_no}</span>
                <RelTime at={r.created_at} className="ach-time" />
                <Icon name="chev" cls={"v2-ico ach-caret" + (isOpen ? " is-open" : "")} />
              </button>
              {isOpen ? (
                <div className="ach-detail" id={panelId}>
                  {r.reason ? <div className="ach-reason"><span className="k">Reason</span> {r.reason}</div> : null}
                  {r.redacted_fields.length ? (
                    <div className="ach-note">
                      <Icon name="shield" cls="v2-ico" /> A secret in {r.redacted_fields.map(fieldLabel).join(", ").toLowerCase()} was redacted — it is never stored in history.
                    </div>
                  ) : null}
                  {r.kind === "initial" ? (
                    d && d !== "error" ? (
                      FIELD_ORDER.filter((f) => f in d.snapshot).map((f) =>
                        isTextField(f) ? (
                          <div className="ach-field" key={f}>
                            <div className="ach-field-k">{fieldLabel(f)}</div>
                            <pre className="ach-tdiff-b ach-plain">{d.snapshot[f] == null ? "Not set" : String(d.snapshot[f])}</pre>
                          </div>
                        ) : (
                          <div className="ach-field" key={f}>
                            <div className="ach-field-k">{fieldLabel(f)}</div>
                            <div className="ach-field-v">{formatValue(f, d.snapshot[f] ?? null)}</div>
                          </div>
                        ),
                      )
                    ) : null
                  ) : (
                    r.changes.map((c) => <ValueChange key={c.field} field={c.field} before={c.before} after={c.after} derived={c.derived} />)
                  )}
                  <RestoreBar
                    d={d}
                    denied={d && d !== "error" ? deniedFor(d) : null}
                    onRetry={() => loadDetail(r.revision_no)}
                    onRestore={() => d && d !== "error" && setConfirm(d)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  })();

  return (
    <section className={"ach" + (className ? " " + className : "")} aria-labelledby={headId}>
      <div className="ach-head">
        <h3 id={headId} className="ach-title">History</h3>
        {total != null ? <span className="ach-count">{total}</span> : null}
        <span className="grow" />
      </div>
      <FilterPills size="sm" label="Filter configuration history" items={HISTORY_FILTERS} value={filter} onChange={(k) => { setFilter(k as HistoryFilter); setOpen(null); }} />
      {body}
      {rows && nextBefore != null ? (
        <Button variant="ghost" size="sm" className="ach-more" busy={loadingMore} onClick={loadMore}>
          Show older
        </Button>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={`Restore revision #${confirm.revision_no}?`}
          description="Re-applies these values through the normal edit path and records a new revision. Nothing in the history is removed."
          confirmLabel="Restore"
          busy={busy}
          onConfirm={doRestore}
          onClose={() => { if (!busy) { setConfirm(null); setReason(""); } }}
        >
          <div className="ach-preview" aria-label="What will change">
            {confirm.restore_preview.map((p) => (
              <ValueChange key={p.field} field={p.field} before={p.current} after={p.target} />
            ))}
          </div>
          <label className="ach-reason-in">
            <span className="k">Reason <span className="muted">(optional)</span></span>
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Why roll back?" />
          </label>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function RestoreBar({ d, denied, onRetry, onRestore }: { d: RevisionDetail | "error" | undefined; denied: string | null; onRetry: () => void; onRestore: () => void }) {
  const deniedId = useId();
  if (d === undefined) return <div className="ach-bar"><span className="ach-muted" aria-busy="true">Checking against the current configuration…</span></div>;
  if (d === "error")
    return (
      <div className="ach-bar">
        <span className="ach-muted">Couldn't compare with the current configuration.</span>
        <Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>
      </div>
    );
  if (d.restore_blocked.length)
    return (
      <div className="ach-bar">
        <span className="ach-muted">Can't restore: {d.restore_blocked.map((b) => fieldLabel(b.field) + " " + b.reason).join("; ")}.</span>
      </div>
    );
  if (!d.restore_preview.length)
    return (
      <div className="ach-bar">
        <span className="ach-muted"><Icon name="check" cls="v2-ico" /> The current configuration matches this version.</span>
      </div>
    );
  return (
    <div className="ach-bar">
      <span className="ach-muted">
        Restoring changes {d.restore_preview.map((p) => fieldLabel(p.field).toLowerCase()).join(", ")}
      </span>
      <span className="grow" />
      <Button variant="secondary" size="sm" icon="refresh" disabled={!!denied} aria-describedby={denied ? deniedId : undefined} onClick={onRestore}>
        Restore this version
      </Button>
      {denied ? <span className="ach-denied" id={deniedId}>{denied}</span> : null}
    </div>
  );
}
