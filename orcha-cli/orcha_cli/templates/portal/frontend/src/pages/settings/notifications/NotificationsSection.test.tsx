/**
 * Settings › Notifications (mig 063) + the bell's quick menu.
 *
 * A small in-memory fake of the notification-prefs API stands in for the server
 * (the real layering and should_notify are pytest-covered in
 * tests/test_notification_prefs.py). Covers: the matrix (available channels only,
 * the budget in-app lock), channel toggles and scopes (optimistic, then
 * reconciled), presets per mode, pause/snooze and resume, mute, quiet hours,
 * per-project override indicator + reset, plain-words errors that undo the
 * change, and viewer vs owner vs non-member.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui";
import { extensions, type Identity } from "../../../extensions";
import { SnapshotProvider } from "../../../state/SnapshotProvider";
import { resetIdentity } from "../../../cloud/identity";
import { SettingsPage } from "../SettingsPage";
import { HomePage } from "../../home/HomePage";
import { ncMenuItems } from "../../../shell/Shell";
import { SAFETY_LINE } from "./NotificationsSection";
import {
  effectiveRules, matchingPreset, pauseFor, pauseText, prefsErrText,
  type Catalog, type PrefsPayload, type Rule, type Rules,
} from "./notificationPrefs";

/* ------------------------------------------------------------ fake server */

const CH = ["in_app", "desktop", "push", "slack"] as const;
const rule = (scope: Rule["scope"], ...on: string[]): Rule => ({
  scope, channels: Object.fromEntries(CH.map((c) => [c, on.indexOf(c) >= 0])) as Rule["channels"],
});
const ALL = [...CH];
const CATS = [
  ["approvals", "Approvals & verifications"], ["requests", "Requests & questions to me"],
  ["escalations", "Escalations & blockers"], ["budget", "Budget alerts"],
  ["tasks", "Task assignment & status changes"], ["messages", "Agent messages & mentions"],
  ["routines", "Routine runs"], ["verdikt", "Verdikt / evidence results"],
  ["settings", "Membership & settings changes"],
];
const BUILTIN: Rules = {
  approvals: rule("all", ...ALL), requests: rule("all", ...ALL), escalations: rule("all", ...ALL),
  budget: rule("all", ...ALL), tasks: rule("mine", "in_app", "desktop"), messages: rule("mine", "in_app", "desktop"),
  routines: rule("all", "in_app"), verdikt: rule("all", "in_app", "desktop"), settings: rule("all", "in_app"),
};
const NEEDS_ME: Rules = {
  approvals: rule("mine", ...ALL), requests: rule("mine", ...ALL), escalations: rule("mine", ...ALL),
  budget: rule("mine", ...ALL), tasks: rule("mine", "in_app"), messages: rule("mine", "in_app"),
  routines: rule("off", "in_app"), verdikt: rule("off", "in_app"), settings: rule("off", "in_app"),
};
const CATALOG: Catalog = {
  categories: CATS.map(([key, label]) => ({ key, label, description: label + " description" })),
  channels: [
    { key: "in_app", label: "In-app", alert: false }, { key: "desktop", label: "Desktop", alert: true },
    { key: "push", label: "Mobile push", alert: true }, { key: "slack", label: "Slack", alert: true },
  ],
  scopes: [{ key: "all", label: "All" }, { key: "mine", label: "Only mine" }, { key: "off", label: "Off" }],
  presets: [
    { key: "everything", label: "Everything", description: "Every category, on every channel.", rules: Object.fromEntries(CATS.map(([k]) => [k, rule("all", ...ALL)])) },
    { key: "needs_me", label: "Only what needs me", description: "Yours only.", rules: NEEDS_ME },
    { key: "critical", label: "Nothing but critical", description: "Budget only.", rules: { ...Object.fromEntries(CATS.map(([k]) => [k, rule("off", "in_app")])), budget: rule("all", ...ALL) } },
  ],
  locks: [{ category: "budget", channel: "in_app", reason: "Budget hard stops always show in the app." }],
};

interface Srv { defaults: { rules: Rules; pause: { until: number | null } | null; quiet_hours: { start: string; end: string; tz: string } | null }; project: { rules: Record<string, Partial<Rule>>; muted: boolean } }
let srv: Srv;
interface Call { url: string; method: string; body?: Record<string, unknown> }
let calls: Call[];
let failNext: { status: number; detail?: string } | null;
let hold: Promise<void> | null;

function payload(): PrefsPayload {
  const p = {
    member: { id: "h1", alias: "kedar", member_role: "owner" },
    catalog: CATALOG,
    channels: {
      in_app: { available: true, reason: null }, desktop: { available: true, reason: null },
      push: { available: false, reason: "No phone is set up for push." }, slack: { available: false, reason: "Slack isn't connected." },
    },
    defaults: { ...srv.defaults, stored: true },
    project: { ...srv.project, stored: true },
    effective: { rules: {}, pause: srv.defaults.pause, quiet_hours: srv.defaults.quiet_hours, muted: srv.project.muted, paused_now: false },
    editable: true,
  } as unknown as PrefsPayload;
  p.effective.rules = effectiveRules(p);
  p.effective.paused_now = !!srv.defaults.pause && (srv.defaults.pause.until == null || srv.defaults.pause.until > Date.now() / 1000);
  return p;
}

const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [], requests: [],
};

function install() {
  srv = { defaults: { rules: JSON.parse(JSON.stringify(BUILTIN)), pause: null, quiet_hours: null }, project: { rules: {}, muted: false } };
  calls = [];
  failNext = null;
  hold = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    const u = new URL(url, "http://portal.test");
    if (u.pathname.startsWith("/api/containers/c1/notification-prefs")) {
      if (hold) await hold;
      if (method !== "GET" && failNext) {
        const f = failNext;
        failNext = null;
        return res({ detail: f.detail }, f.status);
      }
      if (method === "PUT" && u.pathname.endsWith("/defaults")) {
        for (const k of ["rules", "pause", "quiet_hours"] as const) if (body && k in body) (srv.defaults as Record<string, unknown>)[k] = k === "rules" ? { ...BUILTIN, ...body.rules } : body[k];
      } else if (method === "PUT") {
        if (body && "rules" in body) srv.project.rules = body.rules;
        if (body && "muted" in body) srv.project.muted = body.muted;
      }
      return res(payload());
    }
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (u.pathname === "/api/containers/c1") return res(SNAP);
    if (u.pathname === "/api/agents/h1/notifications") {
      const paused = !!srv.defaults.pause;
      return res({ notifications: [], next_before_ts: null, next_before_id: null, prefs_state: { paused, paused_until: srv.defaults.pause?.until ?? null, muted: srv.project.muted } });
    }
    if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
    if (url === "/api/prefs") return res({ prefs: null });
    return res({});
  }));
}

const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;
function asIdentity(id: Identity | null, trusted = true) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => trusted;
}

function renderSettings() {
  window.history.replaceState(null, "", window.location.pathname + "#tab=notifications");
  return render(<ToastProvider><SnapshotProvider><MemoryRouter><SettingsPage /></MemoryRouter></SnapshotProvider></ToastProvider>);
}

const puts = () => calls.filter((c) => c.method === "PUT");
const row = (key: string) => document.querySelector(`tr[data-cat="${key}"]`) as HTMLElement;
const sw = (name: string) => screen.getByRole("switch", { name }) as HTMLButtonElement;
async function ready() {
  await screen.findByRole("table", { name: "Notification rules" });
}

beforeEach(() => {
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
  localStorage.clear();
  resetIdentity();
  extensions.identity = undefined;
  extensions.identityTrusted = undefined;
  install();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  extensions.identity = ORIG_IDENTITY;
  extensions.identityTrusted = ORIG_TRUSTED;
});

/* ---------------------------------------------------------------- pure */

describe("notification prefs — pure helpers", () => {
  it("pauseFor: 1 hour, tomorrow 8:00 local, and until turned back on", () => {
    const now = new Date(2026, 8, 30, 14, 5, 0);
    expect(pauseFor("1h", now)).toEqual({ until: Math.round(now.getTime() / 1000) + 3600 });
    expect(pauseFor("tomorrow", now)).toEqual({ until: new Date(2026, 9, 1, 8, 0, 0).getTime() / 1000 });
    expect(pauseFor("forever", now)).toEqual({ until: null });
  });

  it("pauseText reads naturally and is null once a snooze expires", () => {
    const now = new Date(2026, 8, 30, 14, 0, 0);
    const s = now.getTime() / 1000;
    expect(pauseText(null, now)).toBeNull();
    expect(pauseText({ until: null }, now)).toBe("Paused until you turn them back on");
    expect(pauseText({ until: s + 3600 }, now)).toMatch(/^Paused until 3:00/);
    expect(pauseText({ until: new Date(2026, 9, 1, 8).getTime() / 1000 }, now)).toMatch(/^Paused until tomorrow, 8:00/);
    expect(pauseText({ until: s - 1 }, now)).toBeNull();
  });

  it("matchingPreset recognises a preset exactly, and nothing else", () => {
    expect(matchingPreset(CATALOG, NEEDS_ME)).toBe("needs_me");
    expect(matchingPreset(CATALOG, BUILTIN)).toBeNull();
  });

  it("effectiveRules layers the project over the defaults and keeps locks on", () => {
    install();
    srv.project.rules = { tasks: { scope: "off" }, budget: { channels: { in_app: false } as Rule["channels"] } };
    const eff = effectiveRules(payload());
    expect(eff.tasks).toEqual({ scope: "off", channels: BUILTIN.tasks.channels });
    expect(eff.budget.channels.in_app).toBe(true);
  });

  it("prefsErrText gives plain words, never a status code", () => {
    const e = (status: number, detail?: string) => Object.assign(new Error("/x → " + status + (detail ? ": " + detail : "")), { status, detail });
    expect(prefsErrText(e(422, "quiet hours need a start and an end that differ"))).toBe("quiet hours need a start and an end that differ");
    expect(prefsErrText(e(403))).toBe("you can only change your own notification settings");
    expect(prefsErrText(e(500))).toBe("Embodent hit an error — try again");
    expect(prefsErrText(new TypeError("Failed to fetch"))).toBe("Embodent couldn't be reached");
  });

  it("ncMenuItems: settings link, pause or resume, mute (checked), disabled for non-members", () => {
    const act = { pause: vi.fn(), resume: vi.fn(), mute: vi.fn() };
    const items = ncMenuItems(null, true, act).filter((i) => i !== "separator") as { label: string; href?: string; checked?: boolean; disabled?: boolean }[];
    expect(items.map((i) => i.label)).toEqual(["Notification settings", "Pause notifications…", "Mute this project"]);
    expect(items[0].href).toBe("/settings#tab=notifications");
    const paused = ncMenuItems({ paused: true, paused_until: null, muted: true }, true, act).filter((i) => i !== "separator") as { label: string; checked?: boolean }[];
    expect(paused[1].label).toBe("Resume notifications");
    expect(paused[2].checked).toBe(true);
    const ro = ncMenuItems(null, false, act).filter((i) => i !== "separator") as { disabled?: boolean }[];
    expect(ro.slice(1).every((i) => i.disabled)).toBe(true);
  });
});

/* ----------------------------------------------------------- the section */

describe("Settings › Notifications", () => {
  it("shows the safety rule, only the available channels, and the budget in-app lock", async () => {
    renderSettings();
    await ready();
    expect(screen.getByText(SAFETY_LINE)).toBeInTheDocument();
    const heads = within(screen.getByRole("table", { name: "Notification rules" })).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Category", "Notify me about", "In-app", "Desktop"]);
    expect(document.getElementById("nfHiddenChannels")).toHaveTextContent("Mobile push and Slack aren't set up here.");
    expect(within(row("budget")).getByLabelText(/Budget alerts — In-app: always on/)).toBeInTheDocument();
    expect(within(row("budget")).queryByRole("switch", { name: "Budget alerts — In-app" })).toBeNull();
    expect(sw("Task assignment & status changes — Desktop")).toHaveAttribute("aria-checked", "true");
  });

  it("a channel toggle flips at once, then saves this project's override", async () => {
    renderSettings();
    await ready();
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    const s = sw("Routine runs — Desktop");
    expect(s).toHaveAttribute("aria-checked", "false");
    fireEvent.click(s);
    expect(sw("Routine runs — Desktop")).toHaveAttribute("aria-checked", "true"); // optimistic
    await act(async () => { release(); hold = null; });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({
      url: "/api/containers/c1/notification-prefs",
      body: { rules: { routines: { scope: "all", channels: { in_app: true, desktop: true, push: false, slack: false } } }, actor_agent_id: "h1" },
    });
    // the per-project override indicator appears on that row
    expect(await within(row("routines")).findByText("This project")).toBeInTheDocument();
    expect(document.getElementById("nfOverrideSum")).toHaveTextContent("1 category overridden here");
  });

  it("scope select: Off dims the row's channels and saves", async () => {
    renderSettings();
    await ready();
    fireEvent.click(within(row("messages")).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(puts()[0]?.body?.rules).toEqual({ messages: { scope: "off", channels: BUILTIN.messages.channels } }));
    expect(row("messages")).toHaveClass("is-off");
    const ch = sw("Agent messages & mentions — In-app");
    expect(ch).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(ch);
    expect(puts()).toHaveLength(1); // disabled: no write
  });

  it("presets apply to this project, or to all projects in defaults mode", async () => {
    renderSettings();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Only what needs me" }));
    await waitFor(() => expect(puts()[0]).toMatchObject({ url: "/api/containers/c1/notification-prefs", body: { rules: NEEDS_ME } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Only what needs me" })).toHaveAttribute("aria-pressed", "true"));

    fireEvent.click(screen.getByRole("radio", { name: "All projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Nothing but critical" }));
    await waitFor(() => expect(puts()[1]?.url).toBe("/api/containers/c1/notification-prefs/defaults"));
    expect((puts()[1].body!.rules as Rules).budget.scope).toBe("all");
    expect((puts()[1].body!.rules as Rules).tasks.scope).toBe("off");
    // defaults mode shows the per-project override count
    expect(document.getElementById("nfOverrideSum")).toHaveTextContent("Orcha overrides 9");
  });

  it("an override can be reset to the default (per category and all at once)", async () => {
    srv.project.rules = { tasks: { scope: "off" }, verdikt: { scope: "off" } };
    renderSettings();
    await ready();
    fireEvent.click(within(row("tasks")).getByRole("button", { name: "Use your default for Task assignment & status changes" }));
    await waitFor(() => expect(puts()[0]?.body?.rules).toEqual({ verdikt: { scope: "off" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Use defaults" }));
    await waitFor(() => expect(puts()[1]?.body?.rules).toEqual({}));
    await waitFor(() => expect(document.getElementById("nfOverrideSum")).toBeNull());
  });

  it("pause for 1 hour, then resume", async () => {
    renderSettings();
    await ready();
    expect(document.getElementById("nfPauseD")).toHaveTextContent("Everything is on.");
    fireEvent.click(screen.getByRole("button", { name: /Pause…/ }));
    const before = Date.now() / 1000;
    fireEvent.click(await screen.findByRole("menuitem", { name: "For 1 hour" }));
    await waitFor(() => expect(puts()[0]?.url).toBe("/api/containers/c1/notification-prefs/defaults"));
    const until = (puts()[0].body!.pause as { until: number }).until;
    expect(until).toBeGreaterThanOrEqual(Math.floor(before) + 3599);
    expect(until).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 3601);
    expect(document.getElementById("nfPauseD")).toHaveTextContent(/^Paused until /);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(puts()[1]?.body).toEqual({ pause: null, actor_agent_id: "h1" }));
    await waitFor(() => expect(document.getElementById("nfPauseD")).toHaveTextContent("Everything is on."));
  });

  it("pause until I turn it back on", async () => {
    renderSettings();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Pause…/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Until I turn it back on" }));
    await waitFor(() => expect(puts()[0]?.body?.pause).toEqual({ until: null }));
    expect(document.getElementById("nfPauseD")).toHaveTextContent("Paused until you turn them back on");
  });

  it("mute this project", async () => {
    renderSettings();
    await ready();
    fireEvent.click(sw("Mute this project"));
    expect(sw("Mute this project")).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(puts()[0]?.body).toEqual({ muted: true, actor_agent_id: "h1" }));
  });

  it("quiet hours: turn on with a local-time default, then change the range and zone", async () => {
    renderSettings();
    await ready();
    fireEvent.click(sw("Quiet hours"));
    await waitFor(() => expect(puts()[0]?.body?.quiet_hours).toMatchObject({ start: "22:00", end: "07:00" }));
    const start = await screen.findByLabelText("Quiet hours start");
    fireEvent.change(start, { target: { value: "21:30" } });
    await waitFor(() => expect(puts()[1]?.body?.quiet_hours).toMatchObject({ start: "21:30", end: "07:00" }));
    // a start equal to the end is ignored (the server would refuse it)
    fireEvent.change(screen.getByLabelText("Quiet hours end"), { target: { value: "21:30" } });
    expect(puts()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Asia/Tokyo" } });
    await waitFor(() => expect(puts()[2]?.body?.quiet_hours).toEqual({ start: "21:30", end: "07:00", tz: "Asia/Tokyo" }));
    fireEvent.click(sw("Quiet hours"));
    await waitFor(() => expect(puts()[3]?.body?.quiet_hours).toBeNull());
    await waitFor(() => expect(screen.queryByLabelText("Quiet hours start")).toBeNull());
  });

  it("a failed save is undone and explained in plain words", async () => {
    renderSettings();
    await ready();
    failNext = { status: 500 };
    fireEvent.click(sw("Routine runs — Desktop"));
    expect(sw("Routine runs — Desktop")).toHaveAttribute("aria-checked", "true");
    const alert = await screen.findByText("Couldn't save — Embodent hit an error — try again. Your change was undone.", { selector: "#nfSaveErr" });
    expect(alert).toBeInTheDocument();
    expect(sw("Routine runs — Desktop")).toHaveAttribute("aria-checked", "false"); // reverted

    failNext = { status: 422, detail: "pause must end in the future" };
    fireEvent.click(screen.getByRole("button", { name: /Pause…/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "For 1 hour" }));
    await waitFor(() => expect(document.getElementById("nfSaveErr")).toHaveTextContent("Couldn't save — pause must end in the future. Your change was undone."));
    expect(document.getElementById("nfPauseD")).toHaveTextContent("Everything is on.");
    // the next good save clears the error line
    fireEvent.click(sw("Mute this project"));
    await waitFor(() => expect(document.getElementById("nfSaveErr")).toBeNull());
  });

  it("a load failure says so and offers Retry", async () => {
    const orig = global.fetch;
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("notification-prefs") && first) {
        first = false;
        return { ok: false, status: 403, json: async () => ({ detail: "you can only change your own notification settings" }) } as unknown as Response;
      }
      return (orig as typeof fetch)(input, init);
    }));
    renderSettings();
    expect(await screen.findByText(/Couldn't load your notification settings — you can only change your own notification settings/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await ready();
  });

  it("owner and viewer both edit their OWN settings (the actor is themselves)", async () => {
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderSettings();
    await ready();
    fireEvent.click(sw("Mute this project"));
    await waitFor(() => expect(puts()[0]?.body).toEqual({ muted: true, actor_agent_id: "h1" }));
    cleanup();
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
    renderSettings();
    await ready();
    fireEvent.click(sw("Mute this project"));
    await waitFor(() => expect(puts()[0]?.body).toEqual({ muted: true, actor_agent_id: "h1" }));
  });

  it("a signed-in non-member sees a plain note and nothing is fetched or written", async () => {
    asIdentity(null, true);
    renderSettings();
    expect(await screen.findByText("Notification settings belong to members of this project.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("notification-prefs"))).toBe(false);
  });
});

/* ------------------------------------------------------------ the bell menu */

describe("Bell › notification options", () => {
  function mountHome() {
    return render(<ToastProvider><SnapshotProvider><HashRouter><HomePage /></HashRouter></SnapshotProvider></ToastProvider>);
  }
  async function openMenu() {
    mountHome();
    await waitFor(() => expect(document.getElementById("attnPill")).toBeTruthy());
    fireEvent.click(document.getElementById("attnPill")!);
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/agents/h1/notifications"))).toBe(true));
    fireEvent.click(document.getElementById("ncMore")!);
    return screen.findByRole("menu", { name: "Notification options" });
  }

  it("offers settings, pause and mute", async () => {
    const menu = await openMenu();
    const names = Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((i) => i.textContent);
    expect(names).toEqual(["Notification settings", "Pause notifications…", "Mute this project"]);
    expect(within(menu).getByRole("menuitem", { name: "Notification settings" })).toHaveAttribute("href", "/settings#tab=notifications");
  });

  it("Pause notifications… → Until tomorrow writes the pause, then the panel says so and the bell goes quiet", async () => {
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pause notifications…" }));
    const sub = await screen.findByRole("menu", { name: "Pause notifications" });
    fireEvent.click(within(sub).getByRole("menuitem", { name: "Until tomorrow" }));
    await waitFor(() => expect(puts()[0]?.url).toBe("/api/containers/c1/notification-prefs/defaults"));
    const until = (puts()[0].body!.pause as { until: number }).until;
    expect(new Date(until * 1000).getHours()).toBe(8);
    await waitFor(() => expect(document.getElementById("ncPaused")).toHaveTextContent(/Paused until tomorrow, 8:00/));
    await waitFor(() => expect(document.getElementById("attnPill")!.getAttribute("aria-label")).toMatch(/notifications paused/));
    fireEvent.click(within(document.getElementById("ncPaused")!).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(puts()[1]?.body).toEqual({ pause: null, actor_agent_id: "h1" }));
  });

  it("Mute this project toggles the project override", async () => {
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Mute this project" }));
    await waitFor(() => expect(puts()[0]).toMatchObject({ url: "/api/containers/c1/notification-prefs", body: { muted: true, actor_agent_id: "h1" } }));
    await waitFor(() => expect(document.getElementById("ncPaused")).toHaveTextContent("This project is muted"));
  });
});
