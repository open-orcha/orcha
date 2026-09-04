import { describe, expect, it } from "vitest";
import { mapSnapshot, mapThread } from "./api/client";
import { linkify, mdText, relTime, taskRefs, trunc } from "./lib/format";
import { statusClass } from "./lib/status";
import type { Agent, Task } from "./types";

const agents = [
  { id: "a1", alias: "forge", kind: "ai" },
  { id: "h1", alias: "kedar", kind: "human" },
];

describe("mapSnapshot (data.js parity)", () => {
  it("maps agents/tasks/requests to the component shape", () => {
    const s = mapSnapshot({
      container: { id: "c1", name: "Orcha", autonomy_level: "plan" },
      agents,
      tasks: [
        {
          id: "e4b77f3f-0000-0000-0000-000000000000", title: "Ship it", status: "in_progress",
          assignees: ["forge"], created_by_agent_id: "a1", created_at: "2026-08-01T00:00:00Z",
          runs: { count: 2, latest: { status: "completed" } },
        },
      ],
      requests: [
        { id: "r1", type: "escalation", status: "open", requester_id: "a1", target_id: null, payload: "help", created_at: "2026-08-01T00:00:00Z" },
      ],
    });
    expect(s.agents[0].role).toBe("—");
    expect(s.byAlias["forge"].id).toBe("a1");
    expect(s.tasks[0].assignee).toBe("forge");
    expect(s.tasks[0].created_by).toBe("forge");
    // D7 runs-summary object is never mistaken for the runs array
    expect(s.tasks[0].runs).toEqual([]);
    expect(s.tasks[0].runs_summary?.count).toBe(2);
    expect(s.requests[0].from).toBe("forge");
    expect(s.requests[0].to).toBe("human");
    // current_task derived from in_progress assignment
    expect(s.agents[0].current_task?.title).toBe("Ship it");
  });

  it("mapThread routes null-author rows through the system path (#271)", () => {
    const th = mapThread(
      [
        { message_id: "m1", is_human: false, author_id: null, body: "legacy", created_at: "2026-08-01T00:00:00Z" },
        { message_id: "m2", is_human: false, author_id: "a1", body: "hi", created_at: "2026-08-01T00:00:00Z" },
      ],
      agents as unknown as Agent[],
    );
    expect(th[0].from).toBe("system");
    expect(th[1].from).toBe("forge");
  });
});

describe("format helpers", () => {
  it("escapes then linkifies (ISS-44) leaving trailing punctuation out", () => {
    const html = linkify("see https://x.dev/a). <b>");
    expect(html).toContain('<a class="lnk" href="https://x.dev/a"');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
  it("mdText renders the safe subset without HTML injection", () => {
    const html = mdText("**bold** `code` <script>x</script>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<code class="md-code">code</code>');
    expect(html).toContain("&lt;script&gt;");
  });
  it("taskRefs chips only unique resolvable ids (ISS-82)", () => {
    const tasks = [{ id: "e4b77f3f-1111-2222-3333-444455556666", title: "Ship" }] as unknown as Task[];
    const html = taskRefs("work on e4b77f3f please", tasks);
    expect(html).toContain('[Ship]');
    expect(taskRefs("deadbeef", tasks)).toBe("deadbeef");
  });
  it("relTime and trunc behave", () => {
    expect(relTime(null)).toBe("—");
    expect(trunc("abcdef", 4)).toBe("abc…");
  });
  it("statusClass falls back to idle", () => {
    expect(statusClass("nonsense")).toBe("s-idle");
    expect(statusClass("needs_verification")).toBe("s-attn");
  });
});
