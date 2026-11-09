/** A feature's coverage as the map shows it: its word and its dot. */
import type { FeatureCoverage } from "./types";

export const COVERAGE_LABEL: Record<FeatureCoverage, string> = {
  untested: "Untested",
  thin: "Thin",
  covered: "Covered",
  strong: "Strong",
  failing: "Covered but failing",
};

export const STATE_DOT: Record<FeatureCoverage, string> = {
  strong: "bg-[var(--cov-strong)]",
  covered: "bg-[var(--cov-covered)]",
  thin: "bg-[var(--cov-thin)]",
  failing: "bg-[var(--cov-failing)]",
  untested: "bg-transparent border border-dashed border-[var(--cov-untested)]",
};
