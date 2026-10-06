/**
 * End-to-end in jsdom: dictating into the REAL New task dialog (TasksPage)
 * through the root DictationProvider, with a fake microphone + engine.
 *  - ⌥Space in "Done when" starts; ghost text streams in the HUD;
 *  - Esc cancels the dictation WITHOUT closing the dialog;
 *  - tap ⌥Space again inserts at the cursor, React state follows (Create
 *    posts the dictated text), and ⌘↵ still creates.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { TasksPage } from "../pages/tasks/TasksPage";
import { DictationProvider } from "./DictationHost";
import { fakeRig, flush } from "./testFakes";

const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }, { id: "a1", alias: "forge", kind: "ai", status: "working" }],
  tasks: [],
  requests: [],
};
let posts: { url: string; body: unknown }[] = [];

beforeEach(() => {
  posts = [];
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const res = (d: unknown, s = 200) => ({ ok: s < 300, status: s, json: async () => d }) as Response;
    if (method === "POST") posts.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1") && method === "GET" && !url.includes("/voice/")) return res(SNAP);
    if (/\/api\/containers\/c1\/tasks$/.test(url) && method === "POST") return res({ task_id: "t9", status: "ready" });
    return res({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const alt = (el: Element, type: "keyDown" | "keyUp", extra: Partial<KeyboardEventInit> = {}) =>
  fireEvent[type](el, { key: type === "keyDown" ? " " : "Alt", code: type === "keyDown" ? "Space" : "AltLeft", altKey: type === "keyDown", ...extra });

async function openNewTask(rig: ReturnType<typeof fakeRig>) {
  render(
    <ToastProvider>
      <SnapshotProvider>
        <DictationProvider cid="c1" deps={rig.deps}>
          <MemoryRouter initialEntries={["/tasks"]}><TasksPage /></MemoryRouter>
        </DictationProvider>
      </SnapshotProvider>
    </ToastProvider>,
  );
  await waitFor(() => expect(document.querySelector("[data-newtask]")).toBeTruthy());
  fireEvent.click(document.querySelector("[data-newtask]")!);
  return screen.findByRole("dialog");
}

describe("dictating into New task", () => {
  it("Esc cancels the dictation and leaves the dialog open; tap-tap inserts and Create posts it", async () => {
    const rig = fakeRig({ cleanup: false });
    const dialog = await openNewTask(rig);
    fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Ship voice" } });
    const dod = document.querySelector<HTMLTextAreaElement>("#nt_dod")!;
    act(() => dod.focus());

    // tap ⌥Space → listening
    await act(async () => { alt(dod, "keyDown"); alt(dod, "keyUp"); await flush(); });
    act(() => { rig.engine.ready(); rig.engine.say("tests pass and", "docs updated"); });
    const hud = await screen.findByRole("group", { name: "Dictation" });
    expect(hud).toHaveTextContent("tests pass and");
    expect(hud.querySelector(".dict-interim")).toHaveTextContent("docs updated");
    expect(hud).toHaveTextContent("Done when");

    // Esc: dictation cancelled, nothing inserted, dialog still open
    act(() => { fireEvent.keyDown(dod, { key: "Escape", code: "Escape" }); });
    expect(rig.engine.cancelled).toBe(true);
    expect(screen.queryByRole("group", { name: "Dictation" })).toBeNull();
    expect(dialog).toBeInTheDocument();
    expect(dod.value).toBe("");

    // again: tap to start, tap to finish → inserted at the cursor
    await act(async () => { alt(dod, "keyDown"); alt(dod, "keyUp"); await flush(); });
    act(() => rig.engine.ready());
    rig.engine.result = "tests pass and docs are updated";
    await act(async () => { alt(dod, "keyDown"); alt(dod, "keyUp"); await flush(); await flush(); });
    await waitFor(() => expect(dod.value).toBe("Tests pass and docs are updated"));
    expect(await screen.findByRole("group", { name: "Dictation" })).toHaveTextContent("Inserted");

    // ⌘↵ unchanged: creates from the field, with the dictated DoD in React state
    fireEvent.keyDown(dod, { key: "Enter", metaKey: true });
    await waitFor(() => expect(posts.find((p) => /\/tasks$/.test(p.url))).toBeTruthy());
    const body = posts.find((p) => /\/tasks$/.test(p.url))!.body as { title: string; definition_of_done: string };
    expect(body.title).toBe("Ship voice");
    expect(body.definition_of_done).toBe("Tests pass and docs are updated");
  });

  it("the field mic appears on focus and toggles dictation; Undo restores the description", async () => {
    const rig = fakeRig({ cleanup: false });
    await openNewTask(rig);
    const desc = document.querySelector<HTMLTextAreaElement>("#nt_desc")!;
    vi.spyOn(desc, "getBoundingClientRect").mockReturnValue({ top: 100, left: 20, width: 500, height: 60, bottom: 160, right: 520, x: 20, y: 100, toJSON: () => ({}) } as DOMRect);
    act(() => desc.focus());
    const mic = await screen.findByTestId("dictation-mic");
    expect(mic).toHaveAccessibleName(/Dictate \(/);
    await act(async () => { fireEvent.click(mic); await flush(); });
    act(() => rig.engine.ready());
    expect(screen.getByTestId("dictation-mic")).toHaveAccessibleName("Stop dictation");
    rig.engine.result = "first, the backend proxy";
    await act(async () => { fireEvent.click(screen.getByTestId("dictation-mic")); await flush(); await flush(); });
    await waitFor(() => expect(desc.value).toBe("First, the backend proxy"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(desc.value).toBe("");
  });

  it("with no engine available the HUD says so plainly and links to Settings › Voice", async () => {
    const rig = fakeRig({}, { providers: [], default_provider: null, cloud_available: false, cleanup_available: false, max_seconds: 600 });
    rig.deps.deviceSupported = () => false;
    await openNewTask(rig);
    const title = document.querySelector<HTMLInputElement>("#nt_title")!;
    act(() => title.focus());
    await act(async () => { alt(title, "keyDown"); alt(title, "keyUp"); await flush(); });
    const hud = await screen.findByRole("group", { name: "Dictation" });
    expect(hud).toHaveTextContent(/isn't set up yet/);
    expect(screen.getByRole("link", { name: "Open Settings › Voice" })).toHaveAttribute("href", "/settings#tab=voice");
  });
});
