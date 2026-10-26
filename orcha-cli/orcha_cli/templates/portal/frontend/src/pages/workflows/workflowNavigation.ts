/** Navigation hints preserve a reader's place; they never establish access. */
export function workflowListReturnTarget(raw: unknown, cid: string): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/workflows?") || raw.includes("\\")) return null;
  const url = new URL(raw, "https://local.invalid");
  if (url.origin !== "https://local.invalid" || url.pathname !== "/workflows" || url.searchParams.get("cid") !== cid) return null;
  const query = new URLSearchParams({ cid });
  const status = url.searchParams.get("status");
  if (status && ["open", "preparing", "active", "paused", "ready", "completed", "cancelled", "all"].includes(status)) query.set("status", status);
  for (const key of ["search", "owner"]) {
    const value = url.searchParams.get(key);
    if (value) query.set(key, value);
  }
  return `/workflows?${query}`;
}

export function workflowNavigationState(state: unknown): { workflowListReturn?: string; workflowListFocus?: string } {
  if (!state || typeof state !== "object") return {};
  const value = state as Record<string, unknown>;
  return {
    ...(typeof value.workflowListReturn === "string" ? { workflowListReturn: value.workflowListReturn } : {}),
    ...(typeof value.workflowListFocus === "string" ? { workflowListFocus: value.workflowListFocus } : {}),
  };
}
