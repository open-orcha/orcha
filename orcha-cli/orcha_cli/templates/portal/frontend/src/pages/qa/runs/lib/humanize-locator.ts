/**
 * Display-time cleanup for text the agent, the check runner or the model wrote, which is stored
 * as-is in the DB: accessibility roles and element indexes (`GenericElement "10/16" value="x"`,
 * `StaticText "Hi" [5]`), the check runner's "check failed: X — no X on screen; nearest: …" line,
 * and agent prose that names internal tools or files (`remember`, `not_a_bug`,
 * `suggestions.json`). Stored data is never rewritten; callers format it where it is shown.
 */

/** Roles that read as a noun after the label ("Next" button). The rest drop to the label. */
const ROLE_NOUN: Record<string, string> = {
  Button: "button",
  TextField: "field",
  SecureTextField: "field",
  SearchField: "search field",
  TextView: "field",
  Switch: "switch",
  Toggle: "switch",
  Link: "link",
  Image: "image",
  Slider: "slider",
  Tab: "tab",
  CheckBox: "checkbox",
  Checkbox: "checkbox",
};

const SILENT_ROLES = [
  "GenericElement",
  "StaticText",
  "Other",
  "Cell",
  "Text",
  "Heading",
  "Group",
  "Any",
  "Element",
];

const ROLE_RE = new RegExp(
  `\\b(${[...Object.keys(ROLE_NOUN), ...SILENT_ROLES].join("|")})\\s+"((?:[^"\\\\]|\\\\.)*)"`,
  "g",
);

/**
 * One accessibility locator, or every locator in a line, as a person reads it:
 * `GenericElement "10/16" value="total 6"` -> `"10/16" showing "total 6"`,
 * `Button "Next" [4]` -> `"Next" button`, `StaticText "Hi"` -> `"Hi"`.
 */
export function humanizeLocator(text: string): string {
  return (
    text
      // Element indexes from the accessibility tree: `"Next" [4]` -> `"Next"`.
      .replace(/"\s*\[\d+\]/g, '"')
      .replace(ROLE_RE, (_m, role: string, label: string) => {
        const noun = ROLE_NOUN[role];
        return noun ? `"${label}" ${noun}` : `"${label}"`;
      })
      // The check runner's `text "X"` subject, only where it is a locator (not prose).
      .replace(/(^|\bno |: |, )text\s+"/g, '$1"')
      .replace(/\s+value="((?:[^"\\]|\\.)*)"/g, ' showing "$1"')
  );
}

/** At most `max` items of a comma-separated "nearest" list, with "and N more". */
function shortList(raw: string, max = 3): string {
  const items = raw.match(/"(?:[^"\\]|\\.)*"[^,]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (items.length === 0) return raw.trim();
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * A check result line in plain words. `check failed: Button "Next" — no Button "Next" on
 * screen after 5.3s; nearest: Button "Skip" [4]` -> `Check failed: "Next" button was not on
 * screen after 5.3s. Closest on screen: "Skip" button.`
 */
/** The hint a late check gives the agent ("report a criterion with evidence_frame 5 …"):
 * addressed to the agent, never shown to a person. */
const AGENT_HINT = /;\s*report a criterion with evidence_frame \S+ \(the screen that shows it\)/g;

export function humanizeCheckText(text: string): string {
  if (!text) return text;
  // A check-fix reason is written to the agent ("until your next action removed it"): a person reads it.
  let out = text.replace(AGENT_HINT, "").replace(/\byour next action\b/g, "the agent's next action").replace(

    /check failed: (.+?) — no \1 on screen after ([\d.]+s)/g,
    (_m, subject: string, secs: string) => `Check failed: ${subject} was not on screen after ${secs}`,
  );
  out = out.replace(/\bno (.+?) on screen after ([\d.]+s)/g, "$1 was not on screen after $2");
  out = out.replace(/;\s*nearest:\s*([^\n]*)/g, (_m, list: string) => `. Closest on screen: ${shortList(humanizeLocator(list))}.`);
  return humanizeLocator(out);
}

/** Sentences that only report the agent's own plumbing, not the app. */
const PLUMBING_SENTENCE = /`remember`|\bremember\b[^.]*\bsession\b|memory could not be saved/i;

/**
 * Agent prose (a triage summary, a report) without internal tool and file names. Drops
 * sentences about the agent's own memory plumbing and rewords the rest.
 */
export function humanizeAgentProse(text: string): string {
  if (!text) return text;
  const kept = text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?]) +(?=[A-Z`])/)
        .filter((s) => !PLUMBING_SENTENCE.test(s))
        .join(" "),
    )
    .join("\n");
  return humanizeCheckText(
    kept
      .replace(/`?not_a_bug`?/g, "not a bug")
      .replace(/\bsee `?suggestions\.json`?/gi, "see Suggestions")
      .replace(/`?suggestions\.json`?/g, "Suggestions"),
  );
}

/** Long repro lists show this many steps before "Show all N steps". */
export const REPRO_PREVIEW_STEPS = 8;
