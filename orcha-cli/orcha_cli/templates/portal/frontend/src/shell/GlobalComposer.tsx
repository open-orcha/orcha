/**
 * Shell-owned New task composer (review: "New task" from Overview / sidebar /
 * palette used to navigate to /tasks?new=1, so Esc left you on Tasks). It is
 * the SAME NewTaskModal the Tasks page renders — one composer, one set of
 * rules (acting human, required Definition of done, AI-only assignee) — with
 * the page's `wk-*` form styles carried along because the Tasks page (which
 * normally injects them) is not mounted on other routes.
 * Lazy-loaded by chrome.tsx only when opened.
 */
import { NewTaskModal } from "../pages/tasks/TaskDetail";
import { workCss } from "../pages/tasks/workCss";

export default function GlobalComposer(props: {
  initialAssignee?: string | null;
  onClose: () => void;
  onCreated: (taskId: string | null) => void;
}) {
  return (
    <>
      <style>{workCss}</style>
      <NewTaskModal {...props} />
    </>
  );
}
