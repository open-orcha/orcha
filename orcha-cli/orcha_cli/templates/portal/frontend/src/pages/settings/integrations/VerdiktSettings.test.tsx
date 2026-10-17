/**
 * Settings → Integrations › Verdikt: loads the saved settings, is read-only
 * (with the reason) without an authorised acting human, saves exactly the
 * edited fields as that human, shows the connection check honestly, and keeps
 * a failed save's error inline.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdiktSettingsGroup, VERDIKT_GRANT_REASON } from "./VerdiktSettings";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let saved: Record<string, unknown>;
let putStatus = 200;
let testAnswer: Record<string, unknown>;

beforeEach(() => {
  calls = [];
  putStatus = 200;
  saved = {
    configured: false, enabled: false, base_url: null, verdikt_project: null, target_kind: "web", target_locator: null,
    trigger_mode: "manual", timeout_minutes: 30, updated_at: null, updated_by: null,
  };
  testAnswer = { reachable: true, ok: true, worker_online: true, project_found: true, project: { slug: "shop-web", name: "Shop web" },
    projects: [{ slug: "shop-web", name: "Shop web", archived: false }], error: null };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/containers/c1/verdikt" && method === "GET") return res(saved);
    if (url === "/api/containers/c1/verdikt" && method === "PUT") {
      if (putStatus !== 200) return res({ detail: "to enable Verdikt, set its URL and the Verdikt project slug" }, putStatus);
      const b = body as Record<string, unknown>;
      saved = { ...saved, ...b, configured: !!(b.base_url && b.verdikt_project) };
      delete (saved as Record<string, unknown>).actor_agent_id;
      return res(saved);
    }
    if (url === "/api/containers/c1/verdikt/test") return res(testAnswer);
    return res({});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VerdiktSettingsGroup", () => {
  it("is read-only with the reason when nobody authorised acts", async () => {
    render(<VerdiktSettingsGroup cid="c1" actorId={null} reason={null} />);
    const url = await screen.findByLabelText("Verdikt URL");
    expect((url as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(VERDIKT_GRANT_REASON)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the edited settings as the acting human", async () => {
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    fireEvent.change(await screen.findByLabelText("Verdikt URL"), { target: { value: "http://127.0.0.1:31950" } });
    fireEvent.change(screen.getByLabelText("Verdikt project"), { target: { value: "shop-web" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "http://127.0.0.1:5173" } });
    fireEvent.change(screen.getByLabelText("When to run Verdikt"), { target: { value: "ui_changes" } });
    fireEvent.click(screen.getByLabelText("Enable Verdikt"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      enabled: true, base_url: "http://127.0.0.1:31950", verdikt_project: "shop-web", target_kind: "web",
      target_locator: "http://127.0.0.1:5173", trigger_mode: "ui_changes", timeout_minutes: 30, actor_agent_id: "h1",
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    // nothing left to save
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("switching the target kind changes what the target field asks for", async () => {
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    await screen.findByLabelText("Target");
    fireEvent.click(screen.getByRole("radio", { name: "iOS" }));
    expect((screen.getByLabelText("Target") as HTMLInputElement).placeholder).toBe("com.example.MyApp");
    expect(screen.getByText("Bundle id of the app installed on the simulator")).toBeTruthy();
  });

  it("shows the connection check result", async () => {
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    fireEvent.change(await screen.findByLabelText("Verdikt URL"), { target: { value: "http://127.0.0.1:31950" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Test connection" })); });
    await waitFor(() => expect(screen.getByTestId("verdikt-test").textContent).toContain("Connected · worker online · project “Shop web” found"));
    expect(calls.find((c) => c.url.endsWith("/verdikt/test"))?.body).toEqual({ actor_agent_id: "h1", base_url: "http://127.0.0.1:31950" });
    testAnswer = { reachable: false, ok: false, worker_online: null, project_found: null, project: null, projects: [],
      error: "Verdikt is not reachable at http://127.0.0.1:31950 (Connection refused)" };
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Test connection" })); });
    await waitFor(() => expect(screen.getByTestId("verdikt-test").textContent).toContain("not reachable"));
  });

  it("keeps a refused save inline", async () => {
    putStatus = 400;
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    fireEvent.click(await screen.findByLabelText("Enable Verdikt"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect((await screen.findByRole("alert")).textContent).toBe("Not saved — to enable Verdikt, set its URL and the Verdikt project slug");
    expect((screen.getByLabelText("Enable Verdikt") as HTMLInputElement).checked).toBe(true);
  });
});

describe("VerdiktSettingsGroup — preview + Open Verdikt (mig 064)", () => {
  const withPreview = () => {
    saved = {
      ...saved, enabled: true, configured: true, base_url: "http://host.docker.internal:31970", verdikt_project: "acme-web",
      target_locator: "http://127.0.0.1:5173/", preview_command: null, preview_ready_path: "/", preview_timeout_seconds: 120,
      preview_ttl_minutes: 60,
    };
  };

  it("an older backend (no preview fields) shows no Preview rows and never sends them", async () => {
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    await screen.findByLabelText("Verdikt URL");
    expect(screen.queryByLabelText("Preview command")).toBeNull();
  });

  it("edits and saves the preview command, ready check, timeout and time limit", async () => {
    withPreview();
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    const cmd = (await screen.findByLabelText("Preview command")) as HTMLInputElement;
    expect(cmd.placeholder).toBe("npm ci && npm run build && npx serve -l {port} dist");
    expect(screen.getByText(/Placeholders: \{port\} \{worktree\} \{branch\}/)).toBeTruthy();
    expect(document.getElementById("verdiktPreview")?.textContent).toContain("http://127.0.0.1:{port}");
    fireEvent.change(cmd, { target: { value: "  python3 -m http.server {port}  " } });
    fireEvent.change(screen.getByLabelText("Ready check path"), { target: { value: "/health" } });
    fireEvent.change(screen.getByLabelText("Preview start timeout seconds"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Preview time limit minutes"), { target: { value: "30" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({
      preview_command: "python3 -m http.server {port}", preview_ready_path: "/health",
      preview_timeout_seconds: 900, preview_ttl_minutes: 30, actor_agent_id: "h1",
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("clearing the command sends null (Verdikt goes back to testing the URL)", async () => {
    withPreview();
    saved.preview_command = "npx serve -l {port} dist";
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    fireEvent.change(await screen.findByLabelText("Preview command"), { target: { value: "" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect((calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>).preview_command).toBeNull();
  });

  it("the preview rows are for web targets only and are read-only without authority", async () => {
    withPreview();
    render(<VerdiktSettingsGroup cid="c1" actorId={null} reason={null} />);
    expect(((await screen.findByLabelText("Preview command")) as HTMLInputElement).disabled).toBe(true);
    cleanup();
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    await screen.findByLabelText("Preview command");
    fireEvent.click(screen.getByRole("radio", { name: "iOS" }));
    expect(screen.queryByLabelText("Preview command")).toBeNull();
  });

  it("Open Verdikt goes through the portal's project redirect, in a new tab", async () => {
    withPreview();
    render(<VerdiktSettingsGroup cid="c1" actorId={null} reason={null} />);
    const open = await screen.findByRole("link", { name: "Open Verdikt" });
    expect(open.getAttribute("href")).toBe("/api/containers/c1/verdikt/open");
    expect(open.getAttribute("target")).toBe("_blank");
  });

  it("no Open Verdikt before a Verdikt URL is saved", async () => {
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    await screen.findByLabelText("Verdikt URL");
    expect(screen.queryByRole("link", { name: "Open Verdikt" })).toBeNull();
  });
});

describe("VerdiktSettingsGroup — auto-fix (mig 068)", () => {
  const withAutofix = (mode = "always") => {
    saved = {
      ...saved, enabled: true, configured: true, base_url: "http://127.0.0.1:31970", verdikt_project: "acme-web",
      target_locator: "http://127.0.0.1:5173/", trigger_mode: mode, autofix_enabled: false, autofix_max_attempts: 3,
      autofix_applies: mode !== "manual",
    };
  };
  const toggle = () => screen.getByLabelText("When Verdikt fails, send it back to the agent automatically") as HTMLInputElement;

  it("an older backend shows no auto-fix rows and never sends them", async () => {
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    await screen.findByLabelText("Verdikt URL");
    expect(screen.queryByLabelText("Max attempts")).toBeNull();
  });

  it("is off by default; turning it on and setting max attempts saves both", async () => {
    withAutofix();
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    await screen.findByLabelText("Verdikt URL");
    expect(toggle().checked).toBe(false);
    expect((screen.getByLabelText("Max attempts") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText("Max attempts"), { target: { value: "25" } });
    expect((screen.getByLabelText("Max attempts") as HTMLInputElement).value).toBe("10");
    fireEvent.change(screen.getByLabelText("Max attempts"), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ autofix_enabled: true, autofix_max_attempts: 5, trigger_mode: "always", actor_agent_id: "h1" });
    expect((put?.body as Record<string, unknown>).autofix_applies).toBeUndefined();
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("is disabled with the reason while Verdikt only runs manually", async () => {
    withAutofix("manual");
    render(<VerdiktSettingsGroup cid="c1" actorId="h1" />);
    await screen.findByLabelText("Verdikt URL");
    expect(toggle().disabled).toBe(true);
    expect(screen.getByText(/Only works when Verdikt runs automatically/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("When to run Verdikt"), { target: { value: "ui_changes" } });
    expect(toggle().disabled).toBe(false);
  });

  it("is read-only without authority", async () => {
    withAutofix();
    render(<VerdiktSettingsGroup cid="c1" actorId={null} reason={null} />);
    await screen.findByLabelText("Verdikt URL");
    expect(toggle().disabled).toBe(true);
  });
});
