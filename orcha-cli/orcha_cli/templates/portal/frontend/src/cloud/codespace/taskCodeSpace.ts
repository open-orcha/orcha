/**
 * Navigation contract for the task-linked, read-only Code Space.
 *
 * The URL carries durable review context (task + optional run). The originating
 * page and scroll position stay in sessionStorage because they are browser-tab
 * state, not shareable review state. This keeps copied Code Space links clean
 * while making Close/Escape return to the exact task-thread reading position.
 */
const ORIGIN_KEY = "orcha:task-code-space:origin";

export interface TaskCodeSpaceOrigin {
  href: string;
  scrollY: number;
  taskId: string;
}

export function taskCodeSpaceHref(taskId: string, runId?: string | null): string {
  const q = new URLSearchParams({ task: taskId, view: "diff" });
  if (runId) q.set("run", runId);
  return "/code?" + q.toString();
}

export function rememberTaskCodeSpaceOrigin(taskId: string): void {
  try {
    const origin: TaskCodeSpaceOrigin = {
      href: window.location.pathname + window.location.search,
      scrollY: window.scrollY,
      taskId,
    };
    sessionStorage.setItem(ORIGIN_KEY, JSON.stringify(origin));
  } catch {
    // Private browsing / storage denial: Close still has the task URL fallback.
  }
}

export function readTaskCodeSpaceOrigin(taskId: string): TaskCodeSpaceOrigin {
  try {
    const raw = sessionStorage.getItem(ORIGIN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TaskCodeSpaceOrigin>;
      const originHref = parsed.href;
      const isSupportedOrigin =
        typeof originHref === "string" &&
        (originHref.startsWith("/tasks") || originHref.startsWith("/agents"));
      if (parsed.taskId === taskId && isSupportedOrigin) {
        return {
          href: originHref,
          scrollY: Number.isFinite(parsed.scrollY) ? Number(parsed.scrollY) : 0,
          taskId,
        };
      }
    }
  } catch {
    // Fall through to the stable task deep link.
  }
  return { href: "/tasks?task=" + encodeURIComponent(taskId), scrollY: 0, taskId };
}
