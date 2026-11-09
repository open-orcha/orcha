/** A drafting session's status as the request statuses say it. */
export function draftingRequestStatus(status: string): string {
  return status === "running" ? "running" : status === "done" ? "completed" : status === "failed" || status === "abandoned" ? "failed" : "cancelled";
}
