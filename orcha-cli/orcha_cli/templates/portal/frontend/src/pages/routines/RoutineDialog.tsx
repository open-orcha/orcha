/**
 * Create / edit a routine: template fields, assignee, priority, schedule presets with a
 * live plain-English preview ("Every weekday at 09:00 Nairobi time") and the next fire
 * times as the SERVER computes them (/routines/preview — same code the scheduler runs).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Dialog, HelpTip, Segmented } from "../../components/primitives";
import { Icon } from "../../components/ui";
import { shortId } from "../../lib/format";
import type { Agent } from "../../types";
import { PRIORITY_BUCKETS, priorityBucket } from "../tasks/taskQuery";
import type { Routine, RoutineInput, SchedulePreview } from "./routinesApi";
import { previewSchedule } from "./routinesApi";
import {
  DAY_NAMES, DEFAULT_FORM, PRESETS, browserZone, describeSchedule, formatInZone, fromCron, timeZones, toCron,
  type Preset, type ScheduleForm,
} from "./schedule";

export interface RoutineDialogProps {
  cid: string;
  routine: Routine | null; // null = create
  agents: Agent[];
  busy: boolean;
  error: string | null;
  onSubmit: (body: RoutineInput) => void;
  onClose: () => void;
  /** create only: pre-filled template fields (e.g. "Make recurring…" copies a task) */
  initial?: Partial<RoutineInput>;
  /** create only: the task the routine is copied from — shown as "Copy of task #…" */
  origin?: { taskId: string; title: string } | null;
  /** dialog title override (default "New routine" / "Edit routine") */
  heading?: string;
}

const TOKENS_TIP = "Use {{date}}, {{time}} or {{weekday}} in the title, description or definition of done — they're filled in with the run's date in the routine's timezone.";

export function RoutineDialog({ cid, routine, agents, busy, error, onSubmit, onClose, initial, origin, heading }: RoutineDialogProps) {
  const init = routine ? null : initial ?? null;
  const ids = { title: useId(), desc: useId(), dod: useId(), asg: useId(), prio: useId(), tz: useId(), time: useId(), extra: useId(), cron: useId() };
  const [title, setTitle] = useState(routine?.title ?? init?.title ?? "");
  const [description, setDescription] = useState(routine?.description ?? init?.description ?? "");
  const [dod, setDod] = useState(routine?.definition_of_done ?? init?.definition_of_done ?? "");
  const [assignee, setAssignee] = useState<string>(routine?.assignee_agent_id ?? init?.assignee_agent_id ?? "");
  const [priority, setPriority] = useState<number>(routine?.priority ?? init?.priority ?? 100);
  const [form, setForm] = useState<ScheduleForm>(() => (routine ? fromCron(routine.cron) : DEFAULT_FORM));
  const [tz, setTz] = useState<string>(routine?.timezone ?? browserZone());
  const [enabled, setEnabled] = useState<boolean>(routine?.enabled ?? true);
  const [skipIfOpen, setSkipIfOpen] = useState<boolean>(routine?.skip_if_open ?? true);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const cron = toCron(form);
  const zones = useMemo(() => {
    const all = timeZones();
    return all.includes(tz) ? all : [tz, ...all];
  }, [tz]);
  const aiAgents = agents.filter((a) => a.kind === "ai" && a.status !== "retired" && a.status !== "terminated");
  const assigneeGone = !!routine?.assignee_agent_id && !aiAgents.some((a) => a.id === routine.assignee_agent_id);

  // Server preview, debounced; responses for a superseded schedule are dropped.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      previewSchedule(cid, cron, tz).then(
        (p) => { if (live) setPreview(p); },
        () => { if (live) setPreview(null); },
      );
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [cid, cron, tz]);

  const previewMatches = preview != null;
  const invalid = previewMatches && !preview.valid;
  const text = previewMatches && preview.valid && preview.schedule_text ? preview.schedule_text : describeSchedule(cron, tz);
  const canSubmit = title.trim() !== "" && dod.trim() !== "" && !invalid && !busy;

  const setPreset = (p: string) => setForm((f) => ({ ...f, preset: p as Preset, cron: p === "advanced" ? toCron(f) : f.cron }));

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() ? description : null,
      definition_of_done: dod,
      assignee_agent_id: assignee || null,
      priority,
      cron,
      timezone: tz,
      enabled,
      skip_if_open: skipIfOpen,
    });
  };

  return (
    <Dialog
      title={heading ?? (routine ? "Edit routine" : "New routine")}
      onClose={onClose}
      size="lg"
      initialFocus={titleRef}
      className="rt-dialog"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!canSubmit} onClick={submit}>
            {routine ? "Save routine" : "Create routine"}
          </Button>
        </>
      }
    >
      <form className="rt-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {origin && !routine ? (
          <p className="rt-origin rt-origin-note">
            <Icon name="copy" cls="v2-ico" />
            <span>A copy of task <span className="tnum" title={origin.taskId}>#{shortId(origin.taskId)}</span> as a template — the task itself isn't changed.</span>
          </p>
        ) : null}
        <div className="rt-field">
          <div className="rt-labelrow">
            <label htmlFor={ids.title} className="rt-label">Task title</label>
            <HelpTip tip={TOKENS_TIP} label="Template tokens" />
          </div>
          <input id={ids.title} ref={titleRef} className="rt-input" value={title} maxLength={200}
            placeholder="Weekly dependency audit — {{date}}" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="rt-field">
          <label htmlFor={ids.desc} className="rt-label">Description</label>
          <textarea id={ids.desc} className="rt-input rt-textarea" rows={3} value={description} maxLength={3500}
            placeholder="What should happen each time" onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="rt-field">
          <label htmlFor={ids.dod} className="rt-label">Definition of done</label>
          <textarea id={ids.dod} className="rt-input rt-textarea" rows={2} value={dod} maxLength={4000}
            placeholder="How a reviewer knows it's finished" onChange={(e) => setDod(e.target.value)} />
        </div>
        <div className="rt-grid2">
          <div className="rt-field">
            <label htmlFor={ids.asg} className="rt-label">Assignee</label>
            <select id={ids.asg} className="rt-input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned — normal assignment</option>
              {assigneeGone && routine?.assignee_agent_id ? (
                <option value={routine.assignee_agent_id}>{(routine.assignee_alias || "unknown agent") + " (retired)"}</option>
              ) : null}
              {aiAgents.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}
            </select>
          </div>
          <div className="rt-field">
            <label htmlFor={ids.prio} className="rt-label">Priority</label>
            <select id={ids.prio} className="rt-input" value={String(priority)} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITY_BUCKETS.map((b) => <option key={b.k} value={String(b.value)}>{b.label}</option>)}
              {!PRIORITY_BUCKETS.some((b) => b.value === priority) ? (
                <option value={String(priority)}>{priorityBucket(priority).label} ({priority})</option>
              ) : null}
            </select>
          </div>
        </div>

        <fieldset className="rt-fieldset">
          <legend className="rt-label">Schedule</legend>
          <Segmented label="Repeat" size="sm" value={form.preset} onChange={setPreset}
            items={PRESETS.map((p) => ({ key: p.key, label: p.label }))} />
          <div className="rt-schedrow">
            {form.preset === "hourly" ? (
              <label className="rt-inline" htmlFor={ids.extra}>
                at minute
                <input id={ids.extra} className="rt-input rt-num" type="number" min={0} max={59} value={form.minute}
                  onChange={(e) => setForm((f) => ({ ...f, minute: Number(e.target.value) }))} />
              </label>
            ) : null}
            {form.preset === "weekly" ? (
              <label className="rt-inline" htmlFor={ids.extra}>
                on
                <select id={ids.extra} className="rt-input" value={form.weekday}
                  onChange={(e) => setForm((f) => ({ ...f, weekday: Number(e.target.value) }))}>
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{DAY_NAMES[d]}</option>)}
                </select>
              </label>
            ) : null}
            {form.preset === "monthly" ? (
              <label className="rt-inline" htmlFor={ids.extra}>
                on day
                <select id={ids.extra} className="rt-input" value={form.monthDay}
                  onChange={(e) => setForm((f) => ({ ...f, monthDay: Number(e.target.value) }))}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            ) : null}
            {form.preset !== "hourly" && form.preset !== "advanced" ? (
              <label className="rt-inline" htmlFor={ids.time}>
                at
                <input id={ids.time} className="rt-input rt-time" type="time" value={form.time}
                  onChange={(e) => setForm((f) => ({ ...f, time: e.target.value || f.time }))} />
              </label>
            ) : null}
            {form.preset === "advanced" ? (
              <label className="rt-inline rt-grow" htmlFor={ids.cron}>
                cron
                <input id={ids.cron} className="rt-input rt-mono" value={form.cron} spellCheck={false} data-dictation="off"
                  placeholder="minute hour day month weekday" aria-describedby={ids.cron + "-h"}
                  onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))} />
              </label>
            ) : null}
            <label className="rt-inline rt-grow" htmlFor={ids.tz}>
              timezone
              <select id={ids.tz} className="rt-input" value={tz} onChange={(e) => setTz(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
              </select>
            </label>
          </div>
          {form.preset === "advanced" ? (
            <p id={ids.cron + "-h"} className="rt-hint">5 fields on the local clock: minute hour day-of-month month day-of-week. At most one run every 15 minutes.</p>
          ) : null}
          <div className={"rt-preview" + (invalid ? " is-invalid" : "")} role="status" aria-live="polite">
            {invalid ? (
              <span>{preview?.error}</span>
            ) : (
              <>
                <span className="rt-preview-text">{text}</span>
                {preview?.valid && preview.next_runs.length ? (
                  <span className="rt-preview-next">Next: {preview.next_runs.map((r) => formatInZone(r, tz)).join(" · ")}</span>
                ) : null}
              </>
            )}
          </div>
        </fieldset>

        <label className="rt-check">
          <input type="checkbox" className="v2-checkbox" checked={skipIfOpen} onChange={(e) => setSkipIfOpen(e.target.checked)} />
          <span>Skip a run while the previous task is still open</span>
        </label>
        <label className="rt-check">
          <input type="checkbox" className="v2-checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
        <p className="rt-hint">Each run creates a normal task as you — plan approval, verification and autonomy rules apply as usual.</p>
        {error ? <p className="rt-error" role="alert">{error}</p> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
