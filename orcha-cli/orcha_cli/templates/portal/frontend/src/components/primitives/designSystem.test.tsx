/** Design-system round 1: Button variants, Payload (D4), NavTabs (D1), Segmented, SplitPane drag, crumbs. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  Breadcrumbs, Button, ButtonLink, EmptyState, KeyValue, MenuButton, NavTabs, Payload, Section, Segmented, ShortId, SplitPane,
  humanizeKey, payloadText, payloadTitle,
} from "./index";

afterEach(cleanup);

describe("Button variants (D2)", () => {
  it("approve is an alias of primary — no green slab class", () => {
    render(<Button variant="approve" icon="check">Accept</Button>);
    const b = screen.getByRole("button", { name: "Accept" });
    expect(b.className).toContain("v2-btn-primary");
    expect(b.className).not.toContain("approve");
  });
  it("defaults to secondary md, type=button, with leading + trailing icons", () => {
    render(<Button icon="plus" iconRight="arrow">Open request</Button>);
    const b = screen.getByRole("button", { name: "Open request" });
    expect(b).toHaveAttribute("type", "button");
    expect(b.className).toMatch(/v2-btn-secondary v2-btn-md/);
    expect(b.querySelectorAll("svg")).toHaveLength(2);
    expect(b.querySelector(".v2-btn-ico-r")).not.toBeNull();
  });
  it("danger and link variants", () => {
    render(<><Button variant="danger">Close request</Button><Button variant="link">Expand full prompt</Button></>);
    expect(screen.getByRole("button", { name: "Close request" }).className).toContain("v2-btn-danger");
    expect(screen.getByRole("button", { name: "Expand full prompt" }).className).toContain("v2-btn-link");
  });
  it("ButtonLink renders an anchor with button styles (router or plain href)", () => {
    render(<MemoryRouter><ButtonLink to="/requests?r=1" iconRight="arrow" variant="ghost">Open request</ButtonLink><ButtonLink href="https://x.test">Docs</ButtonLink></MemoryRouter>);
    const a = screen.getByRole("link", { name: "Open request" });
    expect(a).toHaveAttribute("href", "/requests?r=1");
    expect(a.className).toContain("v2-btn-ghost");
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://x.test");
  });
});

describe("Payload (D4: never raw JSON / [object Object])", () => {
  it("titles from summary/question/title and lists remaining fields", () => {
    const p = { question: "Should the billing migration run tonight?", options: ["yes", "no"], priority: "high", due_at: "2026-09-28T10:00:00Z" };
    const { container } = render(<Payload value={p} />);
    expect(container.textContent).not.toMatch(/[{}]|\[object Object\]/);
    expect(container.querySelector(".v2-payload-title")).toHaveTextContent("Should the billing migration run tonight?");
    const dl = container.querySelector("dl")!;
    expect(within(dl).getByText("Options")).toBeInTheDocument();
    expect(within(dl).getByText("yes, no")).toBeInTheDocument();
    expect(within(dl).getByText("Priority")).toBeInTheDocument();
    expect(within(dl).getByText("Due at")).toBeInTheDocument();
    expect(dl.querySelector("time")).not.toBeNull();
  });
  it("parses JSON strings like objects", () => {
    const { container } = render(<Payload value={'{"summary":"API shape for /metrics","detail_level":2}'} />);
    expect(container.textContent).not.toContain('{"');
    expect(container.querySelector(".v2-payload-title")).toHaveTextContent("API shape for /metrics");
    expect(screen.getByText("Detail level")).toBeInTheDocument();
  });
  it("renders long body text as markdown", () => {
    const { container } = render(<Payload value={{ title: "Plan", body: "## Plan\n\n1. Audit tokens\n2. Ship **it** now please, this is long enough to be a body" }} />);
    expect(container.querySelector(".v2-payload-body")).not.toBeNull();
    expect(container.querySelector("strong")).toHaveTextContent("it");
    expect(container.textContent).not.toContain("**");
  });
  it("ids render as short mono ids with a copy button", () => {
    render(<Payload value={{ summary: "x", task_id: "0f8e4d2c-1111-4222-8333-444455556666" }} />);
    expect(screen.getByText("0f8e4d2c")).toHaveAttribute("title", "0f8e4d2c-1111-4222-8333-444455556666");
    expect(screen.getByRole("button", { name: /Copy task/ })).toBeInTheDocument();
  });
  it("deep / unknown shapes go into a collapsed 'Raw payload'-style disclosure, pretty-printed", () => {
    const { container } = render(<Payload value={{ summary: "s", graph: { nodes: [{ id: 1, edges: [{ to: 2 }] }] } }} />);
    const det = container.querySelector("details.v2-raw")!;
    expect(det).not.toBeNull();
    expect(det.hasAttribute("open")).toBe(false);
    expect(det.querySelector("pre")!.textContent).toContain('\n  "nodes"');
  });
  it("raw=true always offers the raw payload disclosure", () => {
    render(<Payload value={{ summary: "s" }} raw />);
    expect(screen.getByText("Raw payload")).toBeInTheDocument();
  });
  it("empty payloads render the empty copy or nothing", () => {
    const { container, rerender } = render(<Payload value={{}} />);
    expect(container.textContent).toBe("");
    rerender(<Payload value={null} empty="No details" />);
    expect(screen.getByText("No details")).toBeInTheDocument();
  });
  it("payloadTitle / payloadText / humanizeKey", () => {
    expect(payloadTitle({ question: "Q?" })).toBe("Q?");
    expect(payloadTitle('{"summary":"S"}')).toBe("S");
    expect(payloadTitle({ foo: 1 }, "Request")).toBe("Request");
    expect(payloadTitle(null, "Notification")).toBe("Notification");
    expect(payloadText({ question: "Q?", context: "more  text" })).toBe("Q? · more text");
    expect(payloadText({ a: { b: 1 } })).not.toContain("[object");
    expect(humanizeKey("assignee_agent_id")).toBe("Assignee agent");
    expect(humanizeKey("dueAt")).toBe("Due at");
  });
  it("KeyValue skips empty values; ShortId copy button is labelled", () => {
    render(<><KeyValue items={[{ label: "A", value: "1" }, { label: "B", value: null }]} /><ShortId id="abcdef1234567890" /></>);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.queryByText("B")).toBeNull();
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy id/ })).toBeInTheDocument();
  });
});

describe("NavTabs (D1 project tab bar)", () => {
  const tabs = [
    { key: "home", label: "Overview", to: "/" },
    { key: "tasks", label: "Tasks", to: "/tasks", count: 12 },
    { key: "requests", label: "Requests", to: "/requests", count: 140, countTone: "warn" as const },
  ];
  it("links keep their URLs, the current tab has aria-current=page, counts cap at 99+", () => {
    render(<MemoryRouter><NavTabs tabs={tabs} value="tasks" label="Project sections" /></MemoryRouter>);
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/", "/tasks", "/requests"]);
    expect(links[1]).toHaveAttribute("aria-current", "page");
    expect(links[0]).not.toHaveAttribute("aria-current");
    expect(within(links[2]).getByText("99+")).toBeInTheDocument();
  });
  it("arrow keys / Home / End move focus between tabs", () => {
    render(<MemoryRouter><NavTabs tabs={tabs} value="home" label="Project sections" /></MemoryRouter>);
    const links = screen.getAllByRole("link");
    links[0].focus();
    fireEvent.keyDown(links[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(links[1]);
    fireEvent.keyDown(links[1], { key: "End" });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(links[2], { key: "ArrowRight" });
    expect(document.activeElement).toBe(links[0]);
  });
});

describe("Segmented / MenuButton / Section", () => {
  it("segmented is a radiogroup with roving arrows", () => {
    let v = "open";
    const { rerender } = render(<Segmented label="Filter" value={v} onChange={(k) => { v = k; }} items={[{ key: "open", label: "Open" }, { key: "all", label: "All" }]} />);
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(v).toBe("all");
    rerender(<Segmented label="Filter" value={v} onChange={() => {}} items={[{ key: "open", label: "Open" }, { key: "all", label: "All" }]} />);
    expect(screen.getAllByRole("radio")[1]).toHaveAttribute("aria-checked", "true");
  });
  it("MenuButton opens a menu and marks the current choice", () => {
    render(<MenuButton label="Sort" value="Newest" menuLabel="Sort by" items={[{ label: "Newest", checked: true }, { label: "Oldest" }]} />);
    const b = screen.getByRole("button", { name: /Sort Newest/ });
    expect(b).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(b);
    expect(screen.getByRole("menu", { name: "Sort by" })).toBeInTheDocument();
    expect(b).toHaveAttribute("aria-expanded", "true");
  });
  it("Section is a labelled region with a rule, not a card", () => {
    render(<Section title="Definition of done">x</Section>);
    expect(screen.getByRole("region", { name: "Definition of done" }).className).toBe("v2-section");
  });
});

describe("SplitPane drag robustness", () => {
  it("pointercancel ends the drag (no pane following the cursor after mouseup)", () => {
    render(<SplitPane list={<div>list</div>} inspector={<div>detail</div>} defaultSize={400} min={320} max={600} />);
    const sep = screen.getByRole("separator");
    fireEvent.pointerDown(sep, { button: 0, clientX: 500, pointerId: 1 });
    expect(document.body.classList.contains("v2-resizing")).toBe(true);
    fireEvent.pointerCancel(sep, { pointerId: 1 });
    expect(document.body.classList.contains("v2-resizing")).toBe(false);
    fireEvent.pointerMove(window, { clientX: 300, buttons: 0 });
    expect(sep).toHaveAttribute("aria-valuenow", "400");
  });
  it("double-click resets to the default size", () => {
    render(<SplitPane list={<div>list</div>} inspector={<div>detail</div>} defaultSize={400} min={320} max={600} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "Home" });
    expect(sep).toHaveAttribute("aria-valuenow", "600");
    fireEvent.doubleClick(sep);
    expect(sep).toHaveAttribute("aria-valuenow", "400");
  });
});

describe("Breadcrumbs tooltips / EmptyState icon", () => {
  it("every string crumb carries its full text as a tooltip", () => {
    render(<MemoryRouter><Breadcrumbs collapsible items={[{ label: "billing-service-with-a-really-long-project-name", href: "/" }, { label: "Plan: rotate provider keys (fails on approve in staging)" }]} /></MemoryRouter>);
    expect(screen.getByRole("link")).toHaveAttribute("title", "billing-service-with-a-really-long-project-name");
    expect(screen.getByText(/Plan: rotate/)).toHaveAttribute("title", "Plan: rotate provider keys (fails on approve in staging)");
    expect(screen.getByRole("navigation").className).toContain("is-collapsible");
  });
  it("EmptyState compact with icon", () => {
    const { container } = render(<EmptyState compact icon="tasks" title="No open tasks" />);
    expect(container.querySelector(".v2-empty-compact .v2-empty-icon svg")).not.toBeNull();
  });
});
