/**
 * Proof-of-work evidence pack shapes — mirror of
 * GET /api/tasks/{tid}/evidence (portal_backend/evidence_routes.py). Everything here is what
 * the task's own runs recorded; nothing is inferred client-side.
 */

export type DodStatus = "proven" | "not_proven" | "needs_human";

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  total: number;
  unit: string; // "tests" | "packages"
  source: string;
  /** the runner the output revealed ("node:test", "vitest", "jest", "go", …), null when unknown */
  runner?: string | null;
}

export interface TestInvocation {
  run_id: string | null;
  /** the command's runner; a package script whose output revealed its runner reads e.g.
   *  "npm test (node:test)" — plain "npm test" means the framework is unknown */
  framework: string;
  runner?: string | null;
  command: string;
  exit_code: number | null;
  counts: TestCounts | null;
  outcome: "passed" | "failed" | "no_tests" | "exit_ok" | "exit_failed" | "unknown";
}

export interface TestsSummary {
  status: "none" | "passed" | "failed" | "exit_ok" | "unverified";
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  suites: number;
  invocations: number;
  latest: TestInvocation[];
  earlier: number;
}

export interface RiskFlag {
  kind: "migration" | "auth" | "secrets" | "deletion" | "large_diff" | "dependencies" | "ci" | string;
  label: string;
  detail: string;
  severity: "warn" | "danger";
  files: string[];
  count: number;
}

export interface ChangedFile {
  path: string;
  status: string | null;
  additions: number | null;
  deletions: number | null;
  binary?: boolean | null;
  run_id: string;
}

export interface ChangesSummary {
  files: number;
  additions: number;
  deletions: number;
  categories: Record<string, number>;
  summary: string;
  ui_touching: boolean;
  flags: RiskFlag[];
  list: ChangedFile[];
  truncated_list: boolean;
  unavailable_runs: { run_id: string; reason: string | null; detail: string | null }[];
}

export interface DodItem {
  index: number;
  text: string;
  status: DodStatus;
  basis: "tests" | "changes" | "none" | "qa";
  evidence: string | null;
  related?: string[];
  claim?: string;
  /** basis "qa": QA gave this line a verdict; its screenshots and the request behind it. */
  frame_ids?: string[] | null;
  qa_request_id?: string | null;
  /** Proof of the work itself: a verdict or passing tests. A changed file never is (`lineProof`). */
  strong?: boolean;
  proof_source?: string | null;
}

/** A QA request behind this pack. */
export interface EvidenceQa {
  id: string;
  kind: string;
  platform: string | null;
  round: number;
  status: string;
  summary: string | null;
}

export interface EvidenceLink {
  kind: "live_changes" | "captured_diff" | "runs" | "pr" | string;
  label: string;
  href: string;
  run_id?: string;
}

export interface EvidenceSummary {
  dod: { total: number; proven: number; not_proven: number; needs_human: number };
  tests: { status: TestsSummary["status"]; passed: number; failed: number; skipped: number; errors: number; suites: number };
  risk_flags: number;
  line: string;
}

export interface EvidencePack {
  version: number;
  task_id: string;
  task_status: string;
  basis: string;
  built_at: string;
  round_started_at: string | null;
  runs: { run_id: string; agent_alias: string | null; status: string; exit_code: number | null; lane: string | null; started_at: string | null; ended_at: string | null }[];
  tests: TestsSummary;
  changes: ChangesSummary;
  flags: RiskFlag[];
  branch: string | null;
  pr_urls: string[];
  preview_urls: string[];
  links: EvidenceLink[];
  claim: { text: string; truncated: boolean } | null;
  dod_text: string;
  dod: { items: DodItem[]; total: number; proven: number; not_proven: number; needs_human: number };
  summary: EvidenceSummary;
  rebuilt?: boolean;
  /** The task's QA requests. */
  qa?: EvidenceQa[];
}
