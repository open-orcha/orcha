/**
 * App permissions before a check (`orcha_cli/qa/app_permissions.py`): the app under test gets its OS
 * permissions before each scenario, so no permission dialog interrupts a test. A scenario that tests
 * the prompt itself says `Permissions: ask`.
 *
 * `asksAboutPermissionPrompt` mirrors `infer_ask`: a criterion about the permission dialog suggests `ask`.
 */

export type PermissionsChoice = "grant" | "ask";

const DEVICES = "(?:microphone|camera|location|notification|photos?|contacts?|calendar|bluetooth)";
const PROMPT = new RegExp(
  [
    "permission\\s+(?:dialog|prompt|request|sheet|alert|popup|pop-up|denied|is\\s+denied|refused)",
    `(?:asks?|asking|prompts?|prompted|requests?|requesting)\\s+(?:for\\s+|to\\s+)?(?:the\\s+user\\s+)?(?:${DEVICES}\\s+)?(?:permission|access|to\\s+allow|allow)`,
    "asks?\\s+to\\s+(?:allow|access|use|record|send|post)",
    "(?:deny|denies|denied|denying|refuse|refuses|refused|declines?|declined)\\s+(?:the\\s+)?(?:permission|access|microphone|camera|location|notifications?|photos?)",
    "(?:don['’]t|do\\s+not)\\s+allow",
    "allow\\s+(?:access|notifications|location|the\\s+microphone|microphone|camera|photos)",
    "(?:microphone|camera|location|notification|photo|contacts?)\\s+(?:permission|access)\\s+(?:is\\s+)?(?:denied|refused|off|blocked|prompt|dialog|request)",
    "without\\s+(?:the\\s+)?(?:microphone|camera|location|notification|photo|contacts?)\\s+(?:permission|access)",
  ]
    .map((p) => `(?:${p})`)
    .join("|")
    .replace(/^/, "\\b(?:")
    .concat(")\\b"),
  "i",
);

export interface PermissionsScenario {
  name?: string | null;
  description?: string | null;
  criteria?: readonly (string | { text?: string | null })[] | null;
}

/** A scenario about the permission prompt itself: it should say `Permissions: ask`. */
export function asksAboutPermissionPrompt(s: PermissionsScenario): boolean {
  const texts = [s.name ?? "", s.description ?? "", ...(s.criteria ?? []).map((c) => (typeof c === "string" ? c : (c?.text ?? "")))];
  return texts.some((t) => t && PROMPT.test(t));
}

export function permissionsChoice(value: string | null | undefined): PermissionsChoice {
  return value === "ask" ? "ask" : "grant";
}

/** The project's switch (`apps.test_data.permissions.grant`), on unless turned off. */
export function projectGrants(testData: unknown): boolean {
  if (!testData || typeof testData !== "object" || Array.isArray(testData)) return true;
  const p = (testData as Record<string, unknown>).permissions;
  return !(p && typeof p === "object" && (p as Record<string, unknown>).grant === false);
}

/** What the run's preparation said about permissions ("Granted 5 permissions: microphone, ..."),
 * for the run page's chip; null when the run has no such step. */
export function permissionsEvent(events: readonly { message?: string | null; status?: string | null }[]): { text: string; granted: boolean } | null {
  const hit = [...events].reverse().find((e) => /^(Granted \d+ permissions?|No permissions to grant|Permissions not granted)/.test(e.message ?? ""));
  if (!hit?.message) return null;
  return { text: hit.message, granted: hit.message.startsWith("Granted") || hit.message.startsWith("No permissions") };
}

/** The chip's short words: "5 permissions granted" / "Permission prompts left to the scenario". */
export function permissionsChip(text: string): string {
  const m = /^Granted (\d+) permissions?/.exec(text);
  if (m) return `${m[1]} permission${m[1] === "1" ? "" : "s"} granted`;
  if (text.startsWith("No permissions")) return "No permissions to grant";
  if (/tests the permission prompt/.test(text)) return "Permissions left to the prompt";
  return "Permissions not granted";
}
