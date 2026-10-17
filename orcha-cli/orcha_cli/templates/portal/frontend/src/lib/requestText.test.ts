import { describe, expect, it } from "vitest";
import { codeThreadTitle, humanizeRequest, parseLegacyCodeThread, questionSummary } from "./requestText";
import { linkify, mdText, portalLinkLabel } from "./format";

const TID = "0b5c3a1e-1111-4222-8333-444455556666";
const legacy = (kind: string, q: string, guide = true) =>
  `[code thread — ${kind}] local@8cf5234 deploy/docker-compose.yml:1-1\n${q}\n\n` +
  (guide ? "answer as a short lesson in markdown so the portal can walk the reader through it:\n# <lesson title>\n## Steps\n1. ...\n\n" : "") +
  `reply via POST /api/code/threads/${TID}/messages with your agent id as actor_agent_id\n` +
  `view/reply in the portal: /code?path=deploy/docker-compose.yml&thread=${TID}`;

describe("questionSummary / codeThreadTitle (mirror of code_space_routes)", () => {
  it("drops the polite lead-in and cuts at the first clause break", () => {
    expect(questionSummary("Give me a tour of the deploy/ folder, starting from x: y")).toBe("Tour of the deploy/ folder");
    expect(questionSummary("Why is a.ts lines 3–5 written this way? Walk me through it.")).toBe("Why is a.ts lines 3–5 written this way");
    expect(questionSummary("Explain src/app.module.ts: what it does")).toBe("Explain src/app.module.ts");
    expect(questionSummary("")).toBe("");
    const long = questionSummary("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });
  it("titles as '<Kind> · <gist> — <file> L<lines>'", () => {
    expect(codeThreadTitle("teach", "deploy/docker-compose.yml", 1, 1, "Give me a tour of the deploy/ folder, starting…")).toBe("Teach · Tour of the deploy/ folder — docker-compose.yml L1");
    expect(codeThreadTitle("why", "src/a.ts", 3, 9, "")).toBe("Why · a.ts L3–9");
  });
});

describe("legacy combined payloads", () => {
  it("strips the header, lesson guide, reply instruction and deep link — keeps the question + thread", () => {
    const p = parseLegacyCodeThread(legacy("teach", "Give me a tour of deploy/.\nSecond line."));
    expect(p?.question).toBe("Give me a tour of deploy/.\nSecond line.");
    expect(p?.ref).toMatchObject({ thread_id: TID, kind: "teach", path: "deploy/docker-compose.yml", start_line: 1, end_line: 1, link: "/code?path=deploy/docker-compose.yml&thread=" + TID });
    expect(parseLegacyCodeThread(legacy("question", "What is this?", false))?.question).toBe("What is this?");
    expect(parseLegacyCodeThread("Just a normal question")).toBeNull();
    expect(parseLegacyCodeThread({ title: "x" })).toBeNull();
  });
  it("humanizeRequest: legacy row → clean payload + derived title; detail row → stored title; plain row untouched", () => {
    const h = humanizeRequest(legacy("teach", "Give me a tour of the deploy/ folder, starting from docker-compose.yml: …"));
    expect(h.payload).toBe("Give me a tour of the deploy/ folder, starting from docker-compose.yml: …");
    expect(h.title).toBe("Teach · Tour of the deploy/ folder — docker-compose.yml L1");
    expect(h.codeThread?.link).toContain("thread=" + TID);
    const d = humanizeRequest("Q?", { display_title: "Question · Q — a.ts L2", code_thread: { thread_id: TID, kind: "question", path: "a.ts", start_line: 2, end_line: 2, link: "/code?path=a.ts&thread=" + TID } });
    expect(d).toMatchObject({ payload: "Q?", title: "Question · Q — a.ts L2" });
    expect(humanizeRequest("Plain ask", { proposed_alias: "x" })).toEqual({ payload: "Plain ask", title: null, codeThread: null });
  });
});

describe("portal paths → link chips", () => {
  it("labels a path by where it goes", () => {
    expect(portalLinkLabel("/code?path=a/b.ts&thread=" + TID)).toBe("Open thread in Code");
    expect(portalLinkLabel("/code?path=a/b.ts")).toBe("Open b.ts in Code");
    expect(portalLinkLabel("/tasks?task=abcdef1234")).toBe("Open task abcdef12");
    expect(portalLinkLabel("/requests?req=1234567890")).toBe("Open request 12345678");
    expect(portalLinkLabel("/activity")).toBe("Open Activity");
  });
  it("mdText + linkify render a chip; never inside http URLs, longer paths, or /codex; punctuation stays outside", () => {
    const html = mdText("view in the portal: /code?path=a.ts&thread=t1.");
    expect(html).toContain('href="/code?path=a.ts&amp;thread=t1"');
    expect(html).toContain("Open thread in Code</span></a>.");
    expect(html).not.toMatch(/>\/code\?path/);
    expect(linkify("see /tasks?task=abc12345 now")).toContain("Open task abc12345");
    expect(linkify("https://x.dev/code?path=a")).not.toContain("plink");
    expect(mdText("run /codex or /code/foo or /usr/bin")).not.toContain("plink");
    expect(mdText("`/code?path=a`")).not.toContain("plink"); // inline code stays code
  });
});
