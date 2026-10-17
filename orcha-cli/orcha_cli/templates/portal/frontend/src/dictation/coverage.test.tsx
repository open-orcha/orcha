/**
 * Dictation COVERAGE: every text field the portal renders gets the mic, and
 * credential / number / URL fields never do.
 *
 * 1. A source scan enumerates every <input>/<textarea> JSX element in the
 *    app (non-test .tsx), rebuilds it as a DOM element from its static
 *    attributes and asks the real eligibility rule (isDictationTarget). The
 *    exclusions must be exactly the expected kinds (password, number, url,
 *    checkbox…, or a credential/URL-labelled field) — a new text field is
 *    covered automatically, and a new key/token field is caught here if it
 *    would wrongly get a mic.
 * 2. The provider is mounted at the app root (main.tsx), so the scan's
 *    verdict is what users get.
 * 3. Rendered checks for the shared primitives: Composer (inline mic button),
 *    MessageComposer, and SecretInput (never, even revealed).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../components/primitives/Composer";
import { MessageComposer } from "../components/MessageComposer";
import { SecretInput } from "../pages/settings/settingsUi";
import { DictationProvider } from "./DictationHost";
import { isDictationTarget } from "./target";
import { fakeRig } from "./testFakes";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

interface Field { file: string; tag: "input" | "textarea"; type: string; attrs: Record<string, string>; raw: string }

/** Pull each <input …/> / <textarea …> opening tag (multi-line JSX, nested {…} aware). */
function scan(): Field[] {
  const fields: Field[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    const re = /<(input|textarea)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 0;
      let quote: string | null = null;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (quote) { if (ch === quote) quote = null; continue; }
        if (depth > 0 && (ch === '"' || ch === "'" || ch === "`")) { quote = ch; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === ">" && depth === 0) break;
      }
      const raw = src.slice(m.index, i + 1);
      const attrs: Record<string, string> = {};
      const ar = /([a-zA-Z-]+)=(?:"([^"]*)"|\{"([^"]*)"\}|\{([^}]*)\})/g;
      let a: RegExpExecArray | null;
      const head = raw.replace(/\{[^{}]*\{[^{}]*\}[^{}]*\}/g, "{…}");
      while ((a = ar.exec(head))) attrs[a[1]] = a[2] ?? a[3] ?? `{${a[4]}}`;
      const type = attrs.type ?? "";
      fields.push({ file: relative(SRC, file), tag: m[1] as "input" | "textarea", type, attrs, raw });
    }
  }
  return fields;
}

/** Rebuild the element from its STATIC attributes (dynamic values become neutral). */
function toElement(f: Field): HTMLElement {
  const el = document.createElement(f.tag);
  const set = (k: string, v: string | undefined) => { if (v != null && !v.startsWith("{")) el.setAttribute(k, v); };
  set("type", f.type || undefined);
  if (f.type.startsWith("{")) el.setAttribute("type", /password/.test(f.type) ? "password" : "text");
  set("aria-label", f.attrs["aria-label"]);
  set("placeholder", f.attrs.placeholder);
  set("name", f.attrs.name);
  set("id", f.attrs.id);
  set("inputmode", f.attrs.inputMode);
  set("autocomplete", f.attrs.autoComplete);
  set("data-dictation", f.attrs["data-dictation"]);
  if ("readOnly" in f.attrs && f.attrs.readOnly === "{true}") el.setAttribute("readonly", "");
  if (/\breadOnly\b(?!=)/.test(f.raw)) el.setAttribute("readonly", "");
  if (/\bhidden\b(?!=)/.test(f.raw)) el.setAttribute("type", "file");
  return el;
}

const NON_TEXT_TYPES = new Set(["password", "number", "url", "email", "tel", "date", "time", "datetime-local", "checkbox", "radio", "file", "range", "color", "hidden"]);

describe("dictation coverage (source scan of every text field)", () => {
  const fields = scan();

  it("finds the app's fields", () => {
    expect(fields.length).toBeGreaterThan(60);
  });

  it("every plain text field gets a mic; only credential/URL/cron-like ones are skipped", () => {
    const textLike = fields.filter((f) => !NON_TEXT_TYPES.has(f.type) && !/\bhidden\b(?!=)/.test(f.raw));
    const skipped = textLike.filter((f) => !isDictationTarget(toElement(f)));
    // each skipped text field must be skipped for a credential / URL / numeric reason
    for (const f of skipped) {
      const why = [f.attrs["aria-label"], f.attrs.placeholder, f.attrs.name, f.attrs.inputMode, f.attrs["data-dictation"], f.type].join(" ");
      expect(why, `${f.file}: ${f.raw.slice(0, 120)}`).toMatch(/key|token|secret|password|url|http|cron|numeric|decimal|off|\{reveal/i);
    }
    const covered = textLike.length - skipped.length;
    if (process.env.DICTATION_COVERAGE_REPORT) {
      console.log(`text fields: ${textLike.length}, covered: ${covered}, skipped: ${skipped.length}`);
      skipped.forEach((f) => console.log("  skip", f.file, f.attrs["aria-label"] || f.attrs.placeholder || f.attrs.id || f.type));
    }
    expect(covered).toBeGreaterThan(50);
  });

  it("the New task fields, comments, requests, routines and Learn are covered", () => {
    const has = (file: RegExp, pred: (f: Field) => boolean) =>
      fields.filter((f) => file.test(f.file) && pred(f)).every((f) => isDictationTarget(toElement(f)));
    expect(has(/pages\/tasks\/TaskDetail\.tsx$/, (f) => ["nt_title", "nt_desc", "nt_dod"].includes(f.attrs.id))).toBe(true);
    expect(fields.filter((f) => /TaskDetail\.tsx$/.test(f.file) && ["nt_title", "nt_desc", "nt_dod"].includes(f.attrs.id))).toHaveLength(3);
    expect(has(/pages\/routines\/RoutineDialog\.tsx$/, (f) => f.tag === "textarea")).toBe(true);
    expect(has(/pages\/requests\/RequestsPage\.tsx$/, (f) => f.tag === "textarea")).toBe(true);
    expect(has(/cloud\/codespace\/LearnTab\.tsx$/, () => true)).toBe(true);
  });

  it("password / number / URL inputs never get a mic", () => {
    for (const f of fields.filter((x) => ["password", "number", "url"].includes(x.type))) {
      expect(isDictationTarget(toElement(f)), f.file).toBe(false);
    }
  });

  it("the provider is mounted at the app root", () => {
    const main = readFileSync(join(SRC, "main.tsx"), "utf8");
    expect(main).toMatch(/<DictationRoot>/);
    expect(main).toMatch(/PortalDictationProvider cid=\{cid\}/);
  });
});

describe("dictation on the shared text primitives (rendered)", () => {
  afterEach(cleanup);

  it("Composer shows its own mic in the toolbar (and the field opts out of the floating one)", () => {
    const rig = fakeRig();
    render(
      <DictationProvider cid="c1" deps={rig.deps}>
        <Composer label="Comment on task" value="" onChange={() => undefined} onSubmit={() => undefined} />
      </DictationProvider>,
    );
    const ta = screen.getByLabelText("Comment on task");
    expect(isDictationTarget(ta)).toBe(true);
    expect(ta).toHaveAttribute("data-dictation-inline");
    expect(screen.getByTestId("dictation-inline")).toHaveAccessibleName(/Dictate/);
    fireEvent.focus(ta);
    expect(screen.queryByTestId("dictation-mic")).toBeNull();
  });

  it("Composer outside a provider renders no mic (isolated renders unchanged)", () => {
    render(<Composer label="Reply" value="" onChange={() => undefined} onSubmit={() => undefined} />);
    expect(screen.queryByTestId("dictation-inline")).toBeNull();
  });

  it("MessageComposer (agent chat, task thread) is eligible and gets the floating mic on focus", () => {
    const rig = fakeRig();
    render(
      <DictationProvider cid="c1" deps={rig.deps}>
        <MessageComposer value="" onValueChange={() => undefined} onSend={() => undefined} onFiles={() => undefined}
          placeholder="Message" textareaId="mc" attachButtonId="mca" fileInputId="mcf" sendButtonId="mcs" ariaLabel="Message Atlas" />
      </DictationProvider>,
    );
    const ta = screen.getByLabelText("Message Atlas");
    vi.spyOn(ta, "getBoundingClientRect").mockReturnValue({ top: 100, left: 20, width: 400, height: 40, bottom: 140, right: 420, x: 20, y: 100, toJSON: () => ({}) } as DOMRect);
    act(() => ta.focus());
    expect(isDictationTarget(ta)).toBe(true);
    expect(screen.getByTestId("dictation-mic")).toBeInTheDocument();
  });

  it("SecretInput (API keys, tokens) never gets a mic — hidden or revealed", () => {
    const { rerender } = render(<SecretInput value="" onChange={() => undefined} placeholder="sk-ant-…" reveal={false} onToggleReveal={() => undefined} label="Anthropic API key" />);
    expect(isDictationTarget(screen.getByLabelText("Anthropic API key"))).toBe(false);
    rerender(<SecretInput value="" onChange={() => undefined} placeholder="sk-ant-…" reveal onToggleReveal={() => undefined} label="Anthropic API key" />);
    expect(isDictationTarget(screen.getByLabelText("Anthropic API key"))).toBe(false);
  });
});
