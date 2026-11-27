/** The Quality tab's readiness list: one line per platform, Download now for the web test browser,
 * its progress while it downloads, and Try again after a failure. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_POLL_MS, QaReadinessList } from "./QaReadinessList";
import { browserAction } from "./setup";

const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const AUTH = { can: true, reason: null, human: { id: "h1" } } as never;
const browser = (state: string, extra: object = {}) => ({ installed: state === "ready", state, percent: null, size: null, error: null, message: null, ...extra });
const rows = (web: object) => ({
  available: true, reason: null,
  platforms: [
    { platform: "ios", ready: true, words: "Ready: iPhone 17 Pro running.", link: null, browser: null },
    { platform: "android", ready: false, words: "Embodent can't find adb, the Android tool.", link: "https://developer.android.com/tools/releases/platform-tools", browser: null },
    { platform: "web", ready: false, words: "The test browser (about 100 MB) downloads the first time you test a website.", link: null, browser: web },
  ],
});

const posts: unknown[] = [];
function stub(...answers: object[]) {
  posts.length = 0;
  let i = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/qa/setup/browser")) {
      posts.push(JSON.parse(String(init.body)));
      return json(browser("downloading", { percent: 0 }));
    }
    if (url.endsWith("/qa/setup/readiness")) return json(answers[Math.min(i++, answers.length - 1)]);
    return json({});
  }) as unknown as typeof fetch;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const gets = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([u]) => String(u).endsWith("/qa/setup/readiness")).length;

describe("QaReadinessList", () => {
  it("shows one line per platform with the words and Google's link for adb", async () => {
    stub(rows(browser("ready")));
    render(<QaReadinessList cid="c1" auth={AUTH} />);
    await screen.findByText("Ready: iPhone 17 Pro running.");
    const android = document.querySelector('[data-platform="android"]')!;
    expect(android.getAttribute("data-ready")).toBe("no");
    expect(android.querySelector("a")!.getAttribute("href")).toBe("https://developer.android.com/tools/releases/platform-tools");
    expect(document.querySelector("[data-download-browser]")).toBeNull();
  });

  it("Download now starts the download as the person, then shows the progress", async () => {
    stub(rows(browser("missing")), rows(browser("downloading", { percent: 40 })));
    render(<QaReadinessList cid="c1" auth={AUTH} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download now" }));
    await waitFor(() => expect(posts).toEqual([{ actor_agent_id: "h1" }]));
    const bar = await screen.findByRole("progressbar", { name: "Test browser download" });
    expect(bar.getAttribute("value")).toBe("40");
  });

  it("shows a download an agent started: it reads the list again while the page is visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stub(rows(browser("missing")), rows(browser("downloading", { percent: 25 })), rows(browser("ready")));
    render(<QaReadinessList cid="c1" auth={AUTH} />);
    await screen.findByRole("button", { name: "Download now" });
    expect(gets()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_POLL_MS); });
    const bar = await screen.findByRole("progressbar", { name: "Test browser download" });
    expect(bar.getAttribute("value")).toBe("25");
    expect(screen.queryByRole("button", { name: "Download now" })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(gets()).toBe(3);
  });

  it("does not read the list again while the page is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stub(rows(browser("ready")));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    render(<QaReadinessList cid="c1" auth={AUTH} />);
    await screen.findByText("Ready: iPhone 17 Pro running.");
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3); });
    expect(gets()).toBe(1);
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(gets()).toBe(2));
  });

  it("offers Try again after a failure", async () => {
    stub(rows(browser("failed", { error: "No internet connection." })));
    render(<QaReadinessList cid="c1" auth={AUTH} />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows nothing on a portal without the QA package", async () => {
    stub({ available: false, reason: "no package", platforms: [] });
    const { container } = render(<QaReadinessList cid="c1" auth={AUTH} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector("[data-qa-readiness]")).toBeNull();
  });
});

describe("browserAction", () => {
  it("offers a download only when the browser is missing or failed", () => {
    expect(browserAction(browser("missing"))).toBe("download");
    expect(browserAction(browser("failed"))).toBe("retry");
    expect(browserAction(browser("downloading"))).toBeNull();
    expect(browserAction(browser("ready"))).toBeNull();
    expect(browserAction(null)).toBeNull();
  });
});
