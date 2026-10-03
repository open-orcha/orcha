/**
 * Round-4 contracts (primitives-tokens): the shared roving-row handler for
 * grouped lists (GitHub), D14 spacing tokens + inset rows, the board aside
 * that never shrinks, and the one-corner-one-meaning avatar badges.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListGroup, List, Row, rowNavKeyDown, moveRowFocus } from "./index";

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, "../../../../static/styles/v2-primitives.css"), "utf8");
const tokens = readFileSync(resolve(__dirname, "../../../../static/styles/v2-tokens.css"), "utf8");
const rule = (sel: string) => {
  const i = css.indexOf(sel + " {");
  expect(i, sel).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf("}", i));
};

function GhLike({ onOpen }: { onOpen: (n: number) => void }) {
  const row = (n: number) => (
    <div key={n} data-gh-row={`issue:${n}`} role="link" tabIndex={0} aria-label={`#${n}`}
      onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") onOpen(n); }}>
      #{n} <button type="button">Start</button>
    </div>
  );
  return (
    <div className="gh-groups" data-testid="groups" onKeyDown={rowNavKeyDown({ selector: "[data-gh-row]", vimKeys: true })}>
      <ListGroup id="tracked" title="Tracked" count={2}>{[231, 187].map(row)}</ListGroup>
      <ListGroup id="closed" title="Collapsed" count={1} defaultOpen={false}>{[150].map(row)}</ListGroup>
      <ListGroup id="untracked" title="Not tracked" count={2}>{[228, 219].map(row)}</ListGroup>
    </div>
  );
}

describe("rowNavKeyDown — shared roving rows for grouped lists", () => {
  it("↓ / j move between rows of any selector, skipping collapsed groups; Enter stays with the row", () => {
    const open = vi.fn();
    render(<GhLike onOpen={open} />);
    const r231 = screen.getByRole("link", { name: "#231" });
    r231.focus();
    fireEvent.keyDown(r231, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "#187" }));
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    // #150 lives in a collapsed group → skipped
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "#228" }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(open).toHaveBeenCalledWith(228);
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "#187" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "#219" }));
  });

  it("focus on a control INSIDE a row still counts as that row", () => {
    render(<GhLike onOpen={() => {}} />);
    const btn = screen.getByRole("link", { name: "#231" }).querySelector("button")!;
    btn.focus();
    fireEvent.keyDown(btn, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "#187" }));
  });

  it("never hijacks typing or modified keys", () => {
    render(
      <div onKeyDown={rowNavKeyDown()}>
        <input aria-label="search" />
        <div data-v2-row="" tabIndex={0}>a</div>
      </div>,
    );
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(input);
    const row = document.querySelector<HTMLElement>("[data-v2-row]")!;
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowDown", metaKey: true });
    expect(document.activeElement).toBe(row);
  });

  it("List keeps its behaviour (Row + ↑/↓ + Home)", () => {
    render(
      <List label="rows">
        <Row id="a">A</Row>
        <Row id="b">B</Row>
        <Row id="c">C</Row>
      </List>,
    );
    const [a, b, c] = screen.getAllByRole("option");
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: "End" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "Home" });
    expect(document.activeElement).toBe(a);
    expect(moveRowFocus(document.body, "x")).toBe(false);
  });
});

describe("D14 spacing discipline", () => {
  it("one set of spacing tokens for rows, trees and groups", () => {
    for (const [k, v] of [["--v2-tree-row-h", "32px"], ["--v2-indent", "16px"], ["--v2-row-px", "12px"], ["--v2-group-gap", "16px"], ["--v2-list-group-gap", "8px"]]) {
      expect(tokens).toMatch(new RegExp(`${k}:\\s*${v}`));
    }
  });
  it("rows are inset + rounded with no divider; group bands breathe", () => {
    const row = rule(".v2-row");
    expect(row).toMatch(/border:\s*0/);
    expect(row).toMatch(/border-radius:\s*var\(--v2-radius-control\)/);
    expect(row).toMatch(/padding:\s*0 var\(--v2-row-px/);
    expect(row).not.toMatch(/border-bottom/);
    expect(css).toMatch(/\.v2-listgroup \+ \.v2-listgroup\s*\{\s*margin-top:\s*var\(--v2-list-group-gap/);
  });
});

describe("Board aside never shrinks", () => {
  it("is a fixed 200px flex item (160 at phone width) and covers the padding strip", () => {
    const a = rule(".v2-board-aside");
    expect(a).toMatch(/flex:\s*0 0 200px/);
    expect(a).toMatch(/min-width:\s*200px/);
    expect(a).toMatch(/box-shadow:[^;]*var\(--v2-panel/);
    expect(css).toMatch(/max-width: 640px\)\s*\{\s*\.v2-board-aside\s*\{\s*flex-basis:\s*160px/);
  });
});
