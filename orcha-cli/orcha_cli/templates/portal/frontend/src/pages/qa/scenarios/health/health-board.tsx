import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { RefreshCw, X } from "../../map/kit/icons";
import { Button } from "../../map/kit";
import { errText } from "../../parts";
import { scenarioAudit, scenarioHealthAction } from "../api";
import { HumanGate, useScenarios } from "../context";
import { useToast } from "../../map/kit";
import { fmtRelative, plural } from "../../map/kit";
import { cn } from "../../map/kit";
import { FLAG_ICON } from "./badge";
import { groupAudit, scenariosNeedingALook, selectedRows, type BoardRow } from "./board-model";
import { seedFlags } from "./health-store";
import { MergeDialog, RenameDialog, type ScenarioChoice } from "./health-dialogs";
import { HealthChecking, HealthHealthy, HealthNoScenarios } from "./health-states";
import styles from "./health.module.css";
import { ACTION_LABEL, FLAG_LABEL, type HealthAction, type HealthAudit, type HealthFlagKind } from "./types";

const PLATFORM: Record<string, string> = { web: "Web", ios: "iOS", android: "Android" };

/** The actions each kind of flag offers, recommended one first (the flag's own `action` wins). */
const ACTIONS: Record<HealthFlagKind, HealthAction[]> = {
  suspicious: ["drafts", "rename", "archive", "dismiss"],
  duplicate: ["merge", "rename", "archive", "dismiss"],
  env_failing: ["fix_env", "open", "dismiss"],
  orphaned: ["fix_env", "archive", "dismiss"],
  never_passed: ["open", "drafts", "archive", "dismiss"],
  stale: ["open", "drafts", "dismiss"],
  flaky: ["open", "dismiss"],
  platform_wording: ["open", "drafts", "dismiss"],
};

export function actionsFor(row: BoardRow): HealthAction[] {
  // A draft is already out of the batches: "Move to drafts" makes no sense for it.
  const ok = (a: HealthAction) => !(a === "drafts" && row.scenario.status === "draft");
  const first = ok(row.flag.action) ? row.flag.action : "archive";
  return [first, ...ACTIONS[row.flag.kind]].filter((a, i, all) => ok(a) && all.indexOf(a) === i);
}

type ActionBody = { action: string; ids: string[]; kind?: HealthFlagKind; name?: string; into?: string };

async function fetchAudit(cid: string): Promise<{ audit?: HealthAudit; error?: string }> {
  try {
    return { audit: await scenarioAudit(cid) };
  } catch (err) {
    return { error: errText(err) };
  }
}

/**
 * Scenarios > Health (#188): the audit as a calm board grouped by flag, with counts, a reason
 * per row and one-click actions (Rename, Merge into…, Move to drafts, Retire, Fix environment,
 * Dismiss), bulk select, the flags people kept in a fold at the bottom, a live "checking" view
 * and an animated healthy state.
 */
export function HealthBoard({ scenarios, onScenario, onMap, onApps }: { scenarios: readonly ScenarioChoice[]; onScenario: (id: string) => void; onMap: () => void; onApps: () => void }) {
  const { toast } = useToast();
  const { cid, auth } = useScenarios();
  const [audit, setAudit] = useState<HealthAudit | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [merging, setMerging] = useState<BoardRow | null>(null);

  const apply = useCallback((r: { audit?: HealthAudit; error?: string }) => {
    if (r.audit) {
      setAudit(r.audit);
      seedFlags(r.audit.scenarios.map((s) => [s.id, s.flags]));
      setPhase("ready");
      setError(null);
    } else {
      setError(r.error ?? "The check could not run.");
      setPhase((p) => (p === "ready" ? "ready" : "error"));
    }
    setRefreshing(false);
    setLeaving(new Set());
  }, []);

  const load = useCallback(
    async (_fresh: boolean) => {
      setRefreshing(true);
      apply(await fetchAudit(cid));
    },
    [cid, apply],
  );

  // The re-check after an action waits for the rows to fold; it never outlives the board.
  const recheck = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (recheck.current != null) window.clearTimeout(recheck.current);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void fetchAudit(cid).then((r) => {
      if (alive) apply(r);
    });
    return () => {
      alive = false;
    };
  }, [cid, apply]);

  const { groups, kept, open } = useMemo(() => groupAudit(audit), [audit]);
  const needLook = scenariosNeedingALook(audit);
  const chosen = useMemo(() => selectedRows(groups, selected), [groups, selected]);

  async function act(body: ActionBody, done: string, rows: BoardRow[]): Promise<string | null> {
    setBusy(`${body.action}:${body.ids.join(",")}`);
    let err: string | null = null;
    try {
      await scenarioHealthAction(cid, auth.human?.id ?? null, body);
    } catch (e) {
      err = errText(e);
    }
    setBusy(null);
    if (err) {
      toast({ title: "That did not work", description: err, variant: "error" });
      return err;
    }
    setLeaving((l) => new Set([...l, ...rows.map((r) => r.key)]));
    setSelected((s) => new Set([...s].filter((k) => !rows.some((r) => r.key === k))));
    toast({ title: done, variant: "success" });
    // Let the rows fold shut, then re-check: an action can clear other flags too.
    if (recheck.current != null) window.clearTimeout(recheck.current);
    recheck.current = window.setTimeout(() => {
      recheck.current = null;
      void load(true);
    }, 220);
    return null;
  }

  function run(row: BoardRow, action: HealthAction) {
    const id = row.scenario.id;
    switch (action) {
      case "drafts":
        return void act({ action: "drafts", ids: [id] }, `Moved "${row.scenario.name}" to drafts. Batches no longer run it.`, [row]);
      case "archive":
        return void act({ action: "archive", ids: [id] }, `Retired "${row.scenario.name}". Restore it from its Status.`, [row]);
      case "dismiss":
        return void act({ action: "dismiss", ids: [id], kind: row.flag.kind }, row.flag.kind === "suspicious" ? "Kept. Batches run it again." : "Dismissed. It stays quiet.", [row]);
      case "rename":
        return setRenaming({ id, name: row.scenario.name });
      case "merge":
        return setMerging(row);
      default:
        return undefined;
    }
  }

  function toggle(keys: string[], on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }


  if (phase === "loading") return <HealthChecking count={scenarios.length || null} />;
  if (phase === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-14 text-center" data-health-error>
        <p className="text-base text-fg">The check could not run.</p>
        <p className="max-w-[460px] text-sm text-muted">{error}</p>
        <Button size="sm" onClick={() => void load(true)} loading={refreshing}>
          Try again
        </Button>
      </div>
    );
  }
  if (!audit || audit.total === 0) return <HealthNoScenarios onMap={onMap} />;

  const renameSubmit = async (name: string) => {
    if (!renaming) return null;
    const row = groups.flatMap((g) => g.rows).filter((r) => r.scenario.id === renaming.id);
    const err = await act({ action: "rename", ids: [renaming.id], name }, `Renamed to "${name}".`, row);
    if (!err) setRenaming(null);
    return err;
  };
  const mergeSubmit = async (into: string) => {
    if (!merging) return null;
    const target = scenarios.find((s) => s.id === into);
    const err = await act({ action: "merge", ids: [merging.scenario.id], into }, `Merged into "${target?.name ?? "the scenario"}".`, [merging]);
    if (!err) setMerging(null);
    return err;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-health-board>
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-4 pb-28 pt-5">
        <header className={`${styles.rise} flex flex-wrap items-start justify-between gap-3`}>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-fg">Scenario health</h1>
            <p className="text-sm text-fg-2" data-health-summary>
              {plural(audit.total, "scenario")} checked{audit.computed_at ? ` ${fmtRelative(audit.computed_at)}` : ""}.{" "}
              {needLook > 0 ? `${plural(needLook, "scenario")} need${needLook === 1 ? "s" : ""} a look.` : "Nothing needs a look."}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void load(true)} loading={refreshing} data-health-recheck>
            <RefreshCw aria-hidden />
            Check again
          </Button>
        </header>

        {groups.length > 0 ? (
          <nav aria-label="Flags" className={`${styles.rise} flex flex-wrap gap-1.5`} style={{ "--i": 1 } as CSSProperties}>
            {groups.map((g) => {
              const Icon = FLAG_ICON[g.kind];
              return (
                <a key={g.kind} href={`#health-${g.kind}`} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-sm text-fg-2 hover:bg-hover" data-health-count={g.kind}>
                  <Icon aria-hidden className="size-3.5 text-muted" strokeWidth={1.75} />
                  {FLAG_LABEL[g.kind].short}
                  <span className="tabular text-fg">{g.rows.length}</span>
                </a>
              );
            })}
          </nav>
        ) : null}

        {open === 0 ? <HealthHealthy total={audit.total} onMap={onMap} /> : null}

        {groups.map((g, gi) => {
          const Icon = FLAG_ICON[g.kind];
          const keys = g.rows.map((r) => r.key);
          const all = keys.every((k) => selected.has(k));
          return (
            <section key={g.kind} id={`health-${g.kind}`} aria-labelledby={`health-h-${g.kind}`} className={`${styles.rise} scroll-mt-4`} style={{ "--i": gi + 2 } as CSSProperties} data-health-group={g.kind}>
              <div className="mb-1.5 flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-3.5 accent-[var(--color-primary)]"
                  checked={all}
                  onChange={(e) => toggle(keys, e.target.checked)}
                  aria-label={`Select every ${FLAG_LABEL[g.kind].short} scenario`}
                />
                <Icon aria-hidden className={cn("mt-0.5 size-4", g.kind === "suspicious" || g.kind === "env_failing" ? "text-warning" : "text-muted")} strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <h2 id={`health-h-${g.kind}`} className="text-sm font-semibold text-fg">
                    {FLAG_LABEL[g.kind].title} <span className="tabular font-normal text-muted">{g.rows.length}</span>
                  </h2>
                  <p className="text-sm text-muted">{FLAG_LABEL[g.kind].blurb}</p>
                </div>
              </div>
              <ul className="overflow-hidden rounded-lg border border-border bg-panel">
                {g.rows.map((row) => (
                  <li key={row.key} className={cn(styles.row, leaving.has(row.key) && styles.leaving)} data-health-row={row.scenario.id} data-health-kind={row.flag.kind}>
                    <div>
                      <div className="flex items-start gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0">
                        <input
                          type="checkbox"
                          className="mt-1 size-3.5 accent-[var(--color-primary)]"
                          checked={selected.has(row.key)}
                          onChange={(e) => toggle([row.key], e.target.checked)}
                          aria-label={`Select ${row.scenario.name}`}
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            <button type="button" onClick={() => onScenario(row.scenario.id)} className="min-w-0 truncate text-left text-sm font-medium text-fg hover:underline" title={row.scenario.name}>
                              {row.scenario.name}
                            </button>
                            {row.scenario.target_kind ? <span className="text-xs text-muted">{PLATFORM[row.scenario.target_kind] ?? row.scenario.target_kind}</span> : null}
                            {row.scenario.status === "draft" ? <span className="text-xs text-muted">draft</span> : null}
                          </div>
                          <p className="text-sm text-fg-2" data-health-reason>
                            {row.flag.reason}
                          </p>
                          <div className="flex flex-wrap items-center gap-1 pt-0.5">
                            {actionsFor(row).map((a, i) => (
                              <RowAction
                                key={a}
                                action={a}
                                primary={i === 0}
                                busy={busy === `${a}:${row.scenario.id}`}
                                onClick={() => (a === "fix_env" ? onApps() : a === "open" ? onScenario(row.scenario.id) : run(row, a))}
                                kind={row.flag.kind}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {kept.length > 0 ? (
          <details className="rounded-lg border border-border bg-panel px-3 py-2" data-health-kept>
            <summary className="cursor-pointer text-sm text-fg-2">Kept by you ({kept.length})</summary>
            <ul className="mt-2 flex flex-col gap-1.5">
              {kept.map((row) => (
                <li key={row.key} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-fg" title={row.flag.reason}>
                    {row.scenario.name}
                  </span>
                  <span className="text-xs text-muted">{FLAG_LABEL[row.flag.kind].short}</span>
                  <Button size="sm" variant="ghost" disabled={!auth.can} onClick={() => void act({ action: "restore", ids: [row.scenario.id], kind: row.flag.kind }, "Flag restored.", [row])} data-health-restore>
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {chosen.length > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className={`${styles.rise} pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-raised px-3 py-2 shadow-[var(--shadow-md)]`} role="toolbar" aria-label="Selected scenarios" data-health-bulk>
            <span className="mr-1 text-sm text-fg">{plural(new Set(chosen.map((r) => r.scenario.id)).size, "scenario")} selected</span>
            <Button size="sm" disabled={!auth.can} onClick={() => void act({ action: "drafts", ids: [...new Set(chosen.map((r) => r.scenario.id))] }, "Moved to drafts.", chosen)} data-health-bulk-action="drafts">
              Move to drafts
            </Button>
            <Button size="sm" disabled={!auth.can} onClick={() => void act({ action: "archive", ids: [...new Set(chosen.map((r) => r.scenario.id))] }, "Retired.", chosen)} data-health-bulk-action="archive">
              Retire
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!auth.can}
              onClick={async () => {
                for (const kind of new Set(chosen.map((r) => r.flag.kind))) {
                  const rows = chosen.filter((r) => r.flag.kind === kind);
                  const err = await act({ action: "dismiss", ids: rows.map((r) => r.scenario.id), kind }, "Dismissed.", rows);
                  if (err) break;
                }
              }}
              data-health-bulk-action="dismiss"
            >
              Dismiss
            </Button>
            <Button size="sm" variant="ghost" icon aria-label="Clear selection" onClick={() => setSelected(new Set())}>
              <X />
            </Button>
          </div>
        </div>
      ) : null}

      <RenameDialog scenario={renaming} onClose={() => setRenaming(null)} onSubmit={renameSubmit} />
      <MergeDialog
        source={merging ? { id: merging.scenario.id, name: merging.scenario.name, target_kind: merging.scenario.target_kind } : null}
        defaultInto={typeof merging?.flag.detail?.duplicate_of === "string" ? merging.flag.detail.duplicate_of : null}
        choices={scenarios}
        onClose={() => setMerging(null)}
        onSubmit={mergeSubmit}
      />
    </div>
  );
}

function RowAction({
  action,
  primary,
  busy,
  onClick,
  kind,
}: {
  action: HealthAction;
  primary: boolean;
  busy: boolean;
  onClick: () => void;
  kind: HealthFlagKind;
}) {
  const label = ACTION_LABEL[action];
  const variant = primary ? "secondary" : "ghost";
  const title = action === "dismiss" ? (kind === "suspicious" ? "This is a real scenario: keep it and run it in batches" : "This is fine: stop flagging it") : undefined;
  const local = action === "fix_env" || action === "open";
  const button = (
    <Button size="sm" variant={variant} loading={busy} onClick={onClick} title={title} data-health-action={action}>
      {label}
    </Button>
  );
  return local ? button : <HumanGate>{button}</HumanGate>;
}

