import { useState, type SetStateAction } from "react";
import type { DraftScope } from "./workflowDraft";

// Session-only drafts share the creation form's origin/project/identity boundary.
// A form never queues a mutation or carries a confirmation across navigation.
const forms = new Map<string, unknown>();
export function useWorkflowForm<T>(scope: DraftScope, slot: string, initial: T) {
  const key = JSON.stringify([scope.origin, scope.project, scope.identity, slot]);
  const [state, setState] = useState(() => ({ key, value: (forms.get(key) as T | undefined) ?? initial }));
  // A host may switch identity without remounting its editor. Never carry the
  // previous person's text into that render, even for a single frame.
  const value = state.key === key ? state.value : (forms.get(key) as T | undefined) ?? initial;
  if (state.key !== key) setState({ key, value });
  function update(next: SetStateAction<T>) {
    setState((previousState) => {
      const previous = previousState.key === key ? previousState.value : (forms.get(key) as T | undefined) ?? initial;
      const result = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
      forms.set(key, result); return { key, value: result };
    });
  }
  return [value, update] as const;
}
