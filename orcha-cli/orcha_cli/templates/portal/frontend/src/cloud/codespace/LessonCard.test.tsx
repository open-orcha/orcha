/**
 * LessonCard — the lesson rendering (title, summary, steps, concepts, follow-ups),
 * the paragraph fallback, Prev/Next + ←/→ stepping with progress, and the editor
 * bridge (onFocusLines gets the active step's local line ranges; a ref to another
 * file asks the page to open it).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LessonCard, type LessonCardProps } from "./LessonCard";
import { parseLesson } from "./lesson";

const MD = `# How ⌘K reaches the palette
> Shell listens once and broadcasts a custom event.

## Steps
1. **Register once** (L19-20) the effect has an empty dependency list.
2. **Match the chord** (L21) metaKey || ctrlKey covers both platforms.
3. **Broadcast** dispatches an event; the palette lives in palette/Palette.tsx:12-14.

## Key concepts
- Effect cleanup
- Custom DOM events

## Follow-ups
- What happens when CodeMirror has focus?
`;

function mount(props: Partial<LessonCardProps> = {}, md = MD) {
  const onFocusLines = vi.fn();
  const utils = render(
    <LessonCard
      lesson={parseLesson(md, { path: "src/shell/Shell.tsx", fallbackTitle: "Why dispatch an event?" })}
      kind="teach"
      path="src/shell/Shell.tsx"
      anchor={{ start: 19, end: 28 }}
      agentAlias="atlas"
      onFocusLines={onFocusLines}
      {...props}
    />,
  );
  return { ...utils, onFocusLines };
}

const progress = () => screen.getByRole("progressbar", { name: /lesson progress/i });
const activeTitle = () => document.querySelector(".cs-lesson-step.is-active .cs-lesson-step-title")?.textContent;

describe("LessonCard", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders a lesson: title, summary, steps, concepts, follow-ups, agent", () => {
    mount({ onFollowUp: () => {} });
    expect(screen.getByRole("heading", { name: "How ⌘K reaches the palette" })).toBeInTheDocument();
    expect(screen.getByText("Shell listens once and broadcasts a custom event.")).toBeInTheDocument();
    expect(document.querySelectorAll(".cs-lesson-step")).toHaveLength(3);
    expect(screen.getByText("Effect cleanup")).toBeInTheDocument();
    expect(screen.getByText("Custom DOM events")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /what happens when codemirror has focus/i })).toBeInTheDocument();
    expect(screen.getByText("@atlas")).toBeInTheDocument();
    expect(screen.getByText("Shell.tsx:19–28")).toBeInTheDocument();
    expect(progress()).toHaveAttribute("aria-valuetext", "Step 1 of 3");
  });

  it("the first step focuses its cited lines in the editor", () => {
    const { onFocusLines } = mount();
    expect(onFocusLines).toHaveBeenLastCalledWith([{ start: 19, end: 20 }]);
  });

  it("Next / Prev step through the lesson, updating progress and focus", () => {
    const { onFocusLines } = mount();
    const prev = screen.getByRole("button", { name: "Previous step" });
    const next = screen.getByRole("button", { name: "Next step" });
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    expect(activeTitle()).toBe("Match the chord");
    expect(progress()).toHaveAttribute("aria-valuenow", "2");
    expect(onFocusLines).toHaveBeenLastCalledWith([{ start: 21, end: 21 }]);
    fireEvent.click(next);
    expect(next).toBeDisabled();
    // step 3 only cites ANOTHER file → nothing to glow in this file
    expect(onFocusLines).toHaveBeenLastCalledWith(null);
    fireEvent.click(prev);
    expect(activeTitle()).toBe("Match the chord");
  });

  it("← / → on the document step the lesson (ignored while typing)", () => {
    const { onFocusLines } = mount();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(activeTitle()).toBe("Match the chord");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(activeTitle()).toBe("Broadcast");
    fireEvent.keyDown(document, { key: "ArrowRight" }); // clamps at the end
    expect(activeTitle()).toBe("Broadcast");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(activeTitle()).toBe("Match the chord");
    expect(onFocusLines).toHaveBeenLastCalledWith([{ start: 21, end: 21 }]);

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(activeTitle()).toBe("Match the chord");
    fireEvent.keyDown(document, { key: "ArrowRight", metaKey: true });
    expect(activeTitle()).toBe("Match the chord");
    input.remove();
  });

  it("clicking a step dot jumps to it", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Go to step 3" }));
    expect(activeTitle()).toBe("Broadcast");
    expect(document.querySelector(".cs-lesson-step.is-active")).toHaveAttribute("aria-current", "step");
  });

  it("a ref chip to this file pins that range; a ref to another file opens it", () => {
    const onOpenFileRef = vi.fn();
    const { onFocusLines } = mount({ onOpenFileRef });
    fireEvent.click(screen.getByRole("button", { name: "Go to step 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Palette.tsx:L12–14" }));
    expect(onOpenFileRef).toHaveBeenCalledWith(expect.objectContaining({ path: "palette/Palette.tsx", start: 12, end: 14 }));
    fireEvent.click(screen.getByRole("button", { name: "L21" }));
    expect(activeTitle()).toBe("Match the chord");
    expect(onFocusLines).toHaveBeenLastCalledWith([{ start: 21, end: 21 }]);
  });

  it("follow-ups ask a new lesson in one click", () => {
    const onFollowUp = vi.fn();
    mount({ onFollowUp });
    fireEvent.click(screen.getByRole("button", { name: /what happens when codemirror has focus/i }));
    expect(onFollowUp).toHaveBeenCalledWith("What happens when CodeMirror has focus?");
  });

  it("unmounting clears the editor focus", () => {
    const { onFocusLines, unmount } = mount();
    act(() => unmount());
    expect(onFocusLines).toHaveBeenLastCalledWith(null);
  });

  it("plain markdown without steps falls back to paragraphs that still highlight their refs", () => {
    const prose = "Shell never imports the palette; line 23 dispatches an event.\n\nThe listener on lines 19–28 only knows a chord.\n\nSearch for the event name to find the other end.";
    const { onFocusLines } = mount({}, prose);
    expect(screen.getByRole("heading", { name: "Why dispatch an event?" })).toBeInTheDocument();
    expect(document.querySelector(".cs-lesson.is-prose")).not.toBeNull();
    expect(document.querySelectorAll(".cs-lesson-step")).toHaveLength(3);
    expect(document.querySelectorAll(".cs-lesson-step-title")).toHaveLength(0);
    expect(onFocusLines).toHaveBeenLastCalledWith([{ start: 23, end: 23 }]);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onFocusLines).toHaveBeenLastCalledWith([{ start: 19, end: 28 }]);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onFocusLines).toHaveBeenLastCalledWith(null);
    expect(progress()).toHaveAttribute("aria-valuetext", "Step 3 of 3");
  });

  it("a one-paragraph answer has no stepper chrome", () => {
    mount({}, "It caches the result on L4.");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next step" })).not.toBeInTheDocument();
  });
});
