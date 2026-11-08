import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Archive, PauseCircle } from "../map/kit/icons";
import { useSnapshot } from "../../../state/SnapshotProvider";
import { Button, Input, Select, StatusGlyph, cn, useToast } from "../map/kit";
import { errText } from "../parts";
import type { QaScenario } from "../qaApi";
import { changeStatus } from "./api";
import { HumanGate, useScenarios } from "./context";
import {
  EFFECTIVE_STATUSES,
  NEEDS_REASON,
  STATUS_LABEL,
  STATUS_MEANING,
  effectiveStatus,
  isRetired,
  statusDetail,
  todayIso,
  type EffectiveStatus,
  type StatusRow,
} from "./scenario-status";
import type { Scenario } from "./adapt";

/**
 * The scenario lifecycle status (`scenario-status.ts`) in the UI: an icon and
 * a tone per status, a pill (reason on hover), and the panel's Status menu with its inline form.
 * Each status has its own shape, so it is never colour alone; the tones are theme tokens, so
 * light and dark both work.
 */

const TONE: Record<EffectiveStatus, string> = {
  draft: "text-muted",
  validated: "text-success",
  quarantined: "text-warning",
  paused: "text-info",
  retired: "text-muted",
};

/** The status's 14px icon (decorative: the label always sits beside it). */
export function ScenarioStatusIcon({ status, className }: { status: EffectiveStatus; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (status) {
    case "draft":
      return <StatusGlyph status="pending" decorative className={cls} />;
    case "validated":
      return <StatusGlyph status="pass" decorative className={cls} />;
    case "quarantined":
      return <StatusGlyph status="flaky" decorative className={cls} />;
    case "paused":
      return <PauseCircle aria-hidden strokeWidth={1.75} className={cn(cls, TONE.paused)} />;
    case "retired":
      return <Archive aria-hidden strokeWidth={1.75} className={cn(cls, TONE.retired)} />;
  }
}

/** "Paused: Flag off until 2026-11-01" for a title / tooltip. */
export function statusTitle(s: StatusRow): string {
  const e = effectiveStatus(s);
  const detail = statusDetail(s);
  return `${STATUS_LABEL[e]}${detail ? `: ${detail}` : ""}. ${STATUS_MEANING[e]}`;
}

/** The status as a small pill; its reason and meaning on hover. Re-animates when it changes. */
export function ScenarioStatusPill({ scenario, className }: { scenario: StatusRow; className?: string }) {
  const e = effectiveStatus(scenario);
  return (
    <span
      key={e}
      title={statusTitle(scenario)}
      data-scenario-status-pill={e}
      className={cn(
        "inline-flex h-[18px] max-w-full shrink-0 animate-fade-in items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none motion-reduce:animate-none",
        e === "draft" ? "border-dashed border-border-strong text-muted" : "border-border text-fg-2",
        e === "paused" && "border-info/30 bg-info/10 text-info",
        e === "retired" && "text-muted line-through decoration-muted/50",
        className,
      )}
    >
      <ScenarioStatusIcon status={e} className="size-3" />
      <span className="truncate">{STATUS_LABEL[e]}</span>
    </span>
  );
}

export interface StatusChangeBody {
  status: EffectiveStatus;
  reason?: string | null;
  until?: string | null;
  issue?: string | null;
  replaced_by?: string | null;
}

/** The menu's options: icon, label and the one-line meaning. */
export function statusOptions(current?: EffectiveStatus) {
  return EFFECTIVE_STATUSES.map((s) => ({
    value: s,
    label: STATUS_LABEL[s],
    textValue: STATUS_LABEL[s],
    icon: <ScenarioStatusIcon status={s} />,
    description: STATUS_MEANING[s],
    hint: s === current ? "now" : undefined,
  }));
}

/** A nudge from the scenario's health toward a status ("Flaky lately: quarantine it?"). */
export function healthHint(status: EffectiveStatus, health: Scenario["health"] | null | undefined): { text: string; suggest: EffectiveStatus } | null {
  if (status === "validated" && health === "flaky") return { text: "Flaky in its recent runs.", suggest: "quarantined" };
  if (status === "validated" && health === "failing") return { text: "Failing in its recent runs. A known bug?", suggest: "paused" };
  return null;
}

type IssueOption = { id: string; title: string };

/** The project's open tasks for "Resume when … closes" (the scenario's own first). */
function useOpenTasks(enabled: boolean, ownTask: string | null | undefined): IssueOption[] {
  const { snap } = useSnapshot();
  if (!enabled) return [];
  const open = (snap?.tasks ?? []).filter((t) => t.status !== "completed" && t.status !== "cancelled").map((t) => ({ id: t.id, title: t.title }));
  return [...open.filter((t) => t.id === ownTask), ...open.filter((t) => t.id !== ownTask)].slice(0, 50);
}

const GITHUB = "__github";

/**
 * The inline form a Paused, Quarantined or Retired choice opens: a reason (required); for
 * Paused, an until date and/or an issue to wait on; for Retired, what replaced it.
 */
export function StatusReasonForm({
  status,
  initial,
  scenarioId,
  others = [],
  ownTask,
  busy = false,
  onSubmit,
  onCancel,
}: {
  status: Exclude<EffectiveStatus, "draft" | "validated">;
  initial?: Partial<StatusChangeBody>;
  scenarioId: string;
  /** Scenarios that can replace it (Retired). */
  others?: readonly Pick<Scenario, "id" | "name">[];
  /** The task it came from: first in "or when this closes". */
  ownTask?: string | null;
  busy?: boolean;
  onSubmit: (body: StatusChangeBody) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState(initial?.reason ?? (status === "quarantined" ? "Flaky" : ""));
  const [until, setUntil] = useState(initial?.until ?? "");
  const initialIssue = initial?.issue ?? "";
  const [issueChoice, setIssueChoice] = useState(initialIssue ? (/^[0-9a-f-]{36}$/i.test(initialIssue) ? initialIssue : GITHUB) : "");
  const [githubRef, setGithubRef] = useState(/^[0-9a-f-]{36}$/i.test(initialIssue) ? "" : initialIssue);
  const [replacedBy, setReplacedBy] = useState(initial?.replaced_by ?? "");
  const [touched, setTouched] = useState(false);
  const issues = useOpenTasks(status === "paused", ownTask);
  const reasonRef = useRef<HTMLInputElement>(null);
  useEffect(() => reasonRef.current?.focus(), []);

  const missingReason = !reason.trim();
  // The earliest "Resume on": tomorrow, fixed when the form opens.
  const [tomorrow] = useState(() => todayIso(new Date(Date.now() + 86_400_000)));
  const issue = issueChoice === GITHUB ? githubRef.trim() : issueChoice;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (missingReason || busy) return;
    onSubmit({
      status,
      reason: reason.trim(),
      ...(status === "paused" ? { until: until || null, issue: issue || null } : {}),
      ...(status === "retired" ? { replaced_by: replacedBy || null } : {}),
    });
  }

  const lead: Record<typeof status, string> = {
    paused: "Skipped by check runs until it resumes. A person can still pick it.",
    quarantined: "Still runs and reports; a failure never fails a check until it passes cleanly again.",
    retired: "Never runs again and leaves the default lists. Restore it any time.",
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      aria-label={`${STATUS_LABEL[status]}: details`}
      data-status-form={status}
      className="flex animate-slide-up flex-col gap-2 rounded-md border border-border bg-panel-2 p-2.5 motion-reduce:animate-none"
    >
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <ScenarioStatusIcon status={status} className="size-3" />
        {lead[status]}
      </p>
      <label htmlFor={`${id}-reason`} className="flex flex-col gap-1 text-xs text-muted">
        Reason
        <Input
          ref={reasonRef}
          id={`${id}-reason`}
          dimension="sm"
          value={reason}
          maxLength={300}
          placeholder={status === "paused" ? "Checkout bug, flag off, staging down…" : status === "retired" ? "Feature removed, replaced…" : "Flaky on slow networks…"}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={touched && missingReason ? true : undefined}
          aria-describedby={touched && missingReason ? `${id}-reason-error` : undefined}
          data-status-reason
        />
      </label>
      {touched && missingReason ? (
        <p id={`${id}-reason-error`} role="alert" className="-mt-1 text-xs text-danger" data-status-reason-error>
          Say why, so whoever sees it skipped knows.
        </p>
      ) : null}
      {status === "paused" ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label htmlFor={`${id}-until`} className="flex flex-col gap-1 text-xs text-muted">
            Resume on
            <Input id={`${id}-until`} type="date" dimension="sm" min={tomorrow} value={until} onChange={(e) => setUntil(e.target.value)} data-status-until />
          </label>
          <div className="flex flex-col gap-1 text-xs text-muted">
            <span id={`${id}-issue-label`}>or when this closes</span>
            <Select
              dimension="sm"
              aria-labelledby={`${id}-issue-label`}
              value={issueChoice}
              onChange={(e) => setIssueChoice(e.target.value)}
              data-status-issue
              options={[
                { value: "", label: "No issue" },
                ...issues.map((i) => ({ value: i.id, label: i.title, textValue: i.title, group: "Tasks" })),
                { value: GITHUB, label: "A GitHub issue…", group: "GitHub" },
              ]}
            />
            {issueChoice === GITHUB ? (
              <Input
                dimension="sm"
                aria-label="GitHub issue"
                placeholder="#42 or owner/repo#42"
                value={githubRef}
                onChange={(e) => setGithubRef(e.target.value)}
                className="animate-fade-in motion-reduce:animate-none"
                data-status-github
              />
            ) : null}
            {issueChoice === GITHUB ? <span className="text-[11px] text-muted">A person resumes it: the portal does not read GitHub.</span> : null}
          </div>
        </div>
      ) : null}
      {status === "retired" ? (
        <div className="flex flex-col gap-1 text-xs text-muted">
          <span id={`${id}-replaced-label`}>Replaced by</span>
          <Select
            dimension="sm"
            aria-labelledby={`${id}-replaced-label`}
            value={replacedBy}
            onChange={(e) => setReplacedBy(e.target.value)}
            data-status-replaced-by
            options={[{ value: "", label: "Nothing" }, ...others.filter((o) => o.id !== scenarioId).map((o) => ({ value: o.id, label: o.name, textValue: o.name }))]}
          />
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} data-status-cancel>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" loading={busy} data-status-submit>
          {status === "paused" ? "Pause" : status === "quarantined" ? "Quarantine" : "Retire"}
        </Button>
      </div>
    </form>
  );
}

/**
 * The scenario panel's Status row: a dropdown of the five statuses (icon, colour, one-line
 * meaning). Draft and Validated apply at once; Paused, Quarantined and Retired open the inline
 * form first. Saves straight away (`POST /api/scenarios/status`), like the Platform row.
 */
export function ScenarioStatusControl({
  scenario,
  others = [],
  onChanged,
}: {
  scenario: Scenario;
  others?: readonly (Pick<Scenario, "id" | "name"> & Partial<Pick<Scenario, "status">>)[];
  onChanged: (row: QaScenario) => void;
}) {
  const { toast } = useToast();
  const { cid, auth } = useScenarios();
  const current = effectiveStatus(scenario);
  const [pending, setPending] = useState<Exclude<EffectiveStatus, "draft" | "validated"> | null>(null);
  const [busy, setBusy] = useState(false);
  const hint = healthHint(current, scenario.health);
  const detail = statusDetail(scenario);

  async function apply(body: StatusChangeBody) {
    if (!auth.can) return;
    setBusy(true);
    try {
      const rows = await changeStatus(cid, auth.human?.id ?? null, [scenario.id], body);
      setPending(null);
      if (rows[0]) onChanged(rows[0]);
      toast({ title: `${STATUS_LABEL[body.status]}`, description: body.reason ?? undefined, variant: "success" });
    } catch (e) {
      toast({ title: "Could not change the status", description: errText(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function choose(next: EffectiveStatus) {
    if (next === current && !NEEDS_REASON.has(next)) return;
    if (NEEDS_REASON.has(next)) setPending(next as Exclude<EffectiveStatus, "draft" | "validated">);
    else void apply({ status: next });
  }

  const initial: Partial<StatusChangeBody> | undefined =
    pending && pending === current
      ? { reason: current === "quarantined" ? scenario.quarantine_reason : scenario.status_reason, until: scenario.status_until, issue: scenario.status_issue, replaced_by: scenario.replaced_by }
      : undefined;

  return (
    <div className="flex flex-col gap-1.5" data-scenario-status-control={current}>
      <HumanGate>
        <Select
          aria-label="Status"
          value={pending ?? current}
          disabled={busy || !auth.can}
          onChange={(e) => choose(e.target.value as EffectiveStatus)}
          options={statusOptions(current)}
          className="max-w-[260px]"
          menuClassName="min-w-[300px]"
          renderValue={(o) => <span className="truncate text-fg">{o?.label}</span>}
          data-scenario-status={current}
        />
      </HumanGate>
      {detail && !pending ? (
        <p className="animate-fade-in truncate text-xs text-muted motion-reduce:animate-none" title={statusTitle(scenario)} data-status-detail>
          {detail}
          {current === "retired" && scenario.replaced_by ? <ReplacedBy id={scenario.replaced_by} others={others} /> : null}
        </p>
      ) : null}
      {hint && !pending ? (
        <p className="flex animate-fade-in items-center gap-1.5 text-xs text-muted motion-reduce:animate-none" data-status-hint={hint.suggest}>
          {hint.text}
          <Button size="sm" variant="link" disabled={!auth.can} onClick={() => choose(hint.suggest)}>
            {hint.suggest === "quarantined" ? "Quarantine it?" : "Pause it?"}
          </Button>
        </p>
      ) : null}
      {pending ? (
        <StatusReasonForm
          key={pending}
          status={pending}
          initial={initial}
          scenarioId={scenario.id}
          others={others.filter((o) => !isRetired(o))}
          ownTask={scenario.task_id}
          busy={busy}
          onSubmit={(body) => void apply(body)}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

function ReplacedBy({ id, others }: { id: string; others: readonly Pick<Scenario, "id" | "name">[] }): ReactNode {
  const name = others.find((o) => o.id === id)?.name;
  return name ? <span> · replaced by {name}</span> : null;
}
