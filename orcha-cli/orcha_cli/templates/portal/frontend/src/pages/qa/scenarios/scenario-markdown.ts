/**
 * A scenario as markdown text, for reading or pasting into a ticket: `# name`, metadata lines, the
 * description, numbered criteria with their `Check:` lines. The same shape the export writes.
 */
import { CONDITION_KEYS, cleanConditions } from "../conditions/conditions";
import type { Scenario } from "./adapt";
import { STATUS_LABEL, effectiveStatus } from "./scenario-status";
import { PLATFORM_LABELS } from "../map/kit";

function line(label: string, value: string | null | undefined): string | null {
  return value ? `- ${label}: ${value}` : null;
}

/** `os=Android 13; locale=sw-KE`: the scenario format's `Conditions:` line (values never hold `;`). */
function conditionsLine(s: Pick<Scenario, "conditions">): string | null {
  const c = cleanConditions(s.conditions);
  if (!c) return null;
  return CONDITION_KEYS.filter((k) => c[k]).map((k) => `${k}=${String(c[k]).replace(/;/g, ",").replace(/\s+/g, " ")}`).join("; ");
}

export function scenarioToMarkdown(s: Scenario, names: ReadonlyMap<string, { name: string }> = new Map()): string {
  const data = Object.entries(s.data).map(([k, v]) => `${k}=${String(v)}`).join(", ");
  const meta = [
    line("Platform", s.target_kind ? PLATFORM_LABELS[s.target_kind] : "All platforms"),
    line("Category", s.category),
    line("Persona", s.persona),
    line("Status", STATUS_LABEL[effectiveStatus(s)]),
    line("Tags", s.tags.join(", ")),
    line("Needs", s.needs.join(", ")),
    line("Depends on", s.depends_on.map((d) => names.get(d)?.name ?? d).join(", ")),
    line("Data", data),
    line("Conditions", conditionsLine(s)),
  ].filter((x): x is string => x !== null);
  const out = [`# ${s.name}`, "", ...meta];
  if (s.description) out.push("", s.description.trim());
  out.push("");
  out.push(...s.checks.scenario.map((c) => `Check: ${c}`));
  s.criteria.forEach((c, i) => {
    out.push(`${i + 1}. ${c}`);
    out.push(...(s.checks.criteria[String(i)] ?? []).map((x) => `   Check: ${x}`));
  });
  return `${out.join("\n").trimEnd()}\n`;
}

export function scenariosToMarkdown(rows: readonly Scenario[], all: readonly Pick<Scenario, "id" | "name">[]): string {
  const names = new Map(all.map((s) => [s.id, { name: s.name }]));
  return rows.map((s) => scenarioToMarkdown(s, names)).join("\n");
}
