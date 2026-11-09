// @vitest-environment jsdom
/**
 * fix/example-secrets: the Examples editor shows a secret column as dots (a value typed, a value
 * stored before the fix, or a sealed reference), never in the DOM's text or attributes, with a
 * per-column toggle and an eye that shows the value only while it is held. Values are made up.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withScenarios } from "./test-wrap";
import type { ExamplesTable } from "./examples";
import { ExamplesField } from "./examples-field";

const PASSWORD = "Kiboko!Tanga-2026"; // fake
const STORED = "Simba#Mombasa-77"; // fake, "in the encrypted store"
const REF = `secret:sec_${"cd".repeat(16)}`;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((url: string) => {
    if (String(url).endsWith("/examples/reveal")) return Promise.resolve(new Response(JSON.stringify({ value: STORED })));
    // The row results: a run of row 1 stored before the fix.
    return Promise.resolve(
      new Response(JSON.stringify({ rows: [{ row: 0, values: { EMAIL: "amani@example.com", PASSWORD: "••••" }, label: "EMAIL = amani@example.com, PASSWORD = ••••", state: "passed", outcome: "pass", reason: null, runId: "run-1", requestId: "c1", at: "2026-10-26T10:00:00Z" }] })),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The DOM's markup plus every input's live value (a property, not markup). */
function everything(): string {
  const values = [...document.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value).join("\n");
  return `${document.body.outerHTML}\n${values}`;
}

function renderField(value: ExamplesTable, onChange = vi.fn()) {
  return render(
    withScenarios(createElement(ExamplesField, { value, onChange, texts: ["{{EMAIL}} {{PASSWORD}}"], scenarioId: "11111111-2222-4333-8444-555555555555" })),
  );
}

describe("ExamplesField secret columns", () => {
  it("shows a plain (pre-fix) value and a sealed reference as dots, and marks the column secret", async () => {
    renderField({ columns: ["EMAIL", "PASSWORD"], rows: [["amani@example.com", PASSWORD], ["neema@example.com", REF]] });
    await act(async () => {});
    const inputs = [...document.querySelectorAll<HTMLInputElement>("[data-secret-cell] input")];
    expect(inputs).toHaveLength(2);
    expect(inputs.every((i) => i.type === "password")).toBe(true);
    expect(inputs[1].value).toBe(""); // a sealed cell shows only that something is stored
    const toggle = (col: string) => document.querySelector(`[data-examples-column="${col}"] [data-examples-secret-toggle]`)?.getAttribute("data-examples-secret-toggle");
    expect([toggle("EMAIL"), toggle("PASSWORD")]).toEqual(["off", "on"]);
    expect(document.body.outerHTML).not.toContain(PASSWORD);
    expect(everything()).not.toContain(REF);
    expect(everything()).not.toContain(STORED);
  });

  it("holding the eye on a stored cell shows its value only while held", async () => {
    renderField({ columns: ["EMAIL", "PASSWORD"], rows: [["neema@example.com", REF]], secret: ["PASSWORD"] });
    const eye = document.querySelector<HTMLButtonElement>("[data-secret-reveal]")!;
    await act(async () => {
      fireEvent.pointerDown(eye);
    });
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/examples/reveal"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ ref: REF.replace("secret:", ""), actor_agent_id: "h1" });
    expect(everything()).toContain(STORED);
    await act(async () => {
      fireEvent.pointerUp(eye);
    });
    expect(everything()).not.toContain(STORED);
  });

  it("the toggle turns a column secret and back, clearing stored cells", () => {
    const onChange = vi.fn();
    renderField({ columns: ["EMAIL", "PASSWORD"], rows: [["neema@example.com", REF]], secret: ["PASSWORD"] }, onChange);
    fireEvent.click(document.querySelector("[data-examples-secret-toggle='on']")!);
    expect(onChange).toHaveBeenLastCalledWith({ columns: ["EMAIL", "PASSWORD"], rows: [["neema@example.com", ""]], secret: [] });
  });

  it("a pasted sheet marks its password column secret", () => {
    const onChange = vi.fn();
    render(withScenarios(createElement(ExamplesField, { value: null, onChange, texts: [] })));
    fireEvent.click(document.querySelector("[data-examples-paste-start]")!);
    fireEvent.change(document.querySelector("[data-examples-paste] textarea")!, { target: { value: `email\tpassword\namani@example.com\t${PASSWORD}` } });
    fireEvent.click(document.querySelector("[data-examples-paste-apply]")!);
    expect(onChange.mock.calls.at(-1)![0].secret).toEqual(["password"]);
  });
});
