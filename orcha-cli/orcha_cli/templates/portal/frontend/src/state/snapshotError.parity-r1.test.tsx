/**
 * Parity round 1 — a snapshot the backend REFUSED or doesn't know is not an
 * outage (e2e-permissions-25, e2e-scope-live-8, SH-123, SH-077, HDR-NOTMEMBER,
 * wave-4 "Not found"): the provider keeps the HTTP status + server detail,
 * classifies it, and useActingAuthority names the real reason instead of
 * "Offline — reconnect to make changes".
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOT_FOUND_REASON,
  NOT_MEMBER_REASON,
  OFFLINE_REASON,
  SnapshotProvider,
  _setActingAuth,
  _setActingIdentity,
  authorityForConnection,
  isAnsweredKind,
  snapshotErrorKind,
  useActingAuthority,
  useSnapshot,
  type ActingAuthority,
} from "./SnapshotProvider";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
});

describe("snapshotErrorKind (pure)", () => {
  it("classifies by the carried status first, else the legacy '→ NNN' message", () => {
    expect(snapshotErrorKind(null)).toBeNull();
    expect(snapshotErrorKind("/api/containers/x → 403")).toBe("forbidden");
    expect(snapshotErrorKind("/api/containers/x → 401")).toBe("forbidden");
    expect(snapshotErrorKind("/api/containers/x → 404")).toBe("not_found");
    expect(snapshotErrorKind("/api/containers/not-a-uuid → 400")).toBe("not_found");
    expect(snapshotErrorKind("/api/containers/x → 503")).toBe("server");
    expect(snapshotErrorKind("Failed to fetch")).toBe("network");
    expect(snapshotErrorKind("request timed out")).toBe("network");
    expect(snapshotErrorKind("anything", 403)).toBe("forbidden");
    expect(snapshotErrorKind("anything", 404)).toBe("not_found");
    expect(isAnsweredKind("forbidden")).toBe(true);
    expect(isAnsweredKind("server")).toBe(false);
  });
});

describe("authorityForConnection (pure)", () => {
  const base: ActingAuthority = { human: { id: "h1", alias: "o", kind: "human" } as never, readOnly: false, pending: false, reason: null };
  it("403 → read-only with the not-a-member reason, never 'Offline'", () => {
    const a = authorityForConnection(base, "offline", "forbidden");
    expect(a).toMatchObject({ human: null, readOnly: true, reason: NOT_MEMBER_REASON });
  });
  it("404 → read-only 'Project not found'", () => {
    expect(authorityForConnection(base, "offline", "not_found").reason).toBe(NOT_FOUND_REASON);
  });
  it("a real outage (network / 5xx) still reads offline", () => {
    expect(authorityForConnection(base, "offline", "network").reason).toBe(OFFLINE_REASON);
    expect(authorityForConnection(base, "offline", "server").reason).toBe(OFFLINE_REASON);
  });
  it("healthy connection leaves authority untouched; pending stays pending", () => {
    expect(authorityForConnection(base, "live", null)).toBe(base);
    const p = { ...base, human: null, pending: true, reason: "Resolving your identity…" };
    expect(authorityForConnection(p, "offline", "forbidden")).toBe(p);
  });
});

function Probe() {
  const { errorKind, errorStatus, errorDetail } = useSnapshot();
  const a = useActingAuthority();
  return (
    <div>
      <span data-testid="kind">{String(errorKind)}</span>
      <span data-testid="status">{String(errorStatus)}</span>
      <span data-testid="detail">{String(errorDetail)}</span>
      <span data-testid="reason">{String(a.reason)}</span>
    </div>
  );
}

function stubSnapshot(status: number, detail: string) {
  window.history.replaceState(null, "", "/tasks?cid=c1");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, json: async () => ({ detail }) }) as unknown as Response));
  vi.stubGlobal("EventSource", class { close() {} } as unknown as typeof EventSource);
}

describe("SnapshotProvider keeps the failure's status + detail", () => {
  it("non-member (403): errorKind forbidden, server detail kept, not-a-member reason", async () => {
    stubSnapshot(403, "not a member of this project — ask an owner for an invite");
    render(<SnapshotProvider pollMs={60_000}><Probe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("kind")).toHaveTextContent("forbidden"));
    expect(screen.getByTestId("status")).toHaveTextContent("403");
    expect(screen.getByTestId("detail")).toHaveTextContent("not a member of this project — ask an owner for an invite");
    expect(screen.getByTestId("reason")).toHaveTextContent(NOT_MEMBER_REASON);
  });
  it("unknown project (404): errorKind not_found, 'Project not found'", async () => {
    stubSnapshot(404, "container not found");
    render(<SnapshotProvider pollMs={60_000}><Probe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("kind")).toHaveTextContent("not_found"));
    expect(screen.getByTestId("reason")).toHaveTextContent(NOT_FOUND_REASON);
  });
  it("unreachable project (503): errorKind server, offline reason", async () => {
    stubSnapshot(503, "unreachable");
    render(<SnapshotProvider pollMs={60_000}><Probe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("kind")).toHaveTextContent("server"));
    expect(screen.getByTestId("reason")).toHaveTextContent(OFFLINE_REASON);
  });
});
