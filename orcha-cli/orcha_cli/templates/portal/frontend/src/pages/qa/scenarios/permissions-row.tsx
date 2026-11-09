import { Select } from "../map/kit";
import { asksAboutPermissionPrompt, permissionsChoice, type PermissionsChoice, type PermissionsScenario } from "./app-permissions";
import { PropRow } from "./panel-ui";

const HELP =
  "Before every check run the agent grants the app its permissions (microphone, notifications, photos, camera, location and " +
  "so on), so no permission dialog interrupts the test, and taps Allow if one still shows. Choose Ask when this " +
  "scenario tests the permission prompt itself: nothing is granted and the app asks as it would for a new user.";

/** `scenarios.permissions` (`Permissions: ask`): granted before the run, or left to the app's prompt. */
export function PermissionsRow({
  value,
  onChange,
  scenario,
  disabled = false,
}: {
  value: string | null | undefined;
  onChange: (value: "ask" | null) => void;
  scenario: PermissionsScenario;
  disabled?: boolean;
}) {
  const choice = permissionsChoice(value);
  const suggest = choice === "grant" && asksAboutPermissionPrompt(scenario);
  return (
    <PropRow label="Permissions" help={HELP}>
      <Select
        aria-label="Permissions"
        value={choice}
        disabled={disabled}
        onChange={(e) => onChange((e.target.value as PermissionsChoice) === "ask" ? "ask" : null)}
        className="max-w-[260px]"
        data-scenario-permissions={choice}
        options={[
          { value: "grant", label: "Granted before the run", description: "no permission dialog interrupts it" },
          { value: "ask", label: "Ask, as for a new user", description: "it tests the permission prompt" },
        ]}
      />
      {suggest ? (
        <p className="text-xs text-warning" data-permissions-suggest>
          This scenario reads like it tests a permission dialog. The agent grants permissions first, so the dialog would
          never show.{" "}
          <button type="button" className="text-fg underline" disabled={disabled} onClick={() => onChange("ask")} data-permissions-suggest-ask>
            Choose Ask
          </button>
        </p>
      ) : choice === "ask" ? (
        <p className="text-xs text-muted" data-permissions-note>
          Nothing is granted before this scenario, and every permission dialog is left to it.
        </p>
      ) : null}
    </PropRow>
  );
}
