/**
 * Stories-style contracts for the D7/D8 primitives (owner: primitives-a):
 * Avatar/AvatarStack, StatusIcon (every STAT status), PriorityIcon, Chip/PrChip,
 * LivePill (+ truthful liveStateFor), HealthChip, and the legacy ui.tsx
 * Avatar/Pill wrappers that now render through them.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STAT } from "../../lib/status";
import { Avatar as LegacyAvatar, Icon, Pill, hasIcon } from "../ui";
import {
  Avatar, AvatarStack, Chip, HealthChip, LivePill, PrChip, PriorityIcon, StatusIcon, avatarPx, liveStateFor,
  presenceTone, priorityLevel, statusColor, statusLabel, statusShape,
  AVATAR_HUES, assignPalette, paletteColor, paletteIndex, projectInitials,
} from "./index";

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, "../../../../static/styles/v2-primitives.css"), "utf8");

describe("Avatar (D7)", () => {
  it("story: AI agent, 20px — circle, initial, sparkle badge, accessible name", () => {
    const { container } = render(<Avatar alias="frontend-dev" kind="ai" size={20} />);
    const av = screen.getByRole("img", { name: "frontend-dev · AI agent" });
    expect(av.className).toContain("v2-av-20");
    expect(av.textContent).toBe("F");
    expect(container.querySelector(".v2-av-spark")).not.toBeNull();
  });
  it("story: human — no sparkle, same circle (kind is a badge, never a shape change)", () => {
    const { container } = render(<Avatar alias="hussein" kind="human" size={24} />);
    expect(screen.getByRole("img", { name: "hussein · Human" })).toBeInTheDocument();
    expect(container.querySelector(".v2-av-spark")).toBeNull();
    expect(container.querySelector(".v2-av")!.className).not.toContain("v2-av-project");
  });
  it("story: status badge carries the exact STAT label (not colour only)", () => {
    const { container } = render(<Avatar alias="lead" kind="ai" status="awaiting_human" size={24} />);
    expect(screen.getByRole("img", { name: "lead · AI agent · Needs human" })).toHaveAttribute("title", "lead · AI agent · Needs human");
    const dot = container.querySelector(".v2-av-dot")!;
    expect(dot.className).toContain("is-wait");
    // r3: kind and presence live in different corners (sparkle top-right)
    expect(container.querySelector(".v2-av-spark")).not.toBeNull();
    expect(container.querySelectorAll(".v2-av-badge")).toHaveLength(2);
  });
  it("sparkle is hidden at 16px unless forced", () => {
    const { container, rerender } = render(<Avatar alias="a" kind="ai" size={16} />);
    expect(container.querySelector(".v2-av-spark")).toBeNull();
    rerender(<Avatar alias="a" kind="ai" size={16} showKind />);
    expect(container.querySelector(".v2-av-spark")).not.toBeNull();
  });
  it("GitHub login upgrades to the image and falls back to the initial on error", () => {
    const { container } = render(<Avatar alias="sara" kind="human" ghLogin="sara-gh" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://github.com/sara-gh.png?size=64");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("S");
  });
  it("rejects unsafe logins (no URL injection)", () => {
    const { container } = render(<Avatar alias="x" ghLogin="../evil?x" />);
    expect(container.querySelector("img")).toBeNull();
  });
  it("decorative avatars are aria-hidden", () => {
    const { container } = render(<Avatar alias="qa-bot" kind="ai" decorative />);
    expect(container.querySelector(".v2-av")).toHaveAttribute("aria-hidden", "true");
  });
  it("size + presence mapping", () => {
    expect(avatarPx("sm")).toBe(20);
    expect(avatarPx(33)).toBe(24);
    expect(presenceTone("working")).toBe("live");
    expect(presenceTone("failed")).toBe("bad");
    expect(presenceTone("idle")).toBe("idle");
  });
  it("CSS: every v2 avatar is a circle — projects too (desktop parity)", () => {
    expect(css).toMatch(/\.av\.v2-av\s*\{[^}]*border-radius:\s*50%/);
    expect(css).toMatch(/\.av\.v2-av\.v2-av-project\s*\{[^}]*border-radius:\s*50%/);
  });

  it("project avatars show two initials", () => {
    const { container } = render(<Avatar alias="billing-service" kind="project" seed="c1" decorative />);
    expect(container.querySelector(".v2-av-init")!.textContent).toBe("BS");
    expect(projectInitials("orcha")).toBe("OR");
  });
});

describe("Avatar round 1 (kind + presence together, system actor)", () => {
  it("r3: status dot always bottom-right, AI sparkle always its own top-right badge", () => {
    const { container } = render(<Avatar alias="lead" kind="ai" status="working" size={24} />);
    const dot = container.querySelector(".v2-av-badge.v2-av-dot")!;
    expect(dot.className).toContain("is-live");
    expect(dot.querySelector("svg")).toBeNull(); // the dot never hosts the sparkle
    expect(container.querySelector(".v2-av-badge.v2-av-spark svg")).not.toBeNull();
    expect(container.querySelector(".has-spark")).toBeNull();
    // CSS: spark pinned to the top corner, dot to the bottom corner
    expect(css).toMatch(/\.v2-av \.v2-av-spark\s*\{[^}]*top:\s*-2px;[^}]*bottom:\s*auto/);
    expect(css).toMatch(/\.v2-av \.v2-av-badge\s*\{[^}]*right:\s*-2px;\s*bottom:\s*-2px/);
    expect(css).not.toMatch(/has-spark/);
  });
  it("human + status: plain dot, no sparkle; AI at 16px: plain dot, no sparkle", () => {
    const { container, rerender } = render(<Avatar alias="hussein" kind="human" status="working" size={24} />);
    expect(container.querySelector(".v2-av-spark")).toBeNull();
    expect(container.querySelector(".v2-av-dot")).not.toBeNull();
    rerender(<Avatar alias="lead" kind="ai" status="working" size={16} />);
    expect(container.querySelector(".v2-av-spark")).toBeNull();
    expect(container.querySelector(".v2-av-dot.is-live")).not.toBeNull();
  });
  it("idle AI: hollow idle dot bottom-right + sparkle top-right (label still says Idle)", () => {
    const { container } = render(<Avatar alias="qa" kind="ai" status="idle" size={20} />);
    expect(container.querySelectorAll(".v2-av-badge")).toHaveLength(2);
    expect(container.querySelector(".v2-av-dot.is-idle")).not.toBeNull();
    expect(container.querySelector(".v2-av-spark")).not.toBeNull();
    expect(screen.getByRole("img", { name: "qa · AI agent · Idle" })).toBeInTheDocument();
  });
  it("system actor: neutral circle with a gear glyph, never a bare dot; inferred from alias 'system'", () => {
    const { container } = render(<><Avatar alias="system" size={20} /><Avatar alias="Orcha" kind="system" size={24} /></>);
    const avs = container.querySelectorAll(".v2-av");
    expect(avs).toHaveLength(2);
    for (const av of Array.from(avs)) {
      expect(av.className).toContain("v2-av-system");
      expect(av.querySelector("svg.v2-av-sys")).not.toBeNull();
      expect(av.textContent).toBe("");
      expect((av as HTMLElement).style.background).toBe("");
    }
    expect(screen.getByRole("img", { name: "system" })).toBeInTheDocument();
  });
  it("system actor never shows a status dot or a GitHub image", () => {
    const { container } = render(<Avatar alias="system" kind="system" status="working" ghLogin="octo" />);
    expect(container.querySelector(".v2-av-badge")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("D13 avatar palette parity with the desktop", () => {
  it("uses the desktop's ten hues and FNV-1a slot hash", () => {
    expect([...AVATAR_HUES]).toEqual([4, 30, 50, 95, 145, 178, 208, 238, 272, 318]);
    // reference values computed with desktop/src/renderer/src/ui/Avatar.tsx paletteIndex
    const fnv = (key: string) => {
      let h = 0x1f54177e;
      for (const c of key) { h ^= c.codePointAt(0) ?? 0; h = Math.imul(h, 0x01000193) >>> 0; }
      return h % 10;
    };
    for (const k of ["lead", "backend-dev", "frontend-dev", "qa-bot", "docs", "reviewer"]) expect(paletteIndex(k)).toBe(fnv(k));
    // hue per slot; the tone is theme-driven (dark fallbacks = the D13 34%/28% + 72%/86%)
    expect(paletteColor(0)).toEqual({ background: "hsl(4 var(--v2-av-fill-s, 34%) var(--v2-av-fill-l, 28%))", color: "hsl(4 var(--v2-av-ink-s, 72%) var(--v2-av-ink-l, 86%))" });
  });

  it("assignPalette never repeats a slot inside one list (until the palette is exhausted)", () => {
    const keys = Array.from({ length: 10 }, (_, i) => "agent-" + i);
    const slots = new Set(assignPalette(keys).values());
    expect(slots.size).toBe(10);
  });

  it("an avatar stack gives neighbours distinct colours", () => {
    const { container } = render(
      <AvatarStack actors={["lead", "backend-dev", "frontend-dev"].map((alias) => ({ alias, kind: "ai" }))} max={3} />,
    );
    const bgs = Array.from(container.querySelectorAll<HTMLElement>(".v2-av")).map((e) => e.style.background);
    expect(new Set(bgs).size).toBe(3);
  });
});

describe("AvatarStack palette", () => {
  it("keeps a caller-assigned palette slot (page-wide colours) instead of re-picking", () => {
    const { container } = render(<AvatarStack actors={[{ alias: "lead", kind: "ai", palette: 7 }, { alias: "ops", kind: "ai", palette: 2 }]} />);
    const { container: ref } = render(<><Avatar alias="lead" kind="ai" palette={7} /><Avatar alias="ops" kind="ai" palette={2} /></>);
    const bg = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>(".v2-av")).map((e) => e.style.background);
    expect(bg(container)).toEqual(bg(ref));
  });
});

describe("AvatarStack", () => {
  it("story: 4 assignees, max 3 → three -4px-overlapped circles + '+1', full list named", () => {
    const { container } = render(
      <AvatarStack label="Assignees" actors={[{ alias: "lead", kind: "ai" }, { alias: "qa-bot" }, { alias: "sara", kind: "human" }, { alias: "ops" }]} />,
    );
    expect(screen.getByRole("img", { name: "Assignees: lead, qa-bot, sara, ops" })).toBeInTheDocument();
    expect(container.querySelectorAll(".v2-av")).toHaveLength(3);
    expect(container.querySelector(".v2-avstack-more")!.textContent).toBe("+1");
    expect(css).toMatch(/\.v2-avstack \.av\.v2-av \+ \.av\.v2-av\s*\{\s*margin-left:\s*-4px/);
  });
  it("renders nothing for an empty list (unknown is not someone)", () => {
    const { container } = render(<AvatarStack actors={[{ alias: "" }, { alias: null }]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("StatusIcon (D8)", () => {
  it("covers EVERY STAT status with a known glyph and its exact label", () => {
    for (const [status, meta] of Object.entries(STAT)) {
      expect(statusShape(status), status).not.toBe("unknown");
      expect(statusLabel(status)).toBe(meta.l);
    }
  });
  it("Linear semantics: todo ring, half-filled in-progress, done check, cancelled slash, dashed pending", () => {
    expect(statusShape("ready")).toBe("todo");
    expect(statusShape("in_progress")).toBe("progress");
    expect(statusColor("in_progress")).toBe("progress");
    expect(statusShape("completed")).toBe("done");
    expect(statusColor("completed")).toBe("done");
    expect(statusShape("cancelled")).toBe("cancelled");
    expect(statusShape("pending")).toBe("dashed");
    expect(statusShape("needs_verification")).toBe("review");
    expect(statusColor("blocked")).toBe("danger");
  });
  it("distinct glyphs where meaning differs (failed ≠ blocked ≠ terminated ≠ rejected; cancelled ≠ closed ≠ completed)", () => {
    const bad = ["failed", "blocked", "terminated", "rejected", "escalated"].map(statusShape);
    expect(new Set(bad).size).toBe(bad.length);
    const ends = ["cancelled", "closed", "completed"].map((s) => `${statusShape(s)}/${statusColor(s)}`);
    expect(new Set(ends).size).toBe(3);
  });
  it("story: sr-only label by default, visible with showLabel, raw value for unknown statuses", () => {
    render(<><StatusIcon status="awaiting_request" /><StatusIcon status="needs_verification" showLabel /><StatusIcon status="weird_new" /></>);
    expect(screen.getByText("Waiting").className).toBe("v2-sr");
    expect(screen.getByText("Needs verification").className).toBe("v2-si-label");
    expect(screen.getByText("weird_new")).toBeInTheDocument();
  });
});

describe("PriorityIcon (D8)", () => {
  it("buckets through taskQuery (urgent ≤5, high ≤20, normal default, low)", () => {
    expect(priorityLevel(1)).toBe("urgent");
    expect(priorityLevel(10)).toBe("high");
    expect(priorityLevel(null)).toBe("normal");
    expect(priorityLevel(500)).toBe("low");
  });
  it("story: bars lit by level; urgent is the orange '!' square; exact number in tooltip", () => {
    const { container } = render(<><PriorityIcon priority={10} /><PriorityIcon priority={100} /><PriorityIcon priority={2} /></>);
    const [high, normal] = Array.from(container.querySelectorAll(".v2-prio-g:not(.is-urgent)"));
    expect(high.querySelectorAll(".on")).toHaveLength(3);
    expect(normal.querySelectorAll(".on")).toHaveLength(2);
    expect(container.querySelector(".v2-prio-g.is-urgent")).not.toBeNull();
    expect(screen.getByTitle("Priority: Urgent (2, lower = higher)")).toBeInTheDocument();
    expect(screen.getByText("High priority").className).toBe("v2-sr");
  });
});

describe("Chip + PrChip (D8)", () => {
  it("story: label chip with a dot; interactive chips are buttons with pressed state", () => {
    const onClick = vi.fn();
    const { container } = render(<><Chip dot="auto">Performance</Chip><Chip selected onClick={onClick}>Active</Chip></>);
    expect(container.querySelector(".v2-chip-dot")).not.toBeNull();
    const b = screen.getByRole("button", { name: "Active" });
    expect(b).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalled();
  });
  it("story: PR chip names the state (never colour only) and links out", () => {
    render(<PrChip number={55234} state="merged" href="https://github.com/o/r/pull/55234" />);
    const a = screen.getByRole("link", { name: "Pull request #55234 (merged)" });
    expect(a.textContent).toBe("#55234");
    expect(a.className).toContain("is-merged");
  });
  it("CSS: chips are rounded-full with a 1px border", () => {
    expect(css).toMatch(/\.v2-chip\s*\{[^}]*border-radius:\s*999px[^}]*border:\s*1px solid var\(--v2-border\)/);
  });
});

describe("LivePill (D8/D9)", () => {
  it("story: 'Working…' with the actor avatars", () => {
    const { container } = render(<LivePill state="working" actors={[{ alias: "frontend-dev", kind: "ai" }]} />);
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(container.querySelector(".v2-live")).toHaveAttribute("title", "Working… — frontend-dev");
    expect(container.querySelectorAll(".v2-av")).toHaveLength(1);
  });
  it("labels are the canonical five", () => {
    render(<>{(["working", "waiting", "needs_review", "error", "finished"] as const).map((s) => <LivePill key={s} state={s} />)}</>);
    for (const t of ["Working…", "Waiting", "Needs review", "Error", "Finished"]) expect(screen.getByText(t)).toBeInTheDocument();
  });
  it("text is neutral in every state; only Error / Needs review add a coloured dot", () => {
    const { container } = render(<>{(["working", "waiting", "needs_review", "error", "finished"] as const).map((s) => <LivePill key={s} state={s} />)}</>);
    const dots = Array.from(container.querySelectorAll(".v2-live-dot")).map((d) => d.className);
    expect(dots).toEqual(["v2-live-dot is-warn", "v2-live-dot is-danger"]);
    expect(css).not.toMatch(/\.v2-live\.is-error\s*\{[^}]*color/);
    expect(css).not.toMatch(/\.v2-live\.is-needs_review\s*\{[^}]*color/);
  });
  it("liveStateFor is truthful: no pill without a live signal", () => {
    expect(liveStateFor({ taskStatus: "ready" })).toBeNull();
    expect(liveStateFor({ taskStatus: "pending" })).toBeNull();
    expect(liveStateFor({ taskStatus: "cancelled" })).toBeNull();
    expect(liveStateFor({ taskStatus: "blocked" })).toBeNull();
    expect(liveStateFor({ taskStatus: "in_progress", agentStatus: "idle" })).toBeNull();
    expect(liveStateFor({ taskStatus: "in_progress", agentStatus: "working" })).toBe("working");
    expect(liveStateFor({ runStatus: "running" })).toBe("working");
    expect(liveStateFor({ taskStatus: "needs_verification" })).toBe("needs_review");
    expect(liveStateFor({ agentStatus: "awaiting_request" })).toBe("waiting");
    expect(liveStateFor({ taskStatus: "failed" })).toBe("error");
    expect(liveStateFor({ taskStatus: "completed" })).toBe("finished");
  });
});

describe("HealthChip (D8)", () => {
  it("story: word always printed, glyph + colour per state", () => {
    const { container } = render(<><HealthChip health="on_track" /><HealthChip health="at_risk" /><HealthChip health="off_track" /><HealthChip health="no_data" /></>);
    for (const t of ["On track", "At risk", "Off track", "No data"]) expect(screen.getByText(t)).toBeInTheDocument();
    const paths = Array.from(container.querySelectorAll(".v2-health-g path")).map((p) => p.getAttribute("d"));
    expect(new Set(paths).size).toBe(4);
  });
  it("'At risk' is not a check mark (a check beside '4 failed' contradicts itself)", () => {
    const { container } = render(<HealthChip health="at_risk" />);
    const d = container.querySelector(".v2-health-g path")!.getAttribute("d")!;
    const { container: ok } = render(<StatusIcon status="accepted" />);
    const check = ok.querySelector("svg path")!.getAttribute("d");
    expect(d).not.toBe(check);
    expect(d).toMatch(/^M3\.6 7h/); // flat arrow
  });
});

describe("legacy ui.tsx wrappers render through the D7/D8 primitives", () => {
  it("Avatar keeps .av (+ .human) and maps sm→20, default→24, lg→32", () => {
    const { container } = render(<><LegacyAvatar alias="a" kind="ai" size="sm" /><LegacyAvatar alias="b" kind="human" /><LegacyAvatar alias="c" size="lg" /></>);
    const avs = Array.from(container.querySelectorAll(".av"));
    expect(avs.map((a) => a.className.match(/v2-av-(\d+)/)![1])).toEqual(["20", "24", "32"]);
    expect(avs[1].className).toContain("human");
  });
  it("Pill keeps `pill s-*`, draws the Linear glyph and the exact label", () => {
    const { container } = render(<Pill status="needs_verification" />);
    const p = container.querySelector(".pill")!;
    expect(p.className).toBe("pill s-attn");
    expect(p.textContent).toBe("Needs verification");
    expect(p.querySelector("svg.v2-si")!.getAttribute("data-shape")).toBe("review");
  });
});

describe("ui.tsx icon set (round 1)", () => {
  it("Settings (gear) and Execution (power) no longer share the sliders glyph", () => {
    for (const n of ["gear", "power", "execution", "pr", "star", "filter", "sort", "display", "circle-help"]) expect(hasIcon(n)).toBe(true);
    const html = (n: string) => render(<Icon name={n} />).container.innerHTML;
    expect(html("settings")).not.toBe(html("sliders"));
    expect(html("execution")).not.toBe(html("settings"));
    expect(html("execution")).not.toBe(html("sliders"));
    expect(html("sort")).not.toBe(html("filter"));
  });
});
