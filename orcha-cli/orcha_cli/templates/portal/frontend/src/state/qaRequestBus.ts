/**
 * "A QA request changed": the project's event stream (`qa_request_changed`) and sends from this tab
 * both ring it, so every view showing requests reads them again at once. No polling when idle.
 */
import { useEffect, useState } from "react";

const changes = new EventTarget();

export const requestsChanged = () => { changes.dispatchEvent(new Event("change")); };

/** A number that moves whenever a QA request changes. */
export function useRequestsChanged(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((x) => x + 1);
    changes.addEventListener("change", on);
    return () => changes.removeEventListener("change", on);
  }, []);
  return n;
}
