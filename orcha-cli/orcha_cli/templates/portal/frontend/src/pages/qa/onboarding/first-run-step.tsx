import { Button, Field, Input, PlatformIcon, PLATFORM_NAMES, cn } from "./ui";
import { RunsOnSummary, type SummaryPlan } from "./runs-on-summary";
import { enabledTargets, type SetField, type WizardState } from "./state";

const SEGMENT = "flex items-center gap-1.5 rounded-[4px] px-3 text-sm font-medium transition-colors";
const SEGMENT_ON = "bg-raised text-fg shadow-sm";
const SEGMENT_OFF = "text-muted hover:bg-hover hover:text-fg";

/**
 * The first run, under "More ways to start". With several platforms, an explicit "One platform"
 * (which one) or "All platforms" (one run each, queued together). Exploratory: the time budget and
 * what to look at first, with the full Run check dialog a click away. Scenarios: a scenario file, or
 * the approved scenarios. The "Runs on" summary says what will run, and where, before it does.
 */
export function FirstRunStep({ state, set, plans, onMore, disabled }: {
  state: WizardState;
  set: SetField;
  /** What Queue run will queue: one entry per platform, with its device. */
  plans: SummaryPlan[];
  /** The full Run check dialog. */
  onMore: () => void;
  disabled?: boolean;
}) {
  const enabled = enabledTargets(state);
  const many = enabled.length > 1;
  const all = many && state.firstRunScope === "all";
  const exploring = state.mode === "exploratory";
  return (
    <div className="flex flex-col gap-3.5" data-onboarding-first-run-step>
      {many ? (
        <Field label="Platforms">
          <div role="radiogroup" aria-label="Platforms" className="inline-flex h-7 gap-0.5 self-start rounded-md border border-border bg-panel-2 p-0.5" data-first-run-scope={state.firstRunScope}>
            {(["one", "all"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={state.firstRunScope === v}
                onClick={() => set("firstRunScope", v)}
                data-first-run-scope-option={v}
                className={cn(SEGMENT, state.firstRunScope === v ? SEGMENT_ON : SEGMENT_OFF)}
              >
                {v === "one" ? "One platform" : `All platforms (${enabled.length})`}
              </button>
            ))}
          </div>
        </Field>
      ) : null}
      {many && !all ? (
        <Field label="Platform">
          <div role="radiogroup" aria-label="Platform" className="inline-flex h-7 gap-0.5 self-start rounded-md border border-border bg-panel-2 p-0.5">
            {enabled.map((t) => (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={state.firstRunTargetKey === t.key}
                data-first-run-target={t.kind}
                onClick={() => set("firstRunTargetKey", t.key)}
                className={cn(SEGMENT, state.firstRunTargetKey === t.key ? SEGMENT_ON : SEGMENT_OFF)}
              >
                <PlatformIcon kind={t.kind} className="size-3.5" />
                {PLATFORM_NAMES[t.kind]}
              </button>
            ))}
          </div>
        </Field>
      ) : null}
      <Field label="Mode">
        <div role="radiogroup" aria-label="Mode" className="inline-flex h-7 gap-0.5 self-start rounded-md border border-border bg-panel-2 p-0.5">
          {(["exploratory", "scenarios"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={state.mode === m}
              onClick={() => set("mode", m)}
              data-onboarding-mode={m}
              className={cn(SEGMENT, "capitalize", state.mode === m ? SEGMENT_ON : SEGMENT_OFF)}
            >
              {m}
            </button>
          ))}
        </div>
      </Field>
      {exploring ? (
        <div className="flex flex-col gap-3.5" data-onboarding-first-exploration>
          <Field label="Minutes" hint="How long the agent explores: between 5 and 240.">
            <Input className="max-w-24" type="number" inputMode="numeric" min={5} max={240} step={5} value={state.minutes} onChange={(e) => set("minutes", e.target.value)} data-onboarding-minutes data-dictation="off" />
          </Field>
          <Field label="Focus" hint="Optional. What to look at first.">
            <Input value={state.focus} maxLength={200} onChange={(e) => set("focus", e.target.value)} placeholder="Sign-up and password reset" data-onboarding-focus />
          </Field>
          <Button className="self-start" size="sm" variant="ghost" onClick={onMore} disabled={disabled} data-onboarding-more-options>
            More options
          </Button>
        </div>
      ) : (
        <Field label="Scenario file" htmlFor="onb-scenario" hint="Optional. Leave empty to run the approved scenarios. Otherwise a repo-relative path.">
          <Input id="onb-scenario" mono value={state.scenarioFile} onChange={(e) => set("scenarioFile", e.target.value)} placeholder="scenarios/example.md" data-dictation="off" />
        </Field>
      )}
      <RunsOnSummary plans={plans} />
    </div>
  );
}
