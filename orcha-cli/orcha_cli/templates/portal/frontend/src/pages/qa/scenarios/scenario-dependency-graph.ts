/**
 * Pure dependency-graph checks for drag-to-connect on the scenario canvas
 * (spec §3 toolbar rework): whether adding `source -> target` (target
 * depends on source) is a self-reference, a duplicate of an existing edge,
 * or would close a cycle in the `depends_on` graph.
 */

export interface DependencyCheckInput {
  id: string;
  depends_on: readonly string[];
}

export type DependencyCheckResult =
  | { ok: true }
  | { ok: false; reason: "self" | "duplicate" | "cycle" };

/**
 * `target` is about to gain `source` in its `depends_on`. Returns why that
 * is refused, or `{ ok: true }` when it is safe to PATCH.
 */
export function checkNewDependency(
  scenarios: readonly DependencyCheckInput[],
  sourceId: string,
  targetId: string,
): DependencyCheckResult {
  if (sourceId === targetId) return { ok: false, reason: "self" };

  const target = scenarios.find((s) => s.id === targetId);
  if (target?.depends_on.includes(sourceId)) {
    return { ok: false, reason: "duplicate" };
  }

  // Would `target` become reachable from `source` once the edge exists?
  // i.e. does `source` (or anything it depends on) already depend on `target`,
  // transitively? If so, `target -> source -> ... -> target` is a cycle.
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const stack = [sourceId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return { ok: false, reason: "cycle" };
    if (seen.has(current)) continue;
    seen.add(current);
    const node = byId.get(current);
    if (!node) continue;
    for (const dep of node.depends_on) stack.push(dep);
  }

  return { ok: true };
}

/** Human-readable toast copy for a refused dependency. */
export function dependencyRefusalMessage(reason: "self" | "duplicate" | "cycle"): string {
  switch (reason) {
    case "self":
      return "A scenario cannot depend on itself.";
    case "duplicate":
      return "That dependency already exists.";
    case "cycle":
      return "That would create a dependency cycle.";
  }
}

/**
 * The dependency cycle `id` sits on, as the ids along it starting and ending at `id`
 * (`[a, b, a]` for a depends on b, b on a), or null when following `depends_on` from `id`
 * never comes back to it. The server uses it where an edge arrives other than by drag:
 * the panel's checkboxes, a version restore and Validate (#148).
 */
export function findCycleThrough(
  scenarios: readonly DependencyCheckInput[],
  id: string,
): string[] | null {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const seen = new Set<string>();
  // Depth-first with the path kept, so the refusal can name the cycle.
  const walk = (current: string, path: string[]): string[] | null => {
    for (const dep of byId.get(current)?.depends_on ?? []) {
      if (dep === id) return [...path, id];
      if (seen.has(dep)) continue;
      seen.add(dep);
      const found = walk(dep, [...path, dep]);
      if (found) return found;
    }
    return null;
  };
  return walk(id, [id]);
}
