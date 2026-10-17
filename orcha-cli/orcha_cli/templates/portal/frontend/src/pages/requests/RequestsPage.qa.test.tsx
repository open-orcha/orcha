/**
 * QA regressions for /requests:
 *  - #14 a failed FIRST load is an error state with Retry, not "Loading requests".
 *  - #26 the sort segment (Time / Priority / direction) gets a 44 px touch
 *    floor on coarse pointers from the page's own stylesheet.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { workCss } from "../tasks/workCss";
import { RequestsPage, _resetPendingAnswers } from "./RequestsPage";

const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes({ detail: "down" }, 503);
    return jsonRes({});
  }));
});
afterEach(() => { _resetPendingAnswers(); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe("RequestsPage QA", () => {
  it("#14 a failed first load shows 'Couldn't load requests' with Retry", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider pollMs={40}>
          <MemoryRouter initialEntries={["/requests"]}>
            <RequestsPage />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    expect(await screen.findByText("Couldn't load requests", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading requests" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });

  it("#26 coarse-pointer 44 px floor covers the sort segment buttons", () => {
    const coarse = workCss.slice(workCss.indexOf("@media (pointer: coarse)"));
    expect(coarse).toMatch(/\.wk-page \.sortctl button, \.wk-page \.sortctl \.sortdir \{ min-height: 44px; min-width: 44px; \}/);
  });
});
