/** The provider's key handling: terminals/code editors keep ⌥Space; Enter is never touched. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationProvider } from "./DictationHost";
import { fakeRig, flush } from "./testFakes";

afterEach(cleanup);

describe("DictationProvider keys", () => {
  it("⌥Space inside a terminal or code editor is left alone", async () => {
    const rig = fakeRig();
    render(
      <DictationProvider cid="c1" deps={rig.deps}>
        <div className="xterm"><textarea aria-label="Terminal input" /></div>
      </DictationProvider>,
    );
    const ta = screen.getByLabelText("Terminal input");
    act(() => ta.focus());
    const ev = new KeyboardEvent("keydown", { key: " ", code: "Space", altKey: true, bubbles: true, cancelable: true });
    await act(async () => { ta.dispatchEvent(ev); await flush(); });
    expect(ev.defaultPrevented).toBe(false);
    expect(rig.mic.opts).toBeNull();
  });

  it("Enter and ⌘↵ pass straight through while dictating", async () => {
    const rig = fakeRig();
    const onKey = vi.fn();
    render(
      <DictationProvider cid="c1" deps={rig.deps}>
        <textarea aria-label="Reply" onKeyDown={(e) => onKey(e.key, e.metaKey)} />
      </DictationProvider>,
    );
    const ta = screen.getByLabelText("Reply");
    act(() => ta.focus());
    await act(async () => { fireEvent.keyDown(ta, { key: " ", code: "Space", altKey: true }); await flush(); });
    act(() => rig.engine.ready());
    fireEvent.keyDown(ta, { key: "Enter" });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    expect(onKey.mock.calls).toEqual([["Enter", false], ["Enter", true]]);
  });

  it("dictation off → no mic, no shortcut", async () => {
    const rig = fakeRig({ engine: "off" });
    localStorage.setItem("orcha:voice", JSON.stringify({ engine: "off" }));
    render(
      <DictationProvider cid="c1" deps={rig.deps}>
        <textarea aria-label="Note" />
      </DictationProvider>,
    );
    const ta = screen.getByLabelText("Note");
    act(() => ta.focus());
    await act(async () => { fireEvent.keyDown(ta, { key: " ", code: "Space", altKey: true }); await flush(); });
    expect(rig.mic.opts).toBeNull();
    expect(screen.queryByTestId("dictation-mic")).toBeNull();
    localStorage.clear();
  });
});
