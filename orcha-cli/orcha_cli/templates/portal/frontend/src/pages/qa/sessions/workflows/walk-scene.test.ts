import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppModel, ModelWorkflow } from "../workflows/workflows";
import { WalkScene, walkExample } from "./walk-scene";

const wf = (name: string, steps: { text: string; screen?: string }[], criticality: ModelWorkflow["criticality"] = "normal"): ModelWorkflow => ({
  key: name.toLowerCase().replace(/\W+/g, "-"),
  name,
  persona: null,
  job: null,
  criticality,
  steps,
  data: {},
  evidence: { routes: [], screens: [], tests: [], docs: [], code: [], scenarios: [], runs: [] },
  risk: { never_walked: true, failed_recently: false, changed_at: null, covered_by: 0 },
  status: "unwalked",
  last_walk: null,
  sources: ["study"],
});

const model = (workflows: ModelWorkflow[]): AppModel => ({
  purpose: "Slate keeps notebooks of pages.",
  personas: [],
  core_jobs: [],
  workflows,
  built_from: { map_build_id: null, tests: 0, docs: 0, scenarios: 0 },
});

describe("the walk scene's example", () => {
  it("walks the project's own most important flow when its App model has one", () => {
    const ex = walkExample(
      model([
        wf("Rename a page", [{ text: "Open a page" }, { text: "Tap the title" }]), // two steps: too short to show
        wf("Create a notebook", [{ text: "Open Library", screen: "Library" }, { text: "Tap New notebook" }, { text: "Name it Field notes" }, { text: "Save" }, { text: "See it listed" }], "critical"),
      ]),
    );
    expect(ex.name).toBe("Create a notebook");
    expect(ex.steps).toEqual(["Open Library", "Tap New notebook", "Name it Field notes", "Save"]);
    expect(ex.checks[0]).toBe("Library shown");
  });

  it("falls back to one of its features, then to a flow any app has: never another app's bottle feed", () => {
    expect(walkExample(model([]), "Notebooks").steps[0]).toBe("Open Notebooks");
    const any = walkExample(null);
    expect(any.name).toBe("Your app's top flow");
    for (const ex of [walkExample(null, "Notebooks"), any]) expect(JSON.stringify(ex)).not.toMatch(/bottle|feed|Zawadi|ml/i);
  });

  it("says it is an example, on screen and to a screen reader", () => {
    const html = renderToStaticMarkup(createElement(WalkScene, { example: walkExample(null, "Notebooks") }));
    expect(html).toContain("For example");
    expect(html).toContain('data-walk-example="Use Notebooks end to end"');
    expect(html).toContain("for example Use Notebooks end to end");
    expect(html).toContain("Notebooks: the main task, start to finish");
    expect(html).toContain("and 1 more step");
  });
});
