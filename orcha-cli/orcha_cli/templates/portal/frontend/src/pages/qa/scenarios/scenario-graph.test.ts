// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScenarioGraph, type GraphScenario } from "./scenario-graph";

beforeAll(() => {
  // xyflow measures its viewport and nodes; jsdom has no layout engine.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1;
    constructor() {}
  } as unknown as typeof DOMMatrixReadOnly;
});

afterEach(cleanup);

function scenario(id: string, name: string): GraphScenario {
  return { id, name, category: null, status: "validated", criteria: [], depends_on: [], position: null, target_kind: null } as unknown as GraphScenario;
}

const SCENARIOS = [scenario("guest", "Guest browse properties"), scenario("logout", "Admin logout"), scenario("login", "Admin login with real 2fa")];

/** The Map's selection as the canvas holds it: a node click asks, and the open panel's guard
 * decides. `keepEditing` holds the click back, as "Keep editing" does; otherwise it applies, as
 * "Discard" does (#189). */
function Harness({ decide }: { decide: () => "keep" | "discard" }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(["guest"]));
  return createElement(
    "div",
    { style: { width: 800, height: 600 } },
    createElement("output", { "data-selected": [...selected].sort().join(",") }),
    createElement(ScenarioGraph, {
      scenarios: SCENARIOS,
      editable: true,
      selectedIds: selected,
      onSelectionChange: (ids: string[]) => {
        if (decide() === "discard") setSelected(new Set(ids));
      },
    }),
  );
}

const node = (c: HTMLElement, id: string) => c.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
const selectedNow = (c: HTMLElement) => c.querySelector("[data-selected]")!.getAttribute("data-selected");
const marked = (c: HTMLElement) =>
  [...c.querySelectorAll(".react-flow__node.selected")].map((n) => n.getAttribute("data-id")).sort();

describe("ScenarioGraph controlled selection (#189)", () => {
  it("leaves the map on the open scenario after Keep editing, and asks again on the next click", async () => {
    let asked = 0;
    const { container } = render(createElement(Harness, { decide: () => (asked++, "keep" as const) }));
    await act(async () => {});
    expect(marked(container)).toEqual(["guest"]);
    // Click "Admin logout" with unsaved edits, then Keep editing: nothing moves.
    fireEvent.click(node(container, "logout"));
    await act(async () => {});
    expect(selectedNow(container)).toBe("guest");
    expect(marked(container)).toEqual(["guest"]);
    // It was left marked selected, so clicking it again did nothing: no prompt, no switch.
    fireEvent.click(node(container, "logout"));
    await act(async () => {});
    expect(asked).toBe(2);
  });

  it("opens only the picked scenario on Discard after an earlier Keep editing", async () => {
    let answer: "keep" | "discard" = "keep";
    const { container } = render(createElement(Harness, { decide: () => answer }));
    await act(async () => {});
    fireEvent.click(node(container, "logout"));
    await act(async () => {});
    // A third node, then Discard: that scenario alone, not "2 selected".
    answer = "discard";
    fireEvent.click(node(container, "login"));
    await act(async () => {});
    expect(selectedNow(container)).toBe("login");
    expect(marked(container)).toEqual(["login"]);
  });
});
