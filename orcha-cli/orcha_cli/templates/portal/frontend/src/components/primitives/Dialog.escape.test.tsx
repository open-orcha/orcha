/** Requests r1 finding: after a failed submit the busy (disabled) button drops
 *  focus to <body>, and Escape stopped closing the dialog. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Dialog } from "./Dialog";

afterEach(cleanup);

describe("Dialog Escape with focus lost to <body>", () => {
  it("closes the dialog when focus is on <body>", () => {
    const onClose = vi.fn();
    render(<Dialog title="Close request" onClose={onClose}><textarea /></Dialog>);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("only the topmost dialog closes; focus inside a dialog is still handled once", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(<><Dialog title="Outer" onClose={outer} /><Dialog title="Inner" onClose={inner}><input aria-label="x" /></Dialog></>);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    // focus inside: the dialog's own handler closes it, the fallback stays out
    const input = document.querySelector<HTMLInputElement>('input[aria-label="x"]')!;
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(outer).not.toHaveBeenCalled();
  });
});
