/**
 * primitives-b: IconButton (circle) · Button pill · FilterPills · GroupHeader/ListGroup ·
 * Timeline · PropertyRail · Composer · Board · ChatBubble/WorkedFor · ChangesCard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Button, IconButton as IconButtonFromButton } from "./Button";
import { IconButton } from "./IconButton";
import { FilterBar, FilterPills } from "./FilterPills";
import { GroupHeader, ListGroup } from "./GroupHeader";
import { Timeline, TimelineComment, TimelineDivider, TimelineEvent } from "./Timeline";
import { Property, PropertyRail, PropertySection } from "./PropertyRail";
import { Composer, ContextChip } from "./Composer";
import { Board, BoardCard, BoardColumn } from "./Board";
import { ChatBubble, ChatThread, WorkedFor, formatDuration } from "./ChatBubble";
import { ChangesCard } from "./ChangesCard";

afterEach(cleanup);

describe("IconButton", () => {
  it("is circular by default, labelled, and re-exported from ./Button", () => {
    expect(IconButtonFromButton).toBe(IconButton);
    render(<IconButton icon="bell" label="Notifications" variant="outline" />);
    const b = screen.getByRole("button", { name: "Notifications" });
    expect(b.className).toMatch(/v2-iconbtn-circle/);
    expect(b.className).toMatch(/v2-iconbtn-outline/);
    expect(b.getAttribute("title")).toBe("Notifications");
    expect(b.getAttribute("type")).toBe("button");
  });
  it("square shape opts out; busy disables; custom glyph renders", () => {
    render(<IconButton glyph={<svg data-testid="g" />} label="Send" shape="square" busy />);
    const b = screen.getByRole("button", { name: "Send" });
    expect(b.className).not.toMatch(/circle/);
    expect(b).toBeDisabled();
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("g")).toBeTruthy();
  });
  it("Button pill adds the pill class, keeps variant classes", () => {
    render(<Button pill>Preview</Button>);
    expect(screen.getByRole("button", { name: "Preview" }).className).toMatch(/v2-btn-secondary v2-btn-md v2-btn-pill/);
  });
});

describe("FilterPills", () => {
  const items = [{ key: "all", label: "All tasks" }, { key: "active", label: "Active", count: 4 }, { key: "backlog", label: "Backlog", count: null }];
  it("renders a radiogroup with the selected pill checked and counts (null = none)", () => {
    render(<FilterBar actions={<IconButton icon="sliders" label="Filter" />}><FilterPills label="Scope" items={items} value="active" onChange={() => {}} /></FilterBar>);
    const group = screen.getByRole("radiogroup", { name: "Scope" });
    const radios = screen.getAllByRole("radio");
    expect(group).toBeTruthy();
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(radios[1].tabIndex).toBe(0);
    expect(radios[0].tabIndex).toBe(-1);
    expect(radios[1].textContent).toContain("4");
    expect(radios[2].querySelector(".v2-pill-count")).toBeNull();
  });
  it("click and arrow keys change the value", () => {
    const onChange = vi.fn();
    render(<FilterPills label="Scope" items={items} value="all" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Backlog" }));
    expect(onChange).toHaveBeenLastCalledWith("backlog");
    fireEvent.keyDown(screen.getByRole("radio", { name: "All tasks" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("active");
    fireEvent.keyDown(screen.getByRole("radio", { name: "All tasks" }), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("backlog");
  });
  it("link mode renders nav links with aria-current", () => {
    render(<MemoryRouter><FilterPills label="Views" value="b" items={[{ key: "a", label: "A", to: "/x?f=a" }, { key: "b", label: "B", to: "/x?f=b" }]} /></MemoryRouter>);
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "B" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("link", { name: "A" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("GroupHeader / ListGroup", () => {
  it("collapses its region and exposes aria-expanded + controls", () => {
    render(<ListGroup id="todo" title="Todo" count={4}><div>row one</div></ListGroup>);
    const t = screen.getByRole("button", { name: /Todo/ });
    expect(t.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(t.getAttribute("aria-controls")!)!;
    expect(region.hidden).toBe(false);
    fireEvent.click(t);
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(region.hidden).toBe(true);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("4");
  });
  it("add button is a labelled real button; count null renders no number", () => {
    const onAdd = vi.fn();
    render(<GroupHeader title="In review" open count={null} onAdd={onAdd} addLabel="New task in In review" />);
    fireEvent.click(screen.getByRole("button", { name: "New task in In review" }));
    expect(onAdd).toHaveBeenCalled();
    expect(document.querySelector(".v2-group-count")).toBeNull();
  });
  it("persists collapse state under storageKey", () => {
    localStorage.removeItem("t:g:done");
    const { unmount } = render(<ListGroup id="done" storageKey="t:g" title="Done"><div>x</div></ListGroup>);
    fireEvent.click(screen.getByRole("button", { name: /Done/ }));
    expect(localStorage.getItem("t:g:done")).toBe("0");
    unmount();
    render(<ListGroup id="done" storageKey="t:g" title="Done"><div>x</div></ListGroup>);
    expect(screen.getByRole("button", { name: /Done/ }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Timeline", () => {
  it("renders event lines, comment cards and dividers in an ordered list", () => {
    const at = new Date(Date.now() - 5 * 60000).toISOString();
    render(
      <Timeline label="Task activity">
        <TimelineDivider>Today</TimelineDivider>
        <TimelineEvent icon="flag" actor="lead" at={at}>set priority to <b>High</b></TimelineEvent>
        <TimelineComment author="karri" at={at}>Looks good</TimelineComment>
        <TimelineEvent actor="qa" time="just now">verified</TimelineEvent>
      </Timeline>,
    );
    const list = screen.getByRole("list", { name: "Task activity" });
    expect(list.tagName).toBe("OL");
    const ev = list.querySelector(".v2-tl-event")!;
    expect(ev.textContent).toMatch(/lead set priority to High · 5m ago/);
    const time = ev.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe(new Date(at).toISOString());
    expect(time.getAttribute("title")).toBeTruthy();
    expect(list.querySelector(".v2-tl-card .v2-tl-msg-body")!.textContent).toBe("Looks good");
    expect(screen.getByText("just now")).toBeTruthy();
  });
  it("omits the separator and time when none is known", () => {
    render(<Timeline label="a"><TimelineEvent actor="x">did a thing</TimelineEvent></Timeline>);
    expect(document.querySelector(".v2-tl-sep")).toBeNull();
    expect(document.querySelector("time")).toBeNull();
  });
});

describe("PropertyRail", () => {
  it("renders labelled term/definition pairs and explicit empty text", () => {
    render(
      <PropertyRail label="Task properties">
        <PropertySection title="Properties">
          <Property label="Status">In progress</Property>
          <Property label="Reviewer" empty="No reviewer" />
          <Property label="Cost" />
        </PropertySection>
      </PropertyRail>,
    );
    expect(screen.getByRole("complementary", { name: "Task properties" })).toBeTruthy();
    expect(screen.getByText("No reviewer").className).toMatch(/is-empty/);
    expect(screen.getByText("None").className).toMatch(/is-empty/);
    expect(screen.getByText("In progress").className).not.toMatch(/is-empty/);
  });
});

describe("Composer", () => {
  function setup(extra: Partial<Parameters<typeof Composer>[0]> = {}) {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const r = render(<Composer label="Comment" placeholder="Leave a comment…" value="hi" onChange={onChange} onSubmit={onSubmit} {...extra} />);
    return { onSubmit, onChange, ...r };
  }
  it("Enter submits, Shift+Enter does not, IME composition does not", () => {
    const { onSubmit } = setup();
    const ta = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
  it("send is disabled for empty text and while busy", () => {
    const { rerender, onSubmit } = setup({ value: "   " });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(<Composer label="Comment" value="x" onChange={() => {}} onSubmit={onSubmit} busy />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
  it("running + onStop swaps send for a circular Stop", () => {
    const onStop = vi.fn();
    setup({ running: true, onStop });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    const stop = screen.getByRole("button", { name: "Stop run" });
    expect(stop.className).toMatch(/v2-iconbtn-circle/);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalled();
  });
  it("attach opens a file input and forwards files; disabled reason is announced", () => {
    const onFiles = vi.fn();
    setup({ onFiles, disabled: true, disabledReason: "Only members can comment" });
    expect(screen.getByRole("button", { name: "Attach files" })).toBeDisabled();
    const ta = screen.getByRole("textbox");
    expect(ta.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(ta.getAttribute("aria-describedby")!)!.textContent).toBe("Only members can comment");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["a"], "a.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFiles).toHaveBeenCalled();
  });
  it("ContextChip remove button is labelled", () => {
    const onRemove = vi.fn();
    render(<ContextChip onRemove={onRemove} removeLabel="Remove T-364">T-364</ContextChip>);
    fireEvent.click(screen.getByRole("button", { name: "Remove T-364" }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe("Board", () => {
  it("renders labelled columns with counts, cards as links, and an empty state", () => {
    render(
      <MemoryRouter>
        <Board label="Agent tasks">
          <BoardColumn id="lead" title="lead" count={1} onAdd={() => {}} addLabel="New task for lead">
            <BoardCard to="/tasks/1" id="T-1" title="Faster app launch" chips={<span>Performance</span>} />
          </BoardColumn>
          <BoardColumn id="qa" title="qa-bot" count={0} />
        </Board>
      </MemoryRouter>,
    );
    expect(screen.getByRole("region", { name: "Agent tasks" })).toBeTruthy();
    const col = screen.getByRole("region", { name: "lead" });
    expect(col.textContent).toContain("1");
    const card = screen.getByRole("link", { name: /Faster app launch/ });
    expect(card.getAttribute("href")).toBe("/tasks/1");
    expect(card.textContent).toContain("T-1");
    expect(screen.getByRole("button", { name: "New task for lead" })).toBeTruthy();
    expect(screen.getByText("No tasks")).toBeTruthy();
  });
  it("button cards call onClick", () => {
    const onClick = vi.fn();
    render(<BoardColumn id="a" title="a"><BoardCard title="Pick me" onClick={onClick} /></BoardColumn>);
    fireEvent.click(screen.getByRole("button", { name: /Pick me/ }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("ChatBubble / WorkedFor", () => {
  it("user vs agent classes, log role, danger status is an alert", () => {
    render(
      <ChatThread label="Conversation with lead">
        <ChatBubble from="user" status="Not delivered" statusTone="danger">Fix it</ChatBubble>
        <ChatBubble from="agent" author="lead">Done</ChatBubble>
      </ChatThread>,
    );
    expect(screen.getByRole("log", { name: "Conversation with lead" })).toBeTruthy();
    expect(screen.getByText("Fix it").closest(".v2-msg")!.className).toMatch(/v2-msg-user/);
    expect(screen.getByText("Done").closest(".v2-msg")!.className).toMatch(/v2-msg-agent/);
    expect(screen.getByRole("alert").textContent).toBe("Not delivered");
  });
  it("formatDuration never invents a zero", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(10_000)).toBe("10 sec");
    // C1b: a 16 ms run is "less than 1 sec", never "0 sec".
    expect(formatDuration(16)).toBe("less than 1 sec");
    expect(formatDuration(0)).toBe("less than 1 sec");
    expect(formatDuration(600)).toBe("1 sec");
    expect(formatDuration(125_000)).toBe("2 min 5 sec");
    expect(formatDuration(3_600_000 + 240_000)).toBe("1 h 4 min");
  });
  it("WorkedFor toggles its detail and reads Working… while running", () => {
    const { rerender } = render(<WorkedFor ms={10_000}><p>detail</p></WorkedFor>);
    const b = screen.getByRole("button", { name: /Worked for 10 sec/ });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("detail").closest("[hidden]")).not.toBeNull();
    fireEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("detail").closest("[hidden]")).toBeNull();
    rerender(<WorkedFor ms={3_000} running />);
    expect(screen.getByRole("button", { name: "Working… 3 sec" })).toBeDisabled();
  });
});

describe("ChangesCard", () => {
  it("renders stats, PR and branch from real data", () => {
    render(<ChangesCard files={2} additions={22} deletions={10} pr={{ number: 55, title: "Reset rows", state: "draft", href: "https://github.com/o/r/pull/55" }} base="main" branch="orcha/t-1" />);
    const card = screen.getByRole("region", { name: "Code changes" });
    expect(card.textContent).toMatch(/Changed2 files\+22−10/);
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/o/r/pull/55");
    expect(card.textContent).toContain("Draft #55");
    expect(card.textContent).toContain("orcha/t-1");
  });
  it("omits unknown numbers (never 0) and renders nothing without data", () => {
    const { container, rerender } = render(<ChangesCard />);
    expect(container.innerHTML).toBe("");
    rerender(<ChangesCard branch="feat/x" />);
    expect(container.textContent).not.toMatch(/Changed|\+0|−0/);
    rerender(<ChangesCard files={1} additions={null} />);
    expect(container.textContent).toMatch(/1 file$/);
  });
});

describe("TimelineEvent body + oneLine (integration round 1)", () => {
  it("renders a one-line sentence with the time kept whole and a muted body line under it", async () => {
    const { render } = await import("@testing-library/react");
    const { Timeline, TimelineEvent } = await import("./Timeline");
    const { container } = render(
      <Timeline label="Updates">
        <TimelineEvent actor="lead" time="5m ago" oneLine body="Pushed the first pass">posted on <b>Login</b></TimelineEvent>
      </Timeline>,
    );
    const line = container.querySelector(".v2-tl-line.is-one-line")!;
    expect(line.querySelector(".v2-tl-text")!.textContent).toBe("lead posted on Login");
    expect(line.querySelector(".v2-tl-time")!.textContent).toBe("5m ago");
    expect(container.querySelector(".v2-tl-body")!.textContent).toBe("Pushed the first pass");
  });
});

/* ---- polish round 1 (primitives-b) --------------------------------------- */
import { Payload, humanizeKey, payloadTitle, githubRef, prettyUrl } from "./Payload";
import { revealSelected, scrollEdges } from "./FilterPills";

describe("Payload links (D4: no raw 'Pr url' + bare URL)", () => {
  it("humanizes *_url keys and keeps acronyms", () => {
    expect(humanizeKey("pr_url")).toBe("Pull request");
    expect(humanizeKey("prUrl")).toBe("Pull request");
    expect(humanizeKey("url")).toBe("Link");
    expect(humanizeKey("html_url")).toBe("Link");
    expect(humanizeKey("docs_url")).toBe("Docs");
    expect(humanizeKey("pr_number")).toBe("Pr number");
    expect(humanizeKey("pr")).toBe("Pr");
    expect(humanizeKey("assignee_agent_id")).toBe("Assignee agent");
  });
  it("parses GitHub PR / issue URLs and shortens other URLs", () => {
    expect(githubRef("https://github.com/acme/orcha-web/pull/102")).toEqual({ kind: "pull", owner: "acme", repo: "orcha-web", number: 102 });
    expect(githubRef("https://github.com/acme/orcha-web/issues/7#issuecomment-1")?.kind).toBe("issue");
    expect(githubRef("https://github.com/acme/orcha-web/tree/main")).toBeNull();
    expect(prettyUrl("https://www.example.com/a/b/")).toBe("example.com/a/b");
  });
  it("renders a result's pr_url as a linked PR chip, never 'Pr url' or the bare URL", () => {
    const url = "https://github.com/acme/orcha-web/pull/102";
    const { container } = render(<Payload value={{ summary: "Implemented and tested", pr_url: url, tests_passed: 214 }} />);
    expect(container.textContent).not.toMatch(/Pr url/);
    expect(container.textContent).not.toContain(url);
    const link = screen.getByRole("link", { name: /Pull request acme\/orcha-web#102/ });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.textContent).toContain("#102");
    expect(link.querySelector(".v2-prchip")).toBeTruthy();
  });
  it("other URLs render as a short one-line link with the full URL as tooltip", () => {
    const url = "https://www.example.com/reports/run-42/";
    render(<Payload value={{ report_url: url }} />);
    const a = screen.getByRole("link", { name: "example.com/reports/run-42" });
    expect(a.getAttribute("href")).toBe(url);
    expect(a.getAttribute("title")).toBe(url);
    expect(screen.getByText("Report")).toBeTruthy();
  });
  it("a URL is never picked as the payload title", () => {
    expect(payloadTitle({ pr_url: "https://github.com/a/b/pull/1", note: "Shipped" })).toBe("Shipped");
    expect(payloadTitle({ pr_url: "https://github.com/a/b/pull/1" }, "Result")).toBe("Result");
  });
});

describe("horizontal overflow helpers", () => {
  const fake = (scrollWidth: number, clientWidth: number, scrollLeft: number) =>
    ({ scrollWidth, clientWidth, scrollLeft } as unknown as HTMLElement);
  it("scrollEdges reports only the sides that hide content", () => {
    expect(scrollEdges(fake(300, 300, 0))).toBe("");
    expect(scrollEdges(fake(600, 300, 0))).toBe("end");
    expect(scrollEdges(fake(600, 300, 150))).toBe("start end");
    expect(scrollEdges(fake(600, 300, 300))).toBe("start");
  });
  it("revealSelected centres a clipped pill by moving only the scroller", () => {
    const scroller = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 300, width: 300 }) } as unknown as HTMLElement;
    const clipped = { getBoundingClientRect: () => ({ left: 380, right: 460, width: 80 }) } as unknown as HTMLElement;
    revealSelected(scroller, clipped);
    expect(scroller.scrollLeft).toBe(420 - 150);
    const visible = { getBoundingClientRect: () => ({ left: 20, right: 100, width: 80 }) } as unknown as HTMLElement;
    const s2 = { scrollLeft: 5, getBoundingClientRect: () => ({ left: 0, right: 300, width: 300 }) } as unknown as HTMLElement;
    revealSelected(s2, visible);
    expect(s2.scrollLeft).toBe(5);
  });
  it("FilterPills without overflow carries no fade", () => {
    render(<FilterPills label="Scope" value="a" items={[{ key: "a", label: "A" }, { key: "b", label: "B" }]} />);
    expect(screen.getByRole("radiogroup", { name: "Scope" }).hasAttribute("data-fade")).toBe(false);
  });
  it("Board exposes its column count for layout", () => {
    render(
      <Board label="Tasks">
        <BoardColumn id="a" title="A" />
        <BoardColumn id="b" title="B" />
      </Board>,
    );
    expect(screen.getByRole("region", { name: "Tasks" }).getAttribute("data-cols")).toBe("2");
  });
});

describe("TimelineEvent bodyLines", () => {
  it("defaults to a one-line body and allows a 2-line clamp", () => {
    render(
      <Timeline label="t">
        <TimelineEvent actor="lead" body="one">posted</TimelineEvent>
        <TimelineEvent actor="qa" body="two" bodyLines={2}>posted</TimelineEvent>
      </Timeline>,
    );
    expect(screen.getByText("one").className).toBe("v2-tl-body");
    expect(screen.getByText("two").className).toContain("is-2");
  });
});

/* ---- polish round 2 (primitives-b) --------------------------------------- */
import { COMPOSER_KEY_HINT } from "./Composer";
import { Dialog } from "./Dialog";
import { Menu } from "./Menu";
import { useRef as useRef2, useState as useState2 } from "react";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

describe("Payload: GitHub refs inline (gate M1 — no nested 'Pull request [#102]' row)", () => {
  const url = "https://github.com/acme/orcha-web/pull/102";
  it("puts the PR chip on the title line and renders no 'Pull request' label", () => {
    const { container } = render(<Payload value={{ summary: "Implemented and tested", pr_url: url }} />);
    const title = container.querySelector(".v2-payload-title")!;
    expect(title.textContent).toContain("Implemented and tested");
    const link = screen.getByRole("link", { name: /#102/ });
    expect(title.contains(link)).toBe(true);
    expect(container.querySelector(".v2-kv")).toBeNull();
    expect(container.textContent).not.toMatch(/Pull request/);
  });
  it("drops a pr_number that repeats the linked PR (same fact twice)", () => {
    const { container } = render(<Payload value={{ summary: "Done", pr_url: url, pr_number: 102, tests_passed: 3 }} />);
    expect(container.textContent).not.toMatch(/Pr number/);
    expect(container.textContent).toContain("Tests passed");
  });
  it("without a title, refs render on their own line (still no label)", () => {
    const { container } = render(<Payload value={{ pr_url: url }} />);
    expect(container.querySelector(".v2-payload-refline a[href='" + url + "']")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Pull request/);
  });
  it("non-GitHub links keep their labelled row", () => {
    render(<Payload value={{ summary: "x", report_url: "https://example.com/r" }} />);
    expect(screen.getByText("Report")).toBeTruthy();
  });
});

describe("Composer keyHint — one shared hint copy", () => {
  it("renders the shared copy only when asked, and not when disabled", () => {
    const { container, rerender } = render(<Composer label="Reply" value="" onChange={() => {}} onSubmit={() => {}} keyHint />);
    expect(container.querySelector(".v2-composer-hint")!.textContent).toBe(COMPOSER_KEY_HINT);
    rerender(<Composer label="Reply" value="" onChange={() => {}} onSubmit={() => {}} keyHint disabled disabledReason="No human" />);
    expect(container.querySelector(".v2-composer-hint")).toBeNull();
    rerender(<Composer label="Reply" value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(container.querySelector(".v2-composer-hint")).toBeNull();
  });
});

describe("Board aside (sticky 'Hidden columns' rail)", () => {
  it("renders the aside as the board's last child and flags the board", () => {
    const { container } = render(
      <MemoryRouter>
        <Board label="Task board" aside={<section aria-label="Hidden columns">Completed 3</section>}>
          <BoardColumn id="a" title="A" />
        </Board>
      </MemoryRouter>,
    );
    const board = container.querySelector(".v2-board")!;
    expect(board.classList.contains("has-aside")).toBe(true);
    expect(board.lastElementChild!.classList.contains("v2-board-aside")).toBe(true);
    expect(screen.getByRole("region", { name: "Hidden columns" })).toBeTruthy();
  });
  it("no aside → no flag", () => {
    const { container } = render(<MemoryRouter><Board label="B"><BoardColumn id="a" title="A" /></Board></MemoryRouter>);
    expect(container.querySelector(".v2-board.has-aside")).toBeNull();
    expect(container.querySelector(".v2-board-aside")).toBeNull();
  });
});

describe("menus opened inside a dialog (New task B1)", () => {
  function Harness({ onPick }: { onPick: (v: string) => void }) {
    const ref = useRef2<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState2(false);
    return (
      <Dialog title="New task" onClose={() => {}}>
        <button ref={ref} type="button" onClick={() => setOpen(true)}>Priority</button>
        <Menu anchor={ref} open={open} onClose={() => setOpen(false)} label="Priority"
          items={["Urgent", "High", "Normal"].map((l) => ({ label: l, checked: l === "Normal", onSelect: () => onPick(l) }))} />
      </Dialog>
    );
  }
  it("portals the menu after the overlay and picks with the keyboard", () => {
    const picks: string[] = [];
    render(<Harness onPick={(v) => picks.push(v)} />);
    fireEvent.click(screen.getByRole("button", { name: "Priority" }));
    const menu = screen.getByRole("menu", { name: "Priority" });
    const overlay = document.querySelector(".v2-overlay")!;
    // DOM order is what the CSS sibling rule (.v2-overlay ~ .v2-popover) relies on
    expect(overlay.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const first = document.activeElement as HTMLElement;
    expect(first.textContent).toContain("Urgent");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    expect(picks).toEqual(["High"]);
  });
  it("the stylesheet lifts popovers that follow an open overlay above it", () => {
    const css = readFileSync(resolvePath(__dirname, "../../../../static/styles/v2-primitives.css"), "utf8");
    expect(css).toMatch(/\.v2-overlay ~ \.v2-popover\s*\{\s*z-index:\s*calc\(var\(--v2-z-dialog\) \+ 1\)/);
  });
});
