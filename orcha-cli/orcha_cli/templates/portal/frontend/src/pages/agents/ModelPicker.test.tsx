/**
 * Agent Configuration provider/model picker (ModelPicker.tsx) — real brand marks,
 * EVERY /api/models row grouped by managed runtime, a cross-runtime pick confirms
 * inline and goes through the existing POST /api/agents/{id}/model, type-to-filter
 * + keyboard, and permission gating.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingIdentity } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";
import { ModelPicker, managedRuntimeOf, type PickerModel } from "./ModelPicker";

// the real backend's shape (model_policy.py): both runtimes, plus a row tagged with a
// runtime the portal cannot wake a managed agent on — it must never be listed
const MODELS: PickerModel[] = [
  { id: "claude-opus-5", name: "Opus 5", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5", name: "Sonnet 5", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", runtime: "claude", reasoning_efforts: [] },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.5", name: "GPT-5.5", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", runtime: "gemini", reasoning_efforts: [] },
];
const EFF: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra-high", max: "Maximum", ultra: "Ultra" };
const effortName = (id: string) => EFF[id] || id;

const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner" },
    { id: "a1", alias: "atlas", kind: "ai", role: "Builder", status: "idle", model: "claude-opus-5", reasoning_effort: "high", wake_enabled: true, prompt_preview: "You are Atlas." },
  ],
  tasks: [],
  requests: [],
};

interface Call { url: string; init?: RequestInit }
let calls: Call[] = [];
const jsonRes = (d: unknown) => ({ ok: true, status: 200, json: async () => d }) as Response;
function stubFetch() {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (url === "/api/models") return jsonRes({ models: MODELS, default: "claude-opus-5" });
    if (url === "/api/reasoning-efforts") return jsonRes({ efforts: [] });
    if (url.includes("/digest")) return jsonRes({ digest: null });
    if (url.includes("/runs")) return jsonRes({ runs: [] });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    if (url.includes("/persona")) return jsonRes({ system_prompt: "" });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(path = "/agents?view=list&agent=atlas&tab=config") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={<AgentsPage />} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
function must<T extends Element>(el: T | null): T {
  expect(el).toBeTruthy();
  return el as T;
}
const trigger = (c: HTMLElement) => (c.querySelector("#modelSeg") as HTMLElement).querySelector("button") as HTMLButtonElement;
const list = () => screen.getByRole("listbox", { name: "Models" });
const optionIds = () => within(list()).getAllByRole("option").map((o) => o.getAttribute("data-model"));
const modelPosts = () => calls.filter((c) => c.url === "/api/agents/a1/model" && c.init?.method === "POST");
/** wait until the fetched catalog (not the seed) is in the list */
async function openFetched(c: HTMLElement) {
  await waitFor(() => expect(trigger(c)).toBeTruthy());
  fireEvent.click(trigger(c));
  await waitFor(() => expect(optionIds()).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "gpt-5.6-sol", "gpt-5.5"]));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete extensions.identity;
  _setActingIdentity(null);
});

describe("Provider control + header chip carry the real marks", () => {
  it("Claude segment shows the Claude mark (brand colour), Codex the OpenAI mark (currentColor); names unchanged", async () => {
    const { container } = mount();
    const seg = await waitFor(() => must(container.querySelector("#modelRuntimeSeg")));
    const [claude, codex] = Array.from(seg.querySelectorAll("button"));
    expect(claude.textContent).toBe("Claude");
    expect(codex.textContent).toBe("Codex");
    const cm = claude.querySelector("svg[data-brand]") as SVGElement;
    const om = codex.querySelector("svg[data-brand]") as SVGElement;
    expect(cm.getAttribute("data-brand")).toBe("claude");
    expect(cm.getAttribute("style")).toContain("color: rgb(217, 119, 87)"); // #D97757
    expect(om.getAttribute("data-brand")).toBe("openai");
    expect(om.getAttribute("style")).toBeNull(); // monochrome: currentColor
    expect(cm.getAttribute("aria-hidden")).toBe("true"); // the text names the brand
    expect(cm.getAttribute("width")).toBe("14");
    expect(claude.getAttribute("aria-pressed")).toBe("true");
  });

  it("the header model chip and the picker trigger show the current runtime's mark", async () => {
    const { container } = mount();
    const chip = await waitFor(() => must(container.querySelector(".ahead .ag-model")));
    expect(chip.querySelector("svg")?.getAttribute("data-brand")).toBe("claude");
    expect(chip.querySelector("svg")?.getAttribute("width")).toBe("12");
    expect(chip.textContent).toBe("Opus 5 · High");
    await waitFor(() => expect(trigger(container).querySelector("svg")?.getAttribute("data-brand")).toBe("claude"));
    expect(trigger(container).textContent).toContain("Opus 5");
  });
});

describe("model picker lists every supported model from GET /api/models, grouped by runtime", () => {
  it("groups Claude then Codex, logos on headers + rows, id + effort hint, current check; no unsupported runtime", async () => {
    const { container } = mount();
    await openFetched(container);
    const groups = Array.from(list().querySelectorAll<HTMLElement>("[role=group]"));
    expect(groups.map((g) => g.getAttribute("data-runtime"))).toEqual(["claude", "codex"]);
    expect(groups.map((g) => g.querySelector(".mpk-gh svg")?.getAttribute("data-brand"))).toEqual(["claude", "openai"]);
    expect(within(groups[1]).getAllByRole("option").every((o) => o.querySelector("svg")?.getAttribute("data-brand") === "openai")).toBe(true);
    // truthfulness: the gemini-tagged row is not a managed runtime → never listed
    expect(list().textContent).not.toContain("Gemini");
    expect(screen.getByText(/Other agents can be launched in desktop terminals/)).toBeInTheDocument();
    const opus = list().querySelector('[data-model="claude-opus-5"]') as HTMLElement;
    expect(opus.getAttribute("aria-selected")).toBe("true");
    expect(opus.querySelector(".mpk-check svg")).toBeTruthy();
    expect(opus.querySelector(".mpk-id")?.textContent).toBe("claude-opus-5");
    expect(opus.querySelector(".mpk-hint")?.textContent).toBe("Effort to Maximum");
    expect(list().querySelector('[data-model="gpt-5.6-sol"] .mpk-hint')?.textContent).toBe("Effort to Ultra");
    expect(list().querySelector('[data-model="claude-haiku-4-5-20251001"] .mpk-hint')?.textContent).toBe("No effort control");
    expect(list().querySelector('[data-model="gpt-5.5"]')?.getAttribute("aria-selected")).toBe("false");
  });

  it("managedRuntimeOf keeps only the backend's managed runtimes", () => {
    expect(managedRuntimeOf({ id: "x", runtime: "codex" })).toBe("codex");
    expect(managedRuntimeOf({ id: "x", runtime: "CLAUDE" })).toBe("claude");
    expect(managedRuntimeOf({ id: "x", runtime: "gemini" })).toBeNull();
    expect(managedRuntimeOf({ id: "gpt-5" })).toBe("codex");
  });
});

describe("switching models", () => {
  it("same runtime: POSTs the model at once, no confirm", async () => {
    const { container } = mount();
    await openFetched(container);
    fireEvent.click(within(list()).getByText("Sonnet 5"));
    await waitFor(() => expect(modelPosts().map((c) => c.init!.body)).toEqual([JSON.stringify({ model: "claude-sonnet-5" })]));
    expect(screen.queryByRole("listbox", { name: "Models" })).toBeNull();
  });

  it("other runtime: confirms inline ('Switch atlas to Codex · GPT-5.5?'), then POSTs through /model; the provider follows", async () => {
    const { container } = mount();
    await openFetched(container);
    fireEvent.click(within(list()).getByText("GPT-5.5"));
    const conf = screen.getByRole("group", { name: "Confirm provider switch" });
    expect(conf.textContent).toContain("Switch atlas to Codex · GPT-5.5?");
    expect(conf.querySelector("svg")?.getAttribute("data-brand")).toBe("openai");
    expect(modelPosts()).toEqual([]); // nothing sent before the confirm
    expect(document.activeElement?.textContent).toBe("Switch");
    fireEvent.click(within(conf).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(modelPosts().map((c) => c.init!.body)).toEqual([JSON.stringify({ model: "gpt-5.5" })]));
    // no invented provider endpoint
    expect(calls.some((c) => /\/(runtime|provider)\b/.test(c.url) && c.init?.method)).toBe(false);
    // optimistic: Codex is now the pressed provider and the trigger wears the OpenAI mark
    const codexBtn = within(container.querySelector("#modelRuntimeSeg") as HTMLElement).getByText("Codex").closest("button")!;
    await waitFor(() => expect(codexBtn.getAttribute("aria-pressed")).toBe("true"));
    expect(trigger(container).querySelector("svg")?.getAttribute("data-brand")).toBe("openai");
  });

  it("Cancel / Escape back out of the confirm without a POST; Escape again closes", async () => {
    const { container } = mount();
    await openFetched(container);
    fireEvent.click(within(list()).getByText("GPT-5.6 Sol"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm provider switch" })).toBeNull();
    fireEvent.click(within(list()).getByText("GPT-5.6 Sol"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Switch" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Confirm provider switch" })).toBeNull();
    expect(list()).toBeInTheDocument(); // still open
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Models" })).toBeNull());
    expect(document.activeElement).toBe(trigger(container));
    expect(modelPosts()).toEqual([]);
  });

  it("the Codex provider segment opens the picker on the Codex group", async () => {
    const { container } = mount();
    await waitFor(() => expect(trigger(container)).toBeTruthy());
    fireEvent.click(within(container.querySelector("#modelRuntimeSeg") as HTMLElement).getByText("Codex"));
    const combo = await screen.findByRole("combobox");
    await waitFor(() => expect(combo.getAttribute("aria-activedescendant")).toBeTruthy());
    const act = document.getElementById(combo.getAttribute("aria-activedescendant")!)!;
    expect(act.getAttribute("data-model")).toBe("gpt-5.6-sol");
    expect(modelPosts()).toEqual([]);
  });
});

describe("keyboard: type-to-filter, arrows, Enter", () => {
  it("filters by name / id / runtime, arrows move the active row, Enter picks", async () => {
    const { container } = mount();
    await openFetched(container);
    const combo = screen.getByRole("combobox");
    expect(document.activeElement).toBe(combo); // focus lands in the filter
    fireEvent.change(combo, { target: { value: "gpt" } });
    expect(optionIds()).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    expect(list().querySelectorAll("[role=group]").length).toBe(1);
    const activeId = () => document.getElementById(combo.getAttribute("aria-activedescendant") || "")?.getAttribute("data-model");
    await waitFor(() => expect(activeId()).toBe("gpt-5.6-sol"));
    fireEvent.keyDown(combo, { key: "ArrowDown" });
    expect(activeId()).toBe("gpt-5.5");
    fireEvent.keyDown(combo, { key: "ArrowDown" }); // wraps
    expect(activeId()).toBe("gpt-5.6-sol");
    fireEvent.keyDown(combo, { key: "ArrowUp" });
    expect(activeId()).toBe("gpt-5.5");
    fireEvent.keyDown(combo, { key: "Enter" }); // cross-runtime → confirm
    expect(screen.getByRole("group", { name: "Confirm provider switch" }).textContent).toContain("Codex · GPT-5.5?");
    fireEvent.keyDown(screen.getByRole("button", { name: "Switch" }), { key: "Escape" });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "haiku" } });
    expect(optionIds()).toEqual(["claude-haiku-4-5-20251001"]);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" }); // same runtime → immediate
    await waitFor(() => expect(modelPosts().map((c) => c.init!.body)).toEqual([JSON.stringify({ model: "claude-haiku-4-5-20251001" })]));

    fireEvent.click(trigger(container));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(list().textContent).toContain("No models match");
  });

  it("filtering by runtime name lists that group", async () => {
    const { container } = mount();
    await openFetched(container);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "codex" } });
    expect(optionIds()).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  });
});

describe("gating: members without manage_agents / viewers", () => {
  it("provider segments disabled with the reason; model options disabled with the reason; nothing is sent", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "member", grants: [] }) as unknown as Identity;
    const { container } = mount();
    await waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("#modelRuntimeSeg button")).every((b) => b.disabled)).toBe(true));
    const seg = container.querySelector("#modelRuntimeSeg button") as HTMLButtonElement;
    expect(seg.getAttribute("title")).toContain("manage_agents");
    expect(trigger(container).getAttribute("title")).toContain("manage_agents");
    await openFetched(container);
    const opts = within(list()).getAllByRole("option");
    expect(opts.every((o) => o.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(opts[3].getAttribute("title")).toContain("manage_agents");
    expect(screen.getByText(/manage_agents/, { selector: ".mpk-lock" })).toBeInTheDocument();
    fireEvent.click(opts[3]); // GPT-5.6 Sol
    expect(screen.queryByRole("group", { name: "Confirm provider switch" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(modelPosts()).toEqual([]);
  });
});

describe("ModelPicker (isolated)", () => {
  it("a legacy id is listed first in its runtime group, current and not pickable", () => {
    const onPick = vi.fn();
    render(
      <ModelPicker
        agentAlias="atlas" models={MODELS} runtime="claude" currentId="claude-opus-4-1" legacyId="claude-opus-4-1" legacyLabel="Opus 4.1 (legacy)"
        defaultId="claude-opus-5" label="Opus 4.1 (legacy)" lockReason="" effortName={effortName} onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Opus 4.1/ }));
    const first = within(list()).getAllByRole("option")[0];
    expect(first.textContent).toContain("Opus 4.1 (legacy)");
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(first);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(within(list()).getByText("Opus 5"));
    expect(onPick).toHaveBeenCalledWith("claude-opus-5");
  });
});
