import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, Loader2 } from "../kit/icons";
import { cn, CountUp, Input, Link, useToast } from "../kit";
import { errText } from "../../parts";
import { loadSlowest, savePerfSettings } from "./api";
import { budgetFor, fmtSeconds, platformName, type SlowestResponse, type SlowScreen } from "./perf";
import { PERF_DEFAULTS, PERF_RANGES, validatePerfChange, type PerfChange, type PerfSettings } from "./perf-settings";
import { SettingRow, SettingsGroup } from "./settings-ui";
import motion from "./perf.module.css";

type FieldKey = keyof typeof PERF_RANGES;

type NumberField = {
  key: FieldKey;
  label: string;
  help: string;
  unit: string;
  /** Shown in the unit's terms: seconds for budgets kept in ms. */
  scale?: number;
  step: number;
  /** The slider's span, in the unit's terms; it widens to hold a value set outside it. */
  span: [number, number];
};

const BUDGETS: NumberField[] = [
  { key: "web_lcp_ms", label: "Web: main content shows (LCP)", help: "How long a web page may take to paint its largest element after it starts loading.", unit: "s", scale: 1000, step: 0.1, span: [0.5, 8] },
  { key: "appear_ms", label: "Phone: screen appears", help: "How long after a tap or a navigation the next screen may take to show on iOS and Android.", unit: "s", scale: 1000, step: 0.1, span: [0.3, 6] },
  { key: "launch_ms", label: "Phone: launch to first screen", help: "How long the app may take from launch until its first screen shows.", unit: "s", scale: 1000, step: 0.1, span: [0.5, 10] },
];

const THRESHOLDS: NumberField[] = [
  { key: "regression_pct", label: "Slower than usual by", help: "A screen this much slower than its usual time counts as a regression.", unit: "%", step: 5, span: [10, 300] },
  { key: "regression_min_ms", label: "And by at least", help: "So a fast screen going from 0.1 s to 0.2 s is not a regression.", unit: "s", scale: 1000, step: 0.05, span: [0, 2] },
  { key: "baseline_runs", label: "Usual time from the last", help: "A screen's usual time is the median of this many of its newest clean samples.", unit: "samples", step: 1, span: [5, 100] },
  { key: "load_limit", label: "Ignore samples when the machine's load is above", help: "Load per CPU core when the action was sent. A busy machine makes every screen look slow.", unit: "per core", step: 0.1, span: [0.5, 4] },
];

const FIELDS: NumberField[] = [...BUDGETS, ...THRESHOLDS];

/** "5 to 1000 %", "0 to 60 s": a field's range in the unit it is typed in. */
export function rangeWords(f: Pick<NumberField, "key" | "unit" | "scale">): string {
  const [lo, hi] = PERF_RANGES[f.key];
  const scale = f.scale ?? 1;
  return `${lo / scale} to ${hi / scale} ${f.unit}`;
}

/** Why a typed value cannot be saved, in the field's words, or null when it can. */
export function fieldError(f: Pick<NumberField, "key" | "unit" | "scale">, typed: string): string | null {
  const n = Number(typed);
  if (typed.trim() === "" || !Number.isFinite(n)) return `Enter a number from ${rangeWords(f)}.`;
  const v = n * (f.scale ?? 1);
  const [lo, hi] = PERF_RANGES[f.key];
  if (v < lo || v > hi) return `Enter ${rangeWords(f)}.`;
  return null;
}

/** A refusal in the settings' own words: "Slower than usual by must be 5 to 1000 %." rather than the stored key. */
export function errorWords(error: string): string {
  const f = FIELDS.find((x) => new RegExp(`^${x.key}\\b`).test(error));
  if (!f) return error;
  return /must be a number from/.test(error) ? `${f.label} must be ${rangeWords(f)}.` : error.replace(f.key, f.label);
}

function valueOf(s: PerfSettings, key: FieldKey): number {
  return key in s.budgets ? s.budgets[key as keyof PerfSettings["budgets"]] : (s[key as keyof PerfSettings] as number);
}

function changeFor(key: FieldKey, v: number): PerfChange {
  return key in PERF_DEFAULTS.budgets ? { budgets: { [key]: v } } : ({ [key]: v } as PerfChange);
}

function withValue(s: PerfSettings, key: FieldKey, v: number): PerfSettings {
  return key in s.budgets ? { ...s, budgets: { ...s.budgets, [key]: v } } : { ...s, [key]: v };
}

/** The line a screen is slow over: its regression line when it has a usual time, its budget when it has one, the lower of the two. */
export function slowLine(s: Pick<SlowScreen, "platform" | "metric" | "baseline">, settings: PerfSettings): { line: number | null; regression: number | null; budget: number | null } {
  const budget = budgetFor(s.platform, s.metric, settings);
  const regression = s.baseline && s.baseline.n >= 3 ? Math.max(s.baseline.median * (1 + settings.regression_pct / 100), s.baseline.median + settings.regression_min_ms) : null;
  const lines = [regression, budget].filter((v): v is number => v !== null);
  return { line: lines.length ? Math.min(...lines) : null, regression, budget };
}

type Status = "saving" | "saved";

/**
 * The speed budgets a screen must stay within, when a slower screen counts as a regression and
 * which samples are noise. Each number is a slider (with its exact value beside it) that saves
 * when it is let go, and a preview above them shows the project's own screens against the lines
 * the sliders draw, moving as they move: what would count as slower. A person's to change: for
 * anyone else every control is disabled with the reason.
 */
export function PerfSettingsSection({ cid, slowestHref, initial, actor, can, reason }: { cid: string; slowestHref: string; initial: PerfSettings; actor: string | null; can: boolean; reason: string | null }) {
  const { toast } = useToast();
  const [settings, setSettings] = useState<PerfSettings>(initial);
  // What the sliders show while they move, before it is saved.
  const [draft, setDraft] = useState<PerfSettings>(initial);
  const [status, setStatus] = useState<Partial<Record<string, Status>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  function mark(key: string, s: Status | null) {
    setStatus((m) => ({ ...m, [key]: s ?? undefined }));
    clearTimeout(timers.current.get(key));
    if (s === "saved") timers.current.set(key, setTimeout(() => setStatus((m) => ({ ...m, [key]: undefined })), 1800));
  }

  async function save(change: PerfChange, what: string, key: string): Promise<boolean> {
    const checked = validatePerfChange(change);
    if (!checked.ok) {
      toast({ title: `Could not save ${what}`, description: errorWords(checked.error), variant: "error" });
      setDraft(settings);
      return false;
    }
    setBusy(key);
    mark(key, "saving");
    try {
      const next = await savePerfSettings(cid, checked.value, actor);
      setSettings(next);
      setDraft(next);
      mark(key, "saved");
      return true;
    } catch (e) {
      toast({ title: `Could not save ${what}`, description: errorWords(errText(e)), variant: "error" });
      setDraft(settings);
      mark(key, null);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const off = !can;
  const row = (f: NumberField) => (
    <SliderRow
      key={f.key}
      field={f}
      value={valueOf(draft, f.key)}
      saved={valueOf(settings, f.key)}
      status={status[f.key] ?? null}
      disabled={off || (busy !== null && busy !== f.key)}
      onDraft={(v) => setDraft((d) => withValue(d, f.key, v))}
      onCommit={(v) => (v === valueOf(settings, f.key) ? Promise.resolve(true) : save(changeFor(f.key, v), f.label.toLowerCase(), f.key))}
    />
  );
  return (
    <div data-perf-settings>
      {off ? <p className="mb-4 text-sm text-muted" data-perf-gate>{reason || "Only a person can change the budgets."}</p> : null}

      <Preview cid={cid} slowestHref={slowestHref} draft={draft} saved={settings} />

      <SettingsGroup title="Budgets" lead="Over a budget is slow, whatever the screen's history says." flush id="perf-budgets">
        {BUDGETS.map(row)}
      </SettingsGroup>

      <SettingsGroup title="When a screen counts as slower" lead={`Defaults: ${PERF_DEFAULTS.regression_pct}% and ${PERF_DEFAULTS.regression_min_ms / 1000} s slower.`} flush id="perf-thresholds">
        {THRESHOLDS.map(row)}
      </SettingsGroup>
    </div>
  );
}

/** "Saving…" while a field saves, then a check that lands and fades. */
function SaveMark({ status }: { status: Status | null }) {
  return (
    <span className="flex w-14 justify-end text-[11px]" aria-live="polite" data-perf-save={status ?? undefined}>
      {status === "saving" ? (
        <span className="inline-flex items-center gap-1 text-muted">
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          Saving
        </span>
      ) : status === "saved" ? (
        <span className={cn("inline-flex items-center gap-1 font-medium text-success", motion.saved)}>
          <Check className="size-3" aria-hidden />
          Saved
        </span>
      ) : null}
    </span>
  );
}

function round(v: number, step: number): number {
  const d = String(step).split(".")[1]?.length ?? 0;
  return Number(v.toFixed(d));
}

function SliderRow({
  field,
  value,
  saved,
  status,
  disabled,
  onDraft,
  onCommit,
}: {
  field: NumberField;
  value: number;
  saved: number;
  status: Status | null;
  disabled: boolean;
  onDraft: (v: number) => void;
  onCommit: (v: number) => Promise<boolean>;
}) {
  const scale = field.scale ?? 1;
  const shown = round(value / scale, field.step);
  const [text, setText] = useState<string | null>(null);
  // A typed value out of range stays in the field, flagged, with the range beside it; it is not saved.
  const [error, setError] = useState<string | null>(null);
  const [lo, hi] = PERF_RANGES[field.key];
  const min = Math.min(field.span[0], round(value / scale, field.step));
  const max = Math.max(field.span[1], round(value / scale, field.step));
  const id = `perf-${field.key}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const p = `${(((shown - min) / Math.max(1e-9, max - min)) * 100).toFixed(1)}%`;
  const commitFrom = (n: number) => {
    const v = Math.round(n * scale * 1000) / 1000;
    if (v !== saved) void onCommit(v);
  };
  async function commitText() {
    if (text === null) return;
    if (text.trim() === "") {
      setText(null);
      setError(null);
      return;
    }
    const why = fieldError(field, text);
    setError(why);
    if (why) return;
    const v = Math.round(Number(text) * scale * 1000) / 1000;
    onDraft(v);
    if (v === saved || (await onCommit(v))) setText(null);
  }
  return (
    <SettingRow
      label={field.label}
      description={
        <>
          <span id={helpId}>{field.help}</span>
          {error ? (
            <span id={errorId} role="alert" className="mt-1 block font-medium text-danger" data-perf-error={field.key}>
              {error} Esc puts back {round(saved / scale, field.step)} {field.unit}.
            </span>
          ) : null}
        </>
      }
      htmlFor={id}
      className="max-md:flex-wrap"
    >
      <div className="flex items-center gap-2.5" data-perf-slider={field.key}>
        <input
          type="range"
          min={min}
          max={max}
          step={field.step}
          value={shown}
          disabled={disabled}
          aria-label={field.label}
          aria-describedby={helpId}
          aria-valuetext={`${shown} ${field.unit}`}
          onChange={(e) => {
            setText(null);
            setError(null);
            onDraft(Math.round(Number(e.target.value) * scale * 1000) / 1000);
          }}
          onPointerUp={(e) => commitFrom(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) commitFrom(Number((e.target as HTMLInputElement).value));
          }}
          className={cn("w-40 sm:w-48", motion.range)}
          style={{ "--p": p } as CSSProperties}
          data-perf-range={field.key}
        />
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          aria-describedby={error ? `${helpId} ${errorId}` : helpId}
          aria-invalid={error ? true : undefined}
          min={lo / scale}
          max={hi / scale}
          step={field.step}
          value={text ?? String(shown)}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(fieldError(field, e.target.value));
          }}
          onBlur={() => void commitText()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitText();
            if (e.key === "Escape") {
              setText(null);
              setError(null);
            }
          }}
          className={cn("w-[4.5rem] text-right tabular", error && "border-danger focus-visible:ring-danger/40")}
          data-perf-field={field.key}
        />
        <span className="w-14 text-xs text-muted">{field.unit}</span>
        <SaveMark status={status} />
      </div>
    </SettingRow>
  );
}

/**
 * What would count as slower with the values on the sliders, on this project's own screens (the
 * newest time of each in the last 30 days): each one's time against the line it is slow over, the
 * line moving as a slider moves, the screens over it turning red. Plain words for the rule itself,
 * for a screen with the project's typical usual time.
 */
function Preview({ cid, slowestHref, draft, saved }: { cid: string; slowestHref: string; draft: PerfSettings; saved: PerfSettings }) {
  const [data, setData] = useState<SlowestResponse | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    loadSlowest(cid, 30, null, ctl.signal).then(setData, () => undefined);
    return () => ctl.abort();
  }, [cid]);
  const screens = useMemo(() => (data?.screens ?? []).filter((s) => s.metric !== "heap" && s.metric !== "memory" && s.metric !== "cpu"), [data]);
  const judged = useMemo(
    () =>
      screens
        .map((s) => {
          const { line, regression, budget } = slowLine(s, draft);
          const over = line !== null && s.latest > line;
          const why = over ? (budget !== null && s.latest > budget ? "over budget" : "slower than usual") : null;
          return { s, line, regression, budget, over, why, ratio: line ? s.latest / line : 0 };
        })
        .sort((a, b) => b.ratio - a.ratio),
    [screens, draft],
  );
  const slowNow = judged.filter((j) => j.over).length;
  const slowSaved = screens.filter((s) => {
    const { line } = slowLine(s, saved);
    return line !== null && s.latest > line;
  }).length;
  const usuals = screens.map((s) => s.baseline?.median).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const typical = usuals.length ? usuals[Math.floor(usuals.length / 2)] : 1200;
  const exampleLine = Math.max(typical * (1 + draft.regression_pct / 100), typical + draft.regression_min_ms);
  const shownRows = judged.slice(0, 6);
  const max = Math.max(1000, ...shownRows.map((j) => Math.max(j.s.latest, j.line ?? 0, j.s.baseline?.median ?? 0))) * 1.08;
  const pct = (v: number) => `${Math.min(100, (v / max) * 100).toFixed(2)}%`;
  return (
    <section className="mb-8 overflow-hidden rounded-xl border border-border bg-panel shadow-[var(--shadow-panel)]" aria-label="What would count as slower" data-perf-preview>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">What would count as slower</h2>
          <p className="mt-0.5 text-xs text-fg-2" data-perf-rule>
            A screen usually <span className="tabular text-fg">{fmtSeconds(typical)}</span> counts as slower from{" "}
            <span className="font-semibold text-danger tabular">{fmtSeconds(exampleLine)}</span>.
          </p>
        </div>
        {screens.length ? (
          <p className="text-right text-xs text-fg-2" aria-live="polite" data-perf-preview-count>
            <span className={cn("text-2xl font-semibold leading-7 tabular", slowNow ? "text-danger" : "text-success")}>
              <CountUp value={String(slowNow)} />
            </span>{" "}
            of {screens.length} screen{screens.length === 1 ? "" : "s"} would be slow
            {slowNow !== slowSaved ? <span className="block text-[11px] text-muted">now {slowSaved} with the saved values</span> : null}
          </p>
        ) : null}
      </div>
      {data === null ? (
        <div className="flex flex-col gap-2.5 px-4 py-4" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="v-skeleton block h-3" style={{ width: `${70 - i * 12}%` }} />
          ))}
        </div>
      ) : judged.length === 0 ? (
        <p className="px-4 py-4 text-xs text-muted" data-perf-preview-empty>
          No screen timed in the last 30 days yet. Once runs time screens, each one shows here against these lines as you move them.
        </p>
      ) : (
        <ul className="flex flex-col px-4 py-2">
          {shownRows.map((j, i) => (
            <li key={`${j.s.platform}:${j.s.device_class}:${j.s.key}`} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_7.5rem] items-center gap-3 py-1.5 max-sm:grid-cols-[minmax(0,1fr)_6.5rem]" data-perf-preview-row={j.over ? "slow" : "ok"}>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-fg" title={j.s.label}>
                  {j.s.label}
                </span>
                <span className="block truncate text-[10px] text-muted">{j.s.platform === "web" ? platformName(j.s.platform, j.s.device_class) : (j.s.device ?? platformName(j.s.platform))}</span>
              </span>
              <span className="relative h-5 max-sm:hidden" aria-hidden>
                <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]" />
                {j.s.baseline ? <span className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-fg/50" style={{ left: pct(j.s.baseline.median) }} /> : null}
                {j.line !== null ? (
                  <span className={cn("absolute inset-y-0 left-0 w-full", motion.line)} style={{ transform: `translateX(${(Math.min(j.line, max) / max) * 100}%)` }}>
                    <span className="absolute inset-y-0 left-0 w-0 border-l-2 border-dashed border-danger/70" />
                  </span>
                ) : null}
                <span
                  className={cn("v-grow-x absolute top-1/2 h-1 -translate-y-1/2 rounded-full", j.over ? "bg-danger" : "bg-[color-mix(in_srgb,var(--color-fg-2)_70%,transparent)]")}
                  style={{ width: pct(j.s.latest), "--i": i } as CSSProperties}
                />
                <span
                  className={cn("absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel", motion.dot, j.over ? "bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-danger)_25%,transparent)]" : "bg-fg-2")}
                  style={{ left: pct(j.s.latest) }}
                />
              </span>
              <span className="text-right text-[11px] leading-4">
                <span className={cn("font-semibold tabular", j.over ? "text-danger" : "text-fg")}>{fmtSeconds(j.s.latest)}</span>
                <span className={cn("block", j.over ? "text-danger" : "text-muted")}>{j.over ? j.why : j.line !== null ? `slow from ${fmtSeconds(j.line)}` : "no line yet"}</span>
              </span>
            </li>
          ))}
          {judged.length > shownRows.length ? (
            <li className="py-1.5 text-[11px] text-muted">
              and {judged.length - shownRows.length} more, further from their lines.{" "}
              <Link href={slowestHref} className="underline underline-offset-2 hover:text-fg">
                All screens
              </Link>
            </li>
          ) : null}
        </ul>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted">
        Each screen&apos;s newest time in the last 30 days, against the line the values below draw: its usual time plus the regression line, or its budget, whichever is lower.
      </p>
    </section>
  );
}
