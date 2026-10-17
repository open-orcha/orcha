import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { UpdateNotice, entryScriptOf, runningEntry } from "./UpdateNotice";

const shellHtml = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/dist/assets/${entry}"></script></head><body><div id="root"></div></body></html>`;

function mountEntry(entry: string | null) {
  document.querySelectorAll("script[data-test-entry]").forEach((s) => s.remove());
  if (!entry) return;
  const s = document.createElement("script");
  s.setAttribute("src", `/assets/dist/assets/${entry}`);
  s.setAttribute("data-test-entry", "1");
  document.head.appendChild(s);
}

afterEach(() => {
  cleanup();
  mountEntry(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("entry bundle detection", () => {
  it("reads the hashed entry from page HTML and from the running page", () => {
    expect(entryScriptOf(shellHtml("index-CEiEV4o9.js"))).toBe("index-CEiEV4o9.js");
    expect(entryScriptOf('<script type="module" src="/src/main.tsx"></script>')).toBeNull(); // vite dev
    mountEntry("index-AAA111.js");
    expect(runningEntry()).toBe("index-AAA111.js");
  });
});

describe("UpdateNotice", () => {
  it("appears when the server serves a newer bundle, and Reload reloads", async () => {
    vi.useFakeTimers();
    mountEntry("index-OLD.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(shellHtml("index-NEW.js"), { status: 200 })));
    render(<UpdateNotice />);
    expect(screen.queryByTestId("update-notice")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId("update-notice")).toHaveTextContent("Embodent was updated");
  });

  it("stays hidden when the bundle is unchanged, on a dev server, or when offline", async () => {
    vi.useFakeTimers();
    mountEntry("index-SAME.js");
    const fetchMock = vi.fn().mockResolvedValue(new Response(shellHtml("index-SAME.js"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<UpdateNotice />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.queryByTestId("update-notice")).toBeNull();
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const offline = render(<UpdateNotice />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByTestId("update-notice")).toBeNull();
    offline.unmount();

    mountEntry(null); // dev server: no hashed entry, never polls
    const devFetch = vi.fn();
    vi.stubGlobal("fetch", devFetch);
    render(<UpdateNotice />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(devFetch).not.toHaveBeenCalled();
  });
});
