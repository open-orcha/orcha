/**
 * The one-line proof-of-work summary — "3/4 DoD items evidenced · 42 tests passed ·
 * 1 risk flag · Verdikt pass". Used at the top of the verification gate and in
 * Needs-you rows. Each part appears only when it is real (no counts are
 * invented: "no tests ran" when no test command was found, "tests exited 0"
 * when a runner printed no summary). Colour lives only in the small glyph/word.
 */
import { Icon } from "../../../components/ui";
import type { AutofixSummary, EvidenceSummary } from "./evidenceTypes";

/** The auto-fix loop's part (mig 068) — first, because it says why the task is (back) here:
 *  "Auto-fix: attempt 2 of 3" · "Verdikt passed on attempt 3/3" · "Auto-fix stopped: same
 *  failure twice". The full plain-words reason rides in the title. */
export function autofixPart(a: AutofixSummary | null | undefined): SummaryPart | null {
  if (!a) return null;
  if (a.status === "running") {
    return { key: "autofix", text: `Auto-fix: attempt ${a.current_attempt} of ${a.max_attempts}`, tone: "plain", icon: "refresh",
      title: "Verdikt failures go back to the agent automatically" };
  }
  const n = a.attempts_made;
  const why: Record<string, string> = {
    pass: `Verdikt passed on attempt ${n}/${a.max_attempts}`,
    attempt_limit: `Auto-fix stopped: failed ${n} of ${a.max_attempts} attempts`,
    no_diff: "Auto-fix stopped: the rework changed no code",
    same_failure: "Auto-fix stopped: same failure twice",
    budget: "Auto-fix stopped: budget limit",
    agent_paused: "Auto-fix stopped: agent paused",
    stopped_by_human: "Auto-fix stopped by a person",
    turned_off: "Auto-fix turned off",
    no_assignee: "Auto-fix stopped: nobody assigned",
  };
  let text = why[a.stop_kind || ""];
  if (!text) {
    // non-fail outcomes / a person stepping in: the reason's first clause says it
    const r = (a.stop_reason || a.stop_label || "stopped").split(/ — | \(/)[0];
    text = "Auto-fix stopped: " + (/^Verdikt/.test(r) ? r : r.charAt(0).toLowerCase() + r.slice(1));
  }
  return { key: "autofix", text, tone: a.stop_kind === "pass" ? "ok" : "warn", icon: a.stop_kind === "pass" ? "check" : "alert",
    title: a.stop_reason || undefined };
}

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
  const af = autofixPart(s.autofix);
  if (af) parts.push(af);
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
  const v = s.verdikt;
  if (v) {
    if (v.status === "completed" && v.verdict) {
      const tone = v.verdict === "pass" ? "ok" : v.verdict === "fail" ? "bad" : "warn";
      parts.push({ key: "verdikt", text: `Verdikt ${v.verdict}`, tone });
    } else if (v.status === "queued" || v.status === "running") parts.push({ key: "verdikt", text: v.status === "queued" ? "Verdikt queued" : "Verdikt running", tone: "plain" });
    else parts.push({ key: "verdikt", text: `Verdikt ${v.status}`, tone: v.status === "cancelled" ? "mut" : "warn" });
  }
  return parts;
}

/** Plain-text form (Needs-you row second line): "4/5 DoD · 42 tests passed · 1 risk · Verdikt pass". */
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
