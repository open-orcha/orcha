/**
 * Non-code deliverables — list rows, per-kind previews (markdown rendered,
 * CSV table, image, PDF), version history + compare (text diff via the shared
 * FilesChanged viewer), attach (multipart, authority-gated), the verification
 * gate's Deliverables row, and the mount inside the real Task detail.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui";
import { SnapshotProvider } from "../../../state/SnapshotProvider";
import { TasksPage } from "../TasksPage";
import { delimiterFor, parseCsv } from "./csv";
import { DeliverablesEvidence } from "./DeliverablesEvidence";
import { DeliverablesSection } from "./DeliverablesSection";
import { formatBytes, sourceLabel, type Deliverable, type DeliverableVersion } from "./api";
import { prettyJson } from "./DeliverablePreview";

const TID = "t1aaaaaa";
const base = "/api/tasks/" + TID + "/deliverables";

function ver(did: string, v: number, extra: Partial<DeliverableVersion> = {}): DeliverableVersion {
  return {
    version: v,
    source: "run_output",
    run_id: "r" + v + "000000-0000",
    author_agent_id: "a1",
    author_alias: "forge",
    author_kind: "ai",
    size_bytes: 1200 * v,
    sha256: "sha" + v,
    content_type: "text/markdown; charset=utf-8",
    note: null,
    created_at: "2026-09-28T10:0" + v + ":00Z",
    raw_url: base + "/" + did + "/versions/" + v + "/raw",
    text_url: base + "/" + did + "/versions/" + v + "/text",
    ...extra,
  };
}

function dlv(id: string, path: string, kind: Deliverable["kind"], versions: number, extra: Partial<DeliverableVersion> = {}): Deliverable {
  const vs = Array.from({ length: versions }, (_, i) => ver(id, versions - i, extra));
  if (kind === "image" || kind === "pdf") vs.forEach((v) => (v.text_url = null));
  return {
    id,
    task_id: TID,
    path,
    name: path.split("/").pop() as string,
    kind,
    latest_version: versions,
    version_count: versions,
    created_at: "2026-09-28T10:00:00Z",
    updated_at: "2026-09-28T10:0" + versions + ":00Z",
    latest: vs[0],
    versions: vs,
  };
}

let LIST: Deliverable[];
let LIST_STATUS = 200;
let TEXT: Record<string, string>;
let calls: { url: string; method: string; body: unknown }[];
let SNAP: Record<string, unknown>;
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;
const LIMITS = { max_bytes: 10485760, max_deliverables_per_task: 100, max_versions_per_deliverable: 50, allowed_extensions: ["csv", "md", "pdf", "png"], outputs_folder: ".orcha/outputs" };

beforeEach(() => {
  calls = [];
  LIST_STATUS = 200;
  LIST = [
    dlv("d-md", "reports/q3.md", "markdown", 3),
    dlv("d-csv", "data.csv", "csv", 1),
    dlv("d-png", "chart.png", "image", 1),
    dlv("d-pdf", "memo.pdf", "pdf", 1),
  ];
  TEXT = {
    "d-md/1": "# Q3 v1\n\nold line",
    "d-md/3": "# Q3 report\n\n**Revenue** up 12%.",
    "d-csv/1": 'region,revenue\nEMEA,"1,200"\nAPAC,900\n',
  };
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
    ],
    tasks: [
      {
        id: TID,
        title: "Write the Q3 report",
        status: "needs_verification",
        priority: 10,
        assignees: ["forge"],
        created_by_agent_id: "h1",
        created_at: "2026-08-01T00:00:00Z",
        definition_of_done: "report exists",
        result: "Report written",
        message_summary: { count: 0, last: null },
      },
    ],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      calls.push({ url, method, body: init?.body });
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      if (url === base && method === "POST") {
        const fd = init!.body as FormData;
        const f = fd.get("file") as File;
        const d = dlv("d-new", f.name, "markdown", 1);
        LIST = [d, ...LIST];
        return jsonRes({ created: true, deduplicated: false, deliverable: d, version: d.latest }, 201);
      }
      if (url === base) return LIST_STATUS === 200 ? jsonRes({ task_id: TID, deliverables: LIST.map(({ versions: _v, ...d }) => d), limits: LIMITS }) : jsonRes({ detail: "Not Found" }, LIST_STATUS);
      let m = /\/deliverables\/([^/]+)\/versions\/(\d+)\/text$/.exec(url);
      if (m) {
        const t = TEXT[m[1] + "/" + m[2]] ?? "";
        return jsonRes({ text: t, truncated: false, size_bytes: t.length, max_bytes: 262144, kind: "markdown" });
      }
      m = /\/deliverables\/([^/?]+)\/diff\?from=(\d+)&to=(\d+)$/.exec(url);
      if (m) {
        const d = LIST.find((x) => x.id === m![1])!;
        const from = ver(d.id, Number(m[2]));
        const to = ver(d.id, Number(m[3]));
        if (d.kind === "image") return jsonRes({ deliverable_id: d.id, path: d.path, kind: d.kind, from, to, binary: true, bytes_changed: true });
        return jsonRes({
          deliverable_id: d.id,
          path: d.path,
          kind: d.kind,
          from,
          to,
          binary: false,
          bytes_changed: true,
          diff: "diff --git a/" + d.path + " b/" + d.path + "\n--- a/" + d.path + "\n+++ b/" + d.path + "\n@@ -1,3 +1,3 @@\n-# Q3 v" + m[2] + "\n+# Q3 report\n \n-old line\n+**Revenue** up 12%.",
          added: 2,
          removed: 2,
          identical: false,
          truncated: false,
        });
      }
      m = /\/deliverables\/([^/]+)$/.exec(url);
      if (m) return jsonRes(LIST.find((x) => x.id === m![1]));
      if (/\/runs$/.test(url)) return jsonRes([]);
      if (/\/messages$/.test(url)) return jsonRes({ messages: [] });
      return jsonRes({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});

function wrap(node: React.ReactNode) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const row = (path: string) => document.querySelector(`[data-deliverable="${path}"] .dlv-row`) as HTMLButtonElement;

describe("csv parser", () => {
  it("handles quotes, doubled quotes, embedded delimiters/newlines and CRLF", () => {
    const t = parseCsv('a,b,c\r\n"x, y","he said ""hi""","multi\nline"\n1,2,3\n');
    expect(t.rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "multi\nline"],
      ["1", "2", "3"],
    ]);
    expect(t.columns).toBe(3);
    expect(t.truncated).toBe(false);
  });
  it("is bounded and reports truncation; TSV by extension; ragged rows", () => {
    const big = Array.from({ length: 10 }, (_, i) => "r" + i).join("\n");
    const t = parseCsv(big, ",", 3);
    expect(t.rows.length).toBe(3);
    expect(t.truncated).toBe(true);
    expect(delimiterFor("x.tsv")).toBe("\t");
    expect(delimiterFor("x.CSV")).toBe(",");
    expect(parseCsv("a\tb\nc", "\t").rows).toEqual([["a", "b"], ["c"]]);
    expect(parseCsv("a,b\nc").columns).toBe(2);
    expect(parseCsv("").rows).toEqual([]);
  });
});

describe("formatting helpers", () => {
  it("formats sizes, sources and JSON", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(null)).toBe("—");
    expect(sourceLabel(ver("d", 1))).toBe("Run output · forge");
    expect(sourceLabel(ver("d", 1, { source: "attached", author_alias: "kedar" }))).toBe("Attached · kedar");
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("not json")).toBe("not json");
  });
});

describe("DeliverablesSection", () => {
  it("lists rows: kind glyph, mono path with dir, version chip only when versioned, source, size", async () => {
    wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} />);
    await waitFor(() => expect(row("reports/q3.md")).toBeTruthy());
    const sec = screen.getByRole("region", { name: "Deliverables" });
    expect(within(sec).getByText("4")).toBeTruthy(); // count
    const md = row("reports/q3.md");
    expect(md.querySelector(".dlv-dir")?.textContent).toBe("reports/");
    expect(md.querySelector(".dlv-ver")?.textContent).toBe("v3");
    expect(md.textContent).toContain("Run output · forge");
    expect(md.getAttribute("aria-expanded")).toBe("false");
    expect(row("data.csv").querySelector(".dlv-ver")).toBeNull();
    expect(row("chart.png").querySelector('svg[data-kind="image"]')).toBeTruthy();
  });

  it("expands a markdown deliverable into a rendered preview + version history, and compares versions", async () => {
    wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} />);
    await waitFor(() => expect(row("reports/q3.md")).toBeTruthy());
    fireEvent.click(row("reports/q3.md"));
    expect(row("reports/q3.md").getAttribute("aria-expanded")).toBe("true");
    // markdown is RENDERED (bold), never shown as raw markup
    await waitFor(() => expect(document.querySelector('.dlv-preview[data-kind="markdown"] strong')?.textContent).toBe("Revenue"));
    const hist = screen.getByRole("list", { name: /Version history of q3.md/ });
    expect(within(hist).getAllByRole("listitem").length).toBe(3);
    // download link for the selected version
    expect((screen.getByText("Download") as HTMLAnchorElement).getAttribute("href")).toBe(base + "/d-md/versions/3/raw?download=1");
    // compare → text diff (FilesChanged) of v2 → v3
    fireEvent.click(screen.getByRole("button", { name: "Compare with v2" }));
    await waitFor(() => expect(screen.getByTestId("dlv-diff")).toBeTruthy());
    expect(calls.some((c) => c.url === base + "/d-md/diff?from=2&to=3")).toBe(true);
    expect(screen.getByTestId("dlv-diff").textContent).toContain("+2");
    // compare against v1 instead
    fireEvent.change(screen.getByLabelText("Compare against version"), { target: { value: "1" } });
    await waitFor(() => expect(calls.some((c) => c.url === base + "/d-md/diff?from=1&to=3")).toBe(true));
    // back to preview; pick v1 from history → preview of v1 text
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(within(hist).getAllByRole("listitem")[2]);
    await waitFor(() => expect(document.querySelector('.dlv-preview[data-kind="markdown"]')?.textContent).toContain("old line"));
    expect(screen.queryByRole("button", { name: /Compare with/ })).toBeNull(); // v1 has nothing older
  });

  it("renders CSV as a table, images inline and PDFs in an object with a download fallback", async () => {
    wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} />);
    await waitFor(() => expect(row("data.csv")).toBeTruthy());
    fireEvent.click(row("data.csv"));
    const table = await screen.findByTestId("dlv-csv");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["region", "revenue"]);
    expect(within(table).getByText("1,200")).toBeTruthy();
    fireEvent.click(row("chart.png"));
    const img = (await screen.findByAltText("chart.png (version 1)")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(base + "/d-png/versions/1/raw");
    fireEvent.click(row("memo.pdf"));
    await waitFor(() => expect(document.querySelector('object[type="application/pdf"]')).toBeTruthy());
    expect(document.querySelector("object.dlv-pdf")?.getAttribute("data")).toBe(base + "/d-pdf/versions/1/raw");
    expect(screen.getByText("Download memo.pdf").getAttribute("href")).toBe(base + "/d-pdf/versions/1/raw?download=1");
  });

  it("attaches a file as multipart with the acting human, then reloads the list", async () => {
    wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} />);
    await waitFor(() => expect(row("reports/q3.md")).toBeTruthy());
    const btn = screen.getByRole("button", { name: "Attach deliverable" }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    const input = screen.getByTestId("dlv-file") as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe(".csv,.md,.pdf,.png");
    const file = new File(["# notes"], "notes.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(row("notes.md")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST")!;
    const fd = post.body as FormData;
    expect((fd.get("file") as File).name).toBe("notes.md");
    expect(fd.get("author_agent_id")).toBe("h1");
  });

  it("closed tasks keep previews but disable Attach (frozen evidence)", async () => {
    wrap(<DeliverablesSection task={{ id: TID, status: "completed" }} />);
    await waitFor(() => expect(row("reports/q3.md")).toBeTruthy());
    const btn = screen.getByRole("button", { name: "Attach deliverable" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toMatch(/frozen once a task is completed/);
  });

  it("renders nothing without the API (404) and nothing for an empty inspector list; full view explains the outputs folder", async () => {
    LIST_STATUS = 404;
    const { container, unmount } = wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} />);
    await waitFor(() => expect(calls.some((c) => c.url === base)).toBe(true));
    await waitFor(() => expect(container.querySelector('[data-testid="deliverables"]')).toBeNull());
    unmount();
    LIST_STATUS = 200;
    LIST = [];
    const r2 = wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} full={false} />);
    await waitFor(() => expect(calls.filter((c) => c.url === base).length).toBeGreaterThan(1));
    expect(r2.container.querySelector('[data-testid="deliverables"]')).toBeNull();
    r2.unmount();
    wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} full />);
    const empty = await screen.findByTestId("dlv-empty");
    expect(empty.textContent).toContain(".orcha/outputs");
  });

  it("a foreign/old backend answering {} is treated as no API (no error line)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({})));
    const { container } = wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-testid="deliverables"]')).toBeNull();
  });
});

describe("DeliverablesEvidence (verification gate)", () => {
  it("one line of names + a disclosure with the diff of each updated deliverable", async () => {
    wrap(<DeliverablesEvidence tid={TID} />);
    const ev = await screen.findByTestId("deliverables-evidence");
    expect(ev.textContent).toContain("q3.md");
    expect(ev.textContent).toContain("+1 more"); // 4 deliverables, first 3 shown
    const summary = within(ev).getByText(/Changes in 1 deliverable/);
    fireEvent.click(summary);
    await waitFor(() => expect(calls.some((c) => c.url === base + "/d-md/diff?from=2&to=3")).toBe(true));
    await waitFor(() => expect(within(ev).getByTestId("dlv-diff")).toBeTruthy());
  });
  it("an updated image compares before/after (never a fake text diff); nothing when empty", async () => {
    LIST = [dlv("d-png", "chart.png", "image", 2)];
    const r = wrap(<DeliverablesEvidence tid={TID} />);
    const ev = await screen.findByTestId("deliverables-evidence");
    fireEvent.click(within(ev).getByText(/Changes in 1 deliverable/));
    const cmp = await screen.findByTestId("dlv-image-diff");
    expect(cmp.querySelector('[data-testid="fp-compare"]')).not.toBeNull();
    // both versions' bytes come from their own /raw URLs
    await waitFor(() => expect(calls.some((c) => c.url === base + "/d-png/versions/1/raw")).toBe(true));
    expect(calls.some((c) => c.url === base + "/d-png/versions/2/raw")).toBe(true);
    expect(screen.queryByTestId("dlv-binary-diff")).toBeNull();
    r.unmount();
    LIST = [];
    const r2 = wrap(<DeliverablesEvidence tid={TID} />);
    await waitFor(() => expect(calls.filter((c) => c.url === base).length).toBeGreaterThan(1));
    expect(r2.container.querySelector('[data-testid="deliverables-evidence"]')).toBeNull();
  });
});

describe("Task detail mount", () => {
  it("the verification gate carries the Deliverables row and the body carries the section", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/tasks?task=" + TID + "&full=1"]}>
            <TasksPage />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(document.querySelector("#detailMain h1")?.textContent).toBe("Write the Q3 report"));
    const gate = await screen.findByRole("region", { name: "Verification" });
    await waitFor(() => expect(within(gate).getByTestId("deliverables-evidence")).toBeTruthy());
    const sec = await screen.findByRole("region", { name: "Deliverables" });
    await waitFor(() => expect(sec.querySelectorAll(".dlv-row").length).toBe(4));
  });
});

describe("documentDiff", () => {
  it("drops only the git header before the first hunk and labels the pane", async () => {
    const { documentDiff } = await import("./DeliverableDiff");
    const f = documentDiff("diff --git a/r.md b/r.md\n--- a/r.md\n+++ b/r.md\n@@ -1 +1 @@\n--- a/looks-like-header\n+new", "r.md · v1 → v2");
    expect(f).toHaveLength(1);
    expect(f[0].path).toBe("r.md · v1 → v2");
    expect(f[0].lines).toEqual(["@@ -1 +1 @@", "--- a/looks-like-header", "+new"]);
    expect(f[0].add).toBe(1);
  });
});

describe("PDF without a browser viewer", () => {
  it("shows a compact Open / Download card instead of an empty embed", async () => {
    Object.defineProperty(window.navigator, "pdfViewerEnabled", { value: false, configurable: true });
    try {
      wrap(<DeliverablesSection task={{ id: TID, status: "in_progress" }} />);
      await waitFor(() => expect(row("memo.pdf")).toBeTruthy());
      fireEvent.click(row("memo.pdf"));
      const card = await waitFor(() => {
        const el = document.querySelector('.dlv-preview.dlv-file-card[data-kind="pdf"]');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(card.querySelector("object")).toBeNull();
      expect(within(card).getByText("Open").getAttribute("href")).toBe(base + "/d-pdf/versions/1/raw");
    } finally {
      delete (window.navigator as unknown as Record<string, unknown>).pdfViewerEnabled;
    }
  });
});

describe("gate ordering", () => {
  it("leads with deliverables the latest run changed", async () => {
    LIST = [dlv("d-att", "notes.md", "markdown", 1, { source: "attached", author_alias: "kedar" }), ...LIST];
    wrap(<DeliverablesEvidence tid={TID} />);
    const ev = await screen.findByTestId("deliverables-evidence");
    const names = Array.from(ev.querySelectorAll(".dlv-ev-file")).map((e) => e.firstChild?.textContent);
    expect(names[0]).toBe("q3.md");
    expect(names).not.toContain("notes.md"); // attachment ranks last (beyond the first 3)
  });
});

describe("version bar layout (QA portdeliv)", () => {
  it("keeps the version bar on one row: muted text ellipsizes, controls never wrap", async () => {
    const { deliverablesCss } = await import("./deliverablesCss");
    const bar = /\.dlv-bar \{[^}]*\}/.exec(deliverablesCss)?.[0] || "";
    expect(bar).toContain("flex-wrap: nowrap");
    expect(bar).not.toMatch(/flex-wrap: wrap\b/);
    expect(deliverablesCss).toMatch(/\.dlv-bar > span:not\(\.v2-grow\) \{[^}]*text-overflow: ellipsis/);
    expect(deliverablesCss).toMatch(/\.dlv-bar > label, \.dlv-bar > button, \.dlv-bar > a \{[^}]*flex: none/);
    expect(deliverablesCss).toMatch(/@media \(max-width: 560px\) \{ \.dlv-bar > span:not\(\.v2-grow\) \{ display: none; \} \}/);
  });
});
