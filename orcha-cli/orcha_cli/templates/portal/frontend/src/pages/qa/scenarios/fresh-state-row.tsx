import { Select } from "../map/kit";
import { PropRow } from "./panel-ui";

const HELP =
  "Mobile check runs clear the app's data before this scenario, so a first-launch or onboarding journey never meets a " +
  "profile left by an earlier run. Keep app data when the scenario needs what an earlier one set up. By default a " +
  "scenario that depends on another, or starts from a saved session, keeps it.";

export type FreshChoice = "default" | "keep" | "always";

export function freshChoice(fresh: boolean | null | undefined): FreshChoice {
  return fresh === false ? "keep" : fresh === true ? "always" : "default";
}

export function freshValue(choice: FreshChoice): boolean | null {
  return choice === "keep" ? false : choice === "always" ? true : null;
}

/** What the default does for this scenario, in a few words. */
export function freshDefaultNote(dependsOn: number, restoresSession: boolean): string {
  if (restoresSession) return "keeps data: it starts from a saved session";
  if (dependsOn > 0) return "keeps data: it depends on another scenario";
  return "clears app data first";
}

/** `qa_scenarios.fresh`: whether a mobile run clears the app's data first. */
export function FreshStateRow({
  value,
  onChange,
  dependsOn,
  restoresSession,
  disabled = false,
}: {
  value: boolean | null | undefined;
  onChange: (fresh: boolean | null) => void;
  dependsOn: number;
  restoresSession: boolean;
  disabled?: boolean;
}) {
  return (
    <PropRow label="Fresh start" help={HELP}>
      <Select
        aria-label="Fresh start"
        value={freshChoice(value)}
        disabled={disabled}
        onChange={(e) => onChange(freshValue(e.target.value as FreshChoice))}
        className="max-w-[260px]"
        data-scenario-fresh={freshChoice(value)}
        options={[
          { value: "default", label: "Default", description: freshDefaultNote(dependsOn, restoresSession) },
          { value: "keep", label: "Keep app data" },
          { value: "always", label: "Always clear app data" },
        ]}
      />
    </PropRow>
  );
}
