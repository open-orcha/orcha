/**
 * Finishing work with no person. Off by default: a person verifies. When a person turns it on, a task
 * finishes alone only when every definition-of-done line has strong proof (a Quality verdict or
 * passing tests) from someone other than the author, with no risk flags and no serious findings.
 *
 * Quality is one source of proof here, never the verifier of all work. The server decides and gives
 * its reasons; this file only holds the words and reads the shapes. The option's name may still
 * change: it lives in `FINISH_ALONE_LABEL` and nowhere else.
 */
import { isObj, listOf, text } from "./read";

export const FINISH_ALONE_LABEL = "Finish by itself when everything is proven";

/** A task that finished under the option, in the words its history and result card use. */
export const FINISHED_ALONE_WORD = "Finished by itself";

export const FINISH_ALONE_HINT = "Off: a person verifies every task. On: a task finishes with no person only when every line of its definition of done has strong proof, a Quality verdict or passing tests, from someone other than the agent that did the work.";

/** What stays with a person with the option on. */
export const FINISH_ALONE_STAYS = [
  "Any line without strong proof",
  "Risk flags, like a migration or a change to sign-in",
  "Serious findings",
  "Runs that could not finish, and unclear results",
  "Drafted scenarios",
  "Work checked only by the agent that did it",
] as const;

/** What a workflow may say about it: the setting is the project's, and only Quality settings changes it. */
export const finishProjectLine = (on: boolean) => (on
  ? "This project lets work finish by itself when everything is proven."
  : "A person verifies the work in this project.");

/* ---- how strong a line's proof is ----------------------------------------- */

export type ProofSource = "quality" | "tests" | "ci" | "review" | "changes" | "person";
export type ProofStrength = "strong" | "weak" | "none";

const SOURCE_WORD: Record<ProofSource, string> = { quality: "Quality", tests: "Tests", ci: "CI", review: "Review", changes: "The file changed", person: "Needs a person" };

export interface LineProof { source: ProofSource; word: string; strength: ProofStrength }

/**
 * Where a line's proof came from and how much it weighs. The evidence pack gives `basis` and `strong`.
 * A changed file on its own is proven for display and never strong; with passing tests behind it
 * ("add tests for this"), the tests are the proof.
 */
export function lineProof(item: { status: string; basis: string; strong?: boolean | null; proof_source?: string | null }): LineProof {
  if (item.status !== "proven" || item.basis === "none") return { source: "person", word: SOURCE_WORD.person, strength: "none" };
  const named = item.proof_source && item.proof_source in SOURCE_WORD ? item.proof_source as ProofSource : null;
  const strong = item.strong ?? item.basis !== "changes";
  const basis: ProofSource = item.basis === "qa" ? "quality" : item.basis === "tests" ? "tests" : strong ? "tests" : "changes";
  const source = named ?? basis;
  return { source, word: SOURCE_WORD[source], strength: strong ? "strong" : "weak" };
}

/* ---- what the server decided ---------------------------------------------- */

export interface FinishLine { index: number | null; text: string; reason: string }

export interface FinishDecision {
  /** It finished with no person. */
  finished: boolean;
  /** It came to a person, and these are the reasons. */
  toPerson: boolean;
  /** The lines left unproven, each with why. */
  lines: FinishLine[];
  /** Everything else that kept it from finishing. */
  reasons: string[];
  /** Who turned the option on, and when. */
  enabled_by: string | null;
  enabled_at: string | null;
}

const capital = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
/** The server's "QA", as the tab names it. */
export const qualityName = (s: string) => s.replace(/\bQA\b/g, "Quality");

/** `final_decision` from `GET /api/tasks/{tid}/qa`; null when the option played no part. */
export function readFinishDecision(raw: unknown): FinishDecision | null {
  if (!isObj(raw)) return null;
  const lines = listOf<unknown>(raw.lines).filter(isObj).map((l, i) => ({
    index: typeof l.index === "number" ? l.index : i,
    text: text(l.text) ?? `Line ${i + 1}`,
    reason: capital(text(l.why_text) ?? "not proven") + ".",
  }));
  // A line's reason is said on its line; the sum of them would say it twice.
  const reasons = listOf<unknown>(raw.reasons).filter(isObj).filter((r) => !isObj(r) || !String(r.code ?? "").startsWith("line_")).map((r) => text(r.text)).filter((r): r is string => !!r).map(qualityName);
  return { finished: raw.decision === "finished", toPerson: raw.decision === "person", lines, reasons, enabled_by: text(raw.turned_on_by_alias), enabled_at: text(raw.turned_on_at) };
}
