import { useState, type ReactElement } from "react";
import { Tooltip } from "../../../../components/primitives";
import { useSnapshot } from "../../../../state/SnapshotProvider";
import { Check, Plus, RotateCcw, X } from "../../map/kit/icons";
import { Button, Dialog, Field, Input, Select, SeverityTag, useToast, plural } from "../../map/kit";
import type { QaAuthority } from "../../authority";
import { dismissFinding, fileFinding, reopenFinding, splitWebEvents, type QaFinding, type WebEvent } from "../../qaApi";
import { findingStatusWord, webEventWord } from "../../qaWords";
import { errText, TaskLink } from "../../parts";
import { TriageButtons } from "../../triage/TriageActions";
import type { Severity } from "../explorations";
import type { FindingScenarios } from "../findings/finding-scenario-button";

/** What a finding can have done to it, and who may. */
export interface FindingActions {
  auth: QaAuthority;
  onChanged: () => void;
  /** Create scenario on a finding: the drafted ones, and `create` for another. */
  scenarios?: FindingScenarios;
  /** The session and its platform: what a draft links back to and runs on. */
  explorationId: string;
  platform: string | null;
}

export function FindingSeverity({ severity, className }: { severity: Severity; className?: string }) {
  return <SeverityTag severity={severity} className={className} />;
}

/** A web finding's page events (console errors, page errors, failed requests, 5xx), in plain words. */
export function WebEvents({ events }: { events: readonly WebEvent[] }) {
  if (!events.length) return null;
  return (
    <section className="flex flex-col gap-1.5" data-finding-events>
      <h4 className="text-xs font-medium text-muted">{plural(events.length, "page event")}</h4>
      <ul className="flex flex-col gap-0.5 rounded-md border border-border bg-panel-2 p-2" aria-label="Page events">
        {events.map((e, i) => (
          <li key={i} className="flex min-w-0 items-baseline gap-2 text-xs" data-web-event={e.kind}>
            <span className={e.kind === "console" && /warn/i.test(e.text) ? "shrink-0 font-medium text-fg-2" : "shrink-0 font-medium text-danger"}>{webEventWord(e)}</span>
            <span className="min-w-0 break-words font-mono text-2xs text-fg-2">{e.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FindingEvents({ finding }: { finding: QaFinding }) {
  return <WebEvents events={splitWebEvents(finding.detail, finding.events).events} />;
}

/** File as task, Dismiss and Reopen: a person's call, so anyone else sees why they cannot. */
export function FindingButtons({ finding: f, actions, primary = false }: { finding: QaFinding; actions: FindingActions; primary?: boolean }) {
  const { auth, onChanged } = actions;
  const { toast } = useToast();
  const [filing, setFiling] = useState(false);
  const [busy, setBusy] = useState(false);
  const change = async (to: "dismiss" | "reopen") => {
    setBusy(true);
    try {
      await (to === "dismiss" ? dismissFinding : reopenFinding)(f.id, auth.human?.id ?? null);
      toast({ title: to === "dismiss" ? "Finding dismissed." : "Finding reopened." });
      onChanged();
    } catch (e) {
      toast({ title: `Could not ${to} the finding`, description: errText(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  };
  const triage = <TriageButtons finding={f} auth={auth} onChanged={onChanged} />;
  const gate = (node: ReactElement, key: string) => (auth.can ? node : <Tooltip key={key} label={auth.reason || "Only a person can file or dismiss"} placement="bottom">{node}</Tooltip>);
  return (
    <>
      {f.status === "filed" && f.filed_task_id ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-fg-2" data-finding-filed>
          <Check aria-hidden className="size-3 shrink-0 text-success" strokeWidth={2.5} />
          <TaskLink id={f.filed_task_id} title={f.filed_task_title} />
        </span>
      ) : f.status === "open" ? (
        <>
          {gate(<Button size="sm" variant={primary ? "primary" : "default"} disabled={!auth.can} onClick={() => setFiling(true)} data-file-finding><Plus /> File as task</Button>, "f")}
          {gate(<Button size="sm" variant="ghost" disabled={!auth.can} loading={busy} onClick={() => void change("dismiss")} data-dismiss-finding><X /> Dismiss</Button>, "d")}
          {triage}
        </>
      ) : f.status === "dismissed" ? (
        <>
          <span className="text-xs text-muted">{findingStatusWord(f.status)}</span>
          {gate(<Button size="sm" variant="ghost" disabled={!auth.can} loading={busy} onClick={() => void change("reopen")} data-reopen-finding><RotateCcw /> Reopen</Button>, "r")}
        </>
      ) : null}
      {filing ? <FileDialog f={f} auth={auth} onClose={() => setFiling(false)} onFiled={() => { setFiling(false); onChanged(); }} /> : null}
    </>
  );
}

const UNASSIGNED = "__none__";

/** A task from a finding: its title and who works it. Plan approval and verification apply as usual. */
function FileDialog({ f, auth, onClose, onFiled }: { f: QaFinding; auth: QaAuthority; onClose: () => void; onFiled: () => void }) {
  const { toast } = useToast();
  const { snap } = useSnapshot();
  const agents = (snap?.agents ?? []).filter((a) => a.kind !== "human" && a.status !== "retired");
  const [title, setTitle] = useState(f.title);
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!title.trim()) {
      setErr("Give the task a title.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await fileFinding(f.id, auth.human?.id ?? null, { title: title.trim(), assignee_agent_id: assignee === UNASSIGNED ? null : assignee });
      toast({ title: "Task created from the finding." });
      onFiled();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="File as task"
      description="Creates a normal task with this finding (expected, actual and screenshots) as its context. Plan approval and verification apply as usual."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>Create task</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Title">
          <Input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }} />
        </Field>
        <Field label="Assignee">
          <Select value={assignee} aria-label="Assignee" onChange={(e) => setAssignee(e.target.value)} options={[{ value: UNASSIGNED, label: "Unassigned, normal assignment" }, ...agents.map((a) => ({ value: a.id, label: a.alias }))]} />
        </Field>
        {err ? <p role="alert" className="text-sm text-danger">{err}</p> : null}
      </div>
    </Dialog>
  );
}
