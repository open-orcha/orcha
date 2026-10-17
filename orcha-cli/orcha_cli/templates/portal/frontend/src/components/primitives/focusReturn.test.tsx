/**
 * QA (brief §7 "restore focus on dialog close"): a dialog whose content uses
 * autoFocus (the New task composer's title input) must still return focus to
 * the opener. React applies autoFocus during commit, before effects run, so
 * the opener has to be captured during render.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "../ui";
import { Dialog } from "./Dialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>New task</button>
      {open ? (
        <Dialog title="New task" onClose={() => setOpen(false)}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input id="nt_title" aria-label="Title" autoFocus />
        </Dialog>
      ) : null}
    </>
  );
}

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>New task</button>
      {open ? (
        <Modal title="New task" primary="Create" onClose={() => setOpen(false)}>
          <label>Kind <select aria-label="Kind"><option>task</option></select></label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input id="nt_title" aria-label="Title" autoFocus />
        </Modal>
      ) : null}
    </>
  );
}

afterEach(cleanup);

describe("useFocusReturn", () => {
  it("returns focus to the opener after closing a dialog whose input autoFocuses", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "New task" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement?.id).toBe("nt_title");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("ui.tsx Modal (the real New task host): autoFocus input keeps focus, Escape returns focus to the opener", () => {
    render(<ModalHarness />);
    const opener = screen.getByRole("button", { name: "New task" });
    opener.focus();
    fireEvent.click(opener);
    // autoFocus wins over "first focusable" (the Kind select precedes it)
    expect(document.activeElement?.id).toBe("nt_title");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
