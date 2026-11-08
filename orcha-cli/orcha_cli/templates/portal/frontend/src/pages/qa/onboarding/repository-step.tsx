import { TestsFound } from "./tests-found";
import { Field, PLATFORM_NAMES } from "./ui";
import type { FoundSheet } from "./contract";
import type { WizardState } from "./state";

/**
 * Step 1: the repository is the project's own folder, so there is nothing to pick: it is read
 * on the spot and what it holds is said here (platforms, ids, tests).
 */
export function RepositoryStep({ state, found, reading, error }: { state: WizardState; found: FoundSheet | null; reading: boolean; error: string | null }) {
  const detectedByKind = new Map<string, { subdirs: string[]; locator: string }>();
  for (const t of state.targets) {
    if (!t.detected) continue;
    const entry = detectedByKind.get(t.kind) ?? { subdirs: [], locator: "" };
    if (t.subdir) entry.subdirs.push(t.subdir);
    if (t.kind !== "web" && t.locator) entry.locator = t.locator;
    detectedByKind.set(t.kind, entry);
  }
  const detectedSummary = (["ios", "android", "web"] as const)
    .filter((k) => detectedByKind.has(k))
    .map((k) => {
      const { subdirs, locator } = detectedByKind.get(k) ?? { subdirs: [], locator: "" };
      const unique = [...new Set(subdirs)];
      const parts = [unique.length > 0 ? unique.join(", ") : null, locator || null].filter(Boolean);
      return parts.length > 0 ? `${PLATFORM_NAMES[k]} (${parts.join(", ")})` : PLATFORM_NAMES[k];
    });

  return (
    <div className="flex flex-col gap-3.5">
      <Field label="Repository" hint="The project's folder, used in place, so uncommitted work is testable too.">
        <p className="truncate font-mono text-sm text-fg" data-onboarding-repo>
          {state.repoUrl || (reading ? "Reading the project folder…" : "The project folder")}
        </p>
      </Field>
      {detectedSummary.length > 0 ? (
        <p className="text-xs text-muted" data-detected-platforms>
          Detected: {detectedSummary.join(", ")}
        </p>
      ) : null}
      {!error ? <TestsFound found={found} reading={reading} /> : null}
    </div>
  );
}
