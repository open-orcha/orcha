/** V2 primitives: a11y contracts (focus restore/trap, roving keys, status text). */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Breadcrumbs, Button, ConfirmDialog, Dialog, EmptyState, IconButton, List, Menu, Row, SplitPane, StatusDot, Tabs, statusGlyph,
} from "./index";

afterEach(cleanup);

describe("Button / IconButton", () => {
  it("icon buttons always have an accessible name + tooltip", () => {
    render(<IconButton icon="x" label="Close details" />);
    const b = screen.getByRole("button", { name: "Close details" });
    expect(b).toHaveAttribute("title", "Close details");
  });
  it("busy buttons are disabled and aria-busy, label kept", () => {
    render(<Button variant="primary" busy>Approve plan</Button>);
    const b = screen.getByRole("button", { name: "Approve plan" });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b.className).toContain("v2-btn-primary");
  });
});

describe("StatusDot", () => {
  it("carries the exact STAT label (visible or screen-reader) — never colour only", () => {
    render(<><StatusDot status="failed" /><StatusDot status="blocked" showLabel={false} /></>);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Blocked").className).toBe("v2-sr");
  });
  it("failed ≠ blocked and cancelled ≠ completed in glyph", () => {
    expect(statusGlyph("failed")).not.toBe(statusGlyph("blocked"));
    expect(statusGlyph("cancelled")).not.toBe(statusGlyph("completed"));
  });
});

function DialogHarness({ confirm }: { confirm?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open it</button>
      {open && !confirm && (
        <Dialog title="Edit" onClose={() => setOpen(false)} footer={<button onClick={() => setOpen(false)}>Done</button>}>
          <input aria-label="first" />
        </Dialog>
      )}
      {open && confirm && (
        <ConfirmDialog title="Stop run?" description="Stops only this run." danger confirmLabel="Stop run" onConfirm={() => setOpen(false)} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

describe("Dialog", () => {
  it("moves focus in, traps Tab, closes on Escape and restores focus to the opener", async () => {
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "open it" });
    opener.focus();
    fireEvent.click(opener);
    const dlg = await screen.findByRole("dialog", { name: "Edit" });
    const first = screen.getByLabelText("first");
    await waitFor(() => expect(document.activeElement).toBe(first));
    const done = screen.getByRole("button", { name: "Done" });
    done.focus();
    fireEvent.keyDown(dlg, { key: "Tab" }); // last → wraps to first
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
  it("danger confirms focus Cancel first (Enter never fires the destructive action by accident)", async () => {
    render(<DialogHarness confirm />);
    fireEvent.click(screen.getByRole("button", { name: "open it" }));
    await screen.findByRole("dialog", { name: "Stop run?" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
  });
});

function MenuHarness({ onPin }: { onPin: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} aria-haspopup="menu" onClick={() => setOpen(!open)}>More</button>
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} label="Project actions"
        items={[{ label: "Pin", onSelect: onPin }, { label: "Delete", disabled: true, disabledReason: "Owner only" }, { label: "Open", href: "/x" }]} />
    </>
  );
}

describe("Menu", () => {
  it("role=menu with roving arrow keys, Enter selects, Escape closes and returns focus", async () => {
    const onPin = vi.fn();
    render(<MemoryRouter><MenuHarness onPin={onPin} /></MemoryRouter>);
    const trigger = screen.getByRole("button", { name: "More" });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Project actions" });
    const items = screen.getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0], { key: "ArrowDown" }); // skips the disabled item
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: "ArrowDown" }); // wraps
    expect(document.activeElement).toBe(items[0]);
    expect(items[1]).toHaveAttribute("aria-disabled", "true");
    expect(items[1]).toHaveAttribute("title", "Owner only");
    fireEvent.keyDown(items[0], { key: "Enter" });
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    await screen.findByRole("menu");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    void menu;
  });
});

describe("List / Row", () => {
  it("arrow keys move between rows; Enter activates; typing in inputs is never hijacked", () => {
    const act = vi.fn();
    render(
      <List label="Tasks" vimKeys>
        <input aria-label="filter" />
        <Row id="a" onActivate={() => act("a")}>A</Row>
        <Row id="b" selected onActivate={() => act("b")}>B</Row>
        <Row id="c" onActivate={() => act("c")}>C</Row>
      </List>,
    );
    const [a, b, c] = screen.getAllByRole("option");
    expect(b).toHaveAttribute("aria-selected", "true");
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: "j" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "Home" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "Enter" });
    expect(act).toHaveBeenCalledWith("a");
    const filter = screen.getByLabelText("filter");
    filter.focus();
    fireEvent.keyDown(filter, { key: "j" });
    expect(document.activeElement).toBe(filter);
  });
});

describe("Tabs", () => {
  it("roving tabindex with ←/→ and aria wiring", () => {
    function T() {
      const [v, setV] = useState("conversation");
      return <Tabs label="Agent" idPrefix="ag" value={v} onChange={setV} tabs={[{ key: "conversation", label: "Conversation" }, { key: "runs", label: "Runs", count: 3 }, { key: "memory", label: "Memory" }]} />;
    }
    render(<T />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    expect(tabs[1]).toHaveAttribute("aria-controls", "ag-panel-runs");
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" }); // wraps to last
    expect(screen.getAllByRole("tab")[2]).toHaveAttribute("aria-selected", "true");
  });
});

describe("SplitPane", () => {
  it("keyboard-resizable separator, clamped and persisted", () => {
    render(<SplitPane list={<div>list</div>} inspector={<div>detail</div>} defaultSize={400} min={320} max={500} storageKey="orcha:v2:test" />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowLeft", shiftKey: true });
    expect(sep).toHaveAttribute("aria-valuenow", "448");
    fireEvent.keyDown(sep, { key: "Home" });
    expect(sep).toHaveAttribute("aria-valuenow", "500");
    expect(localStorage.getItem("orcha:v2:test")).toBe("500");
  });
  it("no inspector → no separator", () => {
    render(<SplitPane list={<div>list</div>} />);
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

describe("Breadcrumbs / EmptyState", () => {
  it("marks the last crumb as the current page", () => {
    render(<MemoryRouter><Breadcrumbs items={[{ label: "Website", href: "/" }, { label: "Tasks", href: "/tasks" }, { label: "Ship login" }]} /></MemoryRouter>);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(screen.getByText("Ship login")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
  });
  it("danger empty states are announced", () => {
    render(<EmptyState tone="danger" title="Couldn't load tasks" body="Backend unreachable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load tasks");
  });
});
