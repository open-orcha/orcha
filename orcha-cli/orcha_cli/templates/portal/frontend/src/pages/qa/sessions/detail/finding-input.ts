/**
 * An exploration's finding (or one of its report's Next steps) as the input of the shared
 * finding → scenario mapping (`lib/scenarios/finding-scenario.ts`,). The agent finding's run record
 * (expected, actual, repro; `runFindings` by finding id, `repro` by finding id) makes the draft
 * real; with one, the source is the run's finding, so
 * the exploration's sheet, its report and the run's own Findings tab all name it the same way.
 */
import type { ExplorationResult, Finding, ResultFinding } from "../explorations";
import type { FindingInput } from "../findings/finding-scenario";

export function findingInputOf(
  f: ResultFinding,
  run: Finding | null,
  repro: readonly string[],
  explorationId: string,
  platform: string | null,
): FindingInput {
  return {
    title: f.title,
    expected: run?.expected ?? null,
    actual: run?.actual ?? null,
    note: run?.note ?? null,
    severity: f.severity,
    lens: f.lens,
    feature: f.feature ?? null,
    screen: f.screen ?? null,
    repro: [...repro],
    platform,
    source: run
      ? { kind: "finding", run_id: run.run_id, seq: run.seq, finding_id: run.id, step: f.step_seq ?? run.repro_to_step ?? null, frame: f.evidence ?? null }
      : { kind: "exploration_finding", exploration_id: explorationId, fingerprint: f.fingerprint, step: f.step_seq ?? null, frame: f.evidence ?? null },
  };
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "add", "scenario", "with", "it", "no", "not", "over", "under"]);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

type NextStep = ExplorationResult["next"][number];

/**
 * The finding a Next step came from: the one it names (`finding`, a fingerprint, on results
 * composed since), else for a "Fix: <title>" step the agent finding with that title, else
 * the finding whose title shares the most words with the step. Null when none matches.
 */
export function nextStepFinding(step: NextStep, result: ExplorationResult): ResultFinding | null {
  if (step.finding) {
    const named = result.findings.find((f) => f.fingerprint === step.finding);
    if (named) return named;
  }
  if (step.kind === "fix") {
    const title = step.title.replace(/^fix:\s*/i, "").trim().toLowerCase();
    const same = result.findings.find((f) => f.source === "agent" && f.title.trim().toLowerCase() === title);
    if (same) return same;
  }
  const want = words(`${step.title} ${step.detail ?? ""}`);
  let best: ResultFinding | null = null;
  let score = 1;
  for (const f of result.findings) {
    const shared = [...words(f.title)].filter((w) => want.has(w)).length;
    if (shared > score) {
      score = shared;
      best = f;
    }
  }
  return best;
}

/** A Next step's draft input: the finding it came from (`nextStepFinding`), else the step. */
export function nextStepInput(
  step: NextStep,
  result: ExplorationResult,
  runFindings: ReadonlyMap<string, Finding>,
  repro: Record<string, string[]>,
  explorationId: string,
  platform: string | null,
): FindingInput {
  const best = nextStepFinding(step, result);
  if (best) {
    const run = best.ref_id ? (runFindings.get(best.ref_id) ?? null) : null;
    return findingInputOf(best, run, run ? (repro[run.id] ?? []) : [], explorationId, platform);
  }
  return {
    title: step.title.replace(/^add a scenario:\s*/i, ""),
    note: step.detail ?? null,
    feature: step.feature ?? null,
    platform,
    source: { kind: "next_step", exploration_id: explorationId, title: step.title },
  };
}
