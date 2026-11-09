/**
 * The one-line proof-of-work summary — "3/4 DoD items evidenced · 42 tests passed ·
 * 1 risk flag". Used at the top of the verification gate and in
 * Needs-you rows. Each part appears only when it is real (no counts are
 * invented: "no tests ran" when no test command was found, "tests exited 0"
 * when a runner printed no summary). Colour lives only in the small glyph/word.
 */
import { Icon } from "../../../components/ui";
import type { EvidenceSummary } from "./evidenceTypes";

export interface SummaryPart {
  key: string;
  text: string;
  tone: "ok" | "warn" | "bad" | "mut" | "plain";
  icon?: string;
  title?: string;
}

/** Pure: the parts of the line (tested). */
export function summaryParts(s: EvidenceSummary | null | undefined, opts: { short?: boolean; general?: boolean } = {}): SummaryPart[] {
  if (!s) return [];
  const parts: SummaryPart[] = [];
  const d = s.dod;
  if (d && d.total) {
    const tone = d.not_proven ? "bad" : d.proven === d.total ? "ok" : "plain";
    parts.push({
      key: "dod",
      text: opts.short ? `${d.proven}/${d.total} DoD` : `${d.proven}/${d.total} DoD items evidenced`,
      tone,
      // a check only when every line is proven; ✕ when one is disproven; otherwise no glyph
      icon: d.not_proven ? "x" : d.proven === d.total ? "check" : undefined,
      title: `${d.proven} proven · ${d.needs_human} need a human · ${d.not_proven} not proven`,
    });
  }
  const t = s.tests;
  if (t) {
    const bad = (t.failed || 0) + (t.errors || 0);
    // General (non-code) projects have no test runner — "no tests ran" would be code talk
    if (t.status === "none") { if (!opts.general) parts.push({ key: "tests", text: "no tests ran", tone: "mut", title: "No test command was found in this task's run output" }); }
    else if (bad) parts.push({ key: "tests", text: `${bad} test${bad === 1 ? "" : "s"} failing`, tone: "bad", title: `${t.passed} passed · ${bad} failed/errored` });
    else if (t.passed) parts.push({ key: "tests", text: `${t.passed} test${t.passed === 1 ? "" : "s"} passed`, tone: "ok" });
    else if (t.status === "exit_ok") parts.push({ key: "tests", text: "tests exited 0", tone: "plain", title: "The runner exited 0 but printed no summary line — no counts" });
    else if (t.status === "failed") parts.push({ key: "tests", text: "tests failing", tone: "bad" });
    else if (t.status === "unverified") parts.push({ key: "tests", text: "tests ran (result unreadable)", tone: "mut" });
  }
  if (s.risk_flags) parts.push({ key: "risk", text: opts.short ? `${s.risk_flags} risk${s.risk_flags === 1 ? "" : "s"}` : `${s.risk_flags} risk flag${s.risk_flags === 1 ? "" : "s"}`, tone: "warn", icon: "alert" });
  return parts;
}

/** Plain-text form (Needs-you row second line): "4/5 DoD · 42 tests passed · 1 risk". */
export function summaryText(s: EvidenceSummary | null | undefined, opts: { short?: boolean; general?: boolean } = { short: true }): string {
  return summaryParts(s, opts).map((p) => p.text).join(" · ");
}

export function EvidenceSummaryLine({ summary, short, general, className }: { summary: EvidenceSummary | null | undefined; short?: boolean; general?: boolean; className?: string }) {
  const parts = summaryParts(summary, { short, general });
  if (!parts.length) return null;
  return (
    <span className={"ev-line" + (className ? " " + className : "")} aria-label={"Proof of work: " + parts.map((p) => p.text).join(", ")} data-testid="evidence-summary">
      {parts.map((p) => (
        <span key={p.key} className={"ev-part" + (p.tone === "plain" ? "" : " ev-" + p.tone)} title={p.title} data-part={p.key}>
          {p.icon ? <Icon name={p.icon} cls="v2-ico" /> : null}
          <span>{p.text}</span>
        </span>
      ))}
    </span>
  );
}
