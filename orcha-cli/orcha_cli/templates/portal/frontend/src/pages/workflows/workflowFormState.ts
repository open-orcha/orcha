import { useState, type SetStateAction } from "react";
import type { DraftScope } from "./workflowDraft";

// Session-only drafts share the creation form's origin/project/identity boundary.
// A form never queues a mutation or carries a confirmation across navigation.
const forms = new Map<string, unknown>();
export function useWorkflowForm<T>(scope: DraftScope, slot: string, initial: T) {
  const key = JSON.stringify([scope.origin, scope.project, scope.identity, slot]);
  const [value, setValue] = useState<T>(() => (forms.get(key) as T | undefined) ?? initial);
  function update(next: SetStateAction<T>) {
    setValue((previous) => {
      const result = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
      forms.set(key, result); return result;
    });
  }
  return [value, update] as const;
}
