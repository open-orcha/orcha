import { useId, useState } from "react";
import { Check, Pencil, Scale, UserRound } from "../../map/kit/icons";
import { Button } from "../../map/kit";
import { SeverityTag } from "../../map/kit";
import { Dialog } from "../../map/kit";
import { useToast } from "../../map/kit";
import {
  DIMENSION_LABELS,
  displayReason,
  LEVEL_HINTS,
  LEVELS,
  severityLine,
  severityText,
  type Level,
  type SeverityFields,
} from "../findings/severity-review";
import { errText } from "../../parts";
import { severityOf } from "../adapt";
import { setFindingSeverity } from "../api";
import type { FindingActions } from "../detail/finding-actions";
import type { Severity } from "../explorations";
import { cn } from "../../map/kit";

function pick(f: SeverityFields): SeverityFields {
  return {
    severity: f.severity,
    severity_reported: f.severity_reported ?? null,
    severity_by: f.severity_by ?? "explorer",
    severity_reason: f.severity_reason ?? null,
    severity_review: f.severity_review ?? null,
  };
}

function fieldsKey(f: SeverityFields): string {
  return JSON.stringify(pick(f));
}

/** A finding's severity as it stands, and kept current after a person changes it here. */
export function useFindingSeverity(initial: SeverityFields) {
  const [fields, setFields] = useState<SeverityFields>(() => pick(initial));
  const key = fieldsKey(initial);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    // The page read the finding again with something new: adopt it.
    setSeen(key);
    setFields(pick(initial));
  }
  return [fields, setFields] as const;
}

/**
 * The severity badge, as a control: it shows the final severity and opens the change dialog. While
 * the review runs it shimmers (the rating may still move).
 */
export function SeverityBadge({
  fields,
  onOpen,
  className,
}: {
  fields: SeverityFields;
  onOpen?: () => void;
  className?: string;
}) {
  const line = severityLine(fields);
  const reviewing = line.state === "reviewing";
  const tag = <SeverityTag severity={fields.severity} className={cn(reviewing && "animate-pulse motion-reduce:animate-none")} />;
  if (!onOpen) return <span className={className}>{tag}</span>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group/sev relative inline-flex shrink-0 items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      aria-label={`Severity ${fields.severity}${line.who ? `, set by ${line.who}` : ""}. Change severity`}
      aria-haspopup="dialog"
      data-severity-change
      data-severity={fields.severity}
      data-severity-by={fields.severity_by ?? "explorer"}
    >
      {tag}
      <Pencil aria-hidden className="size-3 text-muted opacity-0 transition-opacity group-hover/sev:opacity-100 group-focus-visible/sev:opacity-100 motion-reduce:transition-none" />
    </button>
  );
}

/**
 * The line under a finding's title that says where its severity comes from: "major · Orcha:
 * the agent stays blocked with no way out (the explorer said minor)", a person's call, or, while
 * the review runs, a live "rating" state. Nothing for a finding from before the review.
 */
export function SeverityNote({ fields, className }: { fields: SeverityFields; className?: string }) {
  const line = severityLine(fields);
  const text = severityText(line);
  if (!text) return null;
  if (line.state === "reviewing") {
    return (
      <p role="status" className={cn("flex items-center gap-2 text-xs text-fg-2", className)} data-severity-note="reviewing">
        <span aria-hidden className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-accent" />
        </span>
        <span>{text}</span>
        <span aria-hidden className="relative h-1 w-16 overflow-hidden rounded-full bg-hover">
          <span className="animate-sweep absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/60 motion-reduce:animate-none" />
        </span>
      </p>
    );
  }
  if (line.state === "skipped") {
    return (
      <p className={cn("text-xs text-muted", className)} data-severity-note="skipped">
        {text}
      </p>
    );
  }
  const Icon = line.state === "person" ? UserRound : Scale;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-2 v-fade", className)} data-severity-note={line.state}>
      <span className="inline-flex min-w-0 items-start gap-1.5">
        <Icon aria-hidden className="mt-[2px] size-3 shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="font-medium text-fg">{line.severity}</span>
          <span className="text-muted"> · </span>
          <span className="font-medium text-fg">{line.who}</span>
          {line.reason ? <span className="select-text">: {displayReason(line)}</span> : null}
          {line.explorerSaid ? (
            <span className="text-muted" data-explorer-said={line.explorerSaid}>
              {" "}(the explorer said {line.explorerSaid})
            </span>
          ) : null}
        </span>
      </span>
      {line.dimensions.length ? (
        <span className="flex flex-wrap gap-1" aria-label="What decided it">
          {line.dimensions.map((d) => (
            <span key={d} className="rounded-full border border-border px-1.5 py-px text-[11px] leading-4 text-muted" data-severity-dimension={d}>
              {DIMENSION_LABELS[d]}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** Change a finding's severity: a person's call becomes the final one, and the explorer's stays beside it. */
export function SeverityDialog({
  open,
  onClose,
  findingId,
  actions,
  fields,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  findingId: string;
  actions: FindingActions;
  fields: SeverityFields;
  onSaved: (fields: SeverityFields) => void;
}) {
  const { toast } = useToast();
  const current = (LEVELS as readonly Severity[]).includes(fields.severity) ? (fields.severity as Level) : "minor";
  const [picked, setPicked] = useState<Level>(current);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const reasonId = useId();
  const line = severityLine(fields);

  async function save() {
    setSaving(true);
    try {
      const row = await setFindingSeverity(findingId, actions.auth.human?.id ?? null, picked === "cosmetic" ? "trivial" : picked, reason.trim() || null);
      onSaved({
        severity: severityOf(row.severity),
        severity_reported: row.severity_reported ? severityOf(row.severity_reported) : null,
        severity_by: row.severity_by === "person" ? "person" : "explorer",
        severity_reason: row.severity_reason ?? null,
      });
      toast({ title: `Severity set to ${picked}`, variant: "success" });
      onClose();
      actions.onChanged();
    } catch (e) {
      toast({ title: "Could not set the severity", description: errText(e), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change severity"
      description="Your call becomes the final severity. What the explorer said stays beside it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || (picked === fields.severity && !reason.trim())} data-severity-save>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-severity-dialog>
        {line.who || line.explorerSaid ? (
          <p className="rounded-md border border-border bg-panel-2 px-3 py-2 text-xs text-fg-2" data-severity-dialog-now>
            Now: {severityText(line)}
          </p>
        ) : null}
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 text-xs font-medium text-muted">Severity</legend>
          {LEVELS.map((level) => {
            const on = picked === level;
            return (
              <label
                key={level}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors motion-reduce:transition-none",
                  on ? "border-border-strong bg-hover" : "border-border hover:bg-hover",
                )}
                data-severity-option={level}
              >
                <input
                  type="radio"
                  name={`severity-${findingId}`}
                  value={level}
                  checked={on}
                  onChange={() => setPicked(level)}
                  className="sr-only"
                />
                <SeverityTag severity={level} className="mt-px w-[68px] justify-center" />
                <span className="min-w-0 flex-1 text-xs leading-5 text-fg-2">{LEVEL_HINTS[level]}</span>
                {on ? <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg" /> : null}
                {fields.severity_reported === level && fields.severity_reported !== fields.severity ? (
                  <span className="shrink-0 text-[11px] text-muted">explorer</span>
                ) : null}
              </label>
            );
          })}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={reasonId} className="text-xs font-medium text-muted">
            Why (optional)
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={400}
            rows={2}
            placeholder="The agent stays blocked with no way out"
            className="min-h-[56px] w-full resize-y rounded-md border border-border bg-panel px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-severity-reason
          />
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Everything a card needs to show and change a finding's severity: the current fields, an `open`
 * for the badge, and the dialog to render once. `run` is the finding; without one (a measured
 * finding) the badge shows `fallback` and changes nothing. Changing it is a person's call, so
 * anyone else gets the badge alone.
 */
export function useSeverityControl(run: (SeverityFields & { id: string }) | null, fallback: Severity, actions: FindingActions) {
  const [fields, setFields] = useFindingSeverity(run ?? { severity: fallback });
  const [open, setOpen] = useState(false);
  const can = !!run && actions.auth.can;
  const dialog = run && can && open ? <SeverityDialog open={open} onClose={() => setOpen(false)} findingId={run.id} actions={actions} fields={fields} onSaved={setFields} /> : null;
  return { fields, open: can ? () => setOpen(true) : undefined, dialog };
}
