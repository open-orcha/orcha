// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { modifierClickNodeId, selectionAfterChanges, toggleSelection } from "./modifier-select";

function nodeLabel(id: string): Element {
  const node = document.createElement("div");
  node.className = "react-flow__node react-flow__node-scenario";
  node.setAttribute("data-id", id);
  const label = document.createElement("span");
  node.appendChild(label);
  document.body.appendChild(node);
  return label;
}

const click = (target: EventTarget | null, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  button: 0,
  target,
  ...mods,
});

describe("modifier-click selection (D100)", () => {
  it("finds the node under a ⌘, Ctrl or Shift click, from the click's own modifiers", () => {
    const label = nodeLabel("register");
    expect(modifierClickNodeId(click(label, { metaKey: true }))).toBe("register");
    expect(modifierClickNodeId(click(label, { ctrlKey: true }))).toBe("register");
    expect(modifierClickNodeId(click(label, { shiftKey: true }))).toBe("register");
  });

  it("leaves plain clicks, other buttons and pane clicks to the graph", () => {
    const label = nodeLabel("login");
    expect(modifierClickNodeId(click(label, {}))).toBeNull();
    expect(modifierClickNodeId({ ...click(label, { metaKey: true }), button: 2 })).toBeNull();
    expect(modifierClickNodeId(click(document.body, { shiftKey: true }))).toBeNull();
  });

  it("takes one draft out of a 'Select 20 drafts' selection, and puts it back", () => {
    const all = new Set(Array.from({ length: 20 }, (_, i) => `d${i}`));
    const without = toggleSelection(all, "d7");
    expect(without).toHaveLength(19);
    expect(without).not.toContain("d7");
    expect(toggleSelection(new Set(without), "d7")).toHaveLength(20);
  });
});

describe("selection from xyflow's select changes", () => {
  it("applies a click, a pane click and a box select", () => {
    expect(selectionAfterChanges(new Set(), [{ type: "select", id: "a", selected: true }])).toEqual(["a"]);
    expect(
      selectionAfterChanges(new Set(["a"]), [
        { type: "select", id: "a", selected: false },
        { type: "select", id: "b", selected: true },
      ]),
    ).toEqual(["b"]);
    expect(selectionAfterChanges(new Set(["a", "b"]), [{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }])).toEqual([]);
  });

  it("is null when nothing changes, so a selection set by the canvas (a ?scenario= link) is never undone", () => {
    expect(selectionAfterChanges(new Set(["a"]), [{ type: "position", id: "a" }, { type: "dimensions", id: "b" }])).toBeNull();
    expect(selectionAfterChanges(new Set(["a"]), [{ type: "select", id: "a", selected: true }])).toBeNull();
    expect(selectionAfterChanges(new Set(["a"]), [])).toBeNull();
  });
});
