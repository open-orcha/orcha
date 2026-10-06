/** Field eligibility, insertion at the cursor, and undo (dictation/target.ts). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertAt, isDictationTarget, replaceInserted, shapeInsertion, targetLabel, undoInsert } from "./target";

const html = (s: string) => {
  const d = document.createElement("div");
  d.innerHTML = s;
  document.body.appendChild(d);
  return d.firstElementChild as HTMLElement;
};

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("isDictationTarget", () => {
  it.each([
    ["textarea", "<textarea></textarea>"],
    ["plain input", "<input />"],
    ["text input", '<input type="text" aria-label="Title" />'],
    ["search input", '<input type="search" />'],
    ["contenteditable", '<div contenteditable="true"></div>'],
    ["forced on", '<input aria-label="API key" data-dictation="on" />'],
  ])("%s gets a mic", (_n, markup) => {
    expect(isDictationTarget(html(markup))).toBe(true);
  });

  it.each([
    ["password", '<input type="password" />'],
    ["number", '<input type="number" />'],
    ["url", '<input type="url" />'],
    ["email", '<input type="email" />'],
    ["tel", '<input type="tel" />'],
    ["date", '<input type="date" />'],
    ["time", '<input type="time" />'],
    ["checkbox", '<input type="checkbox" />'],
    ["file", '<input type="file" />'],
    ["decimal inputMode", '<input inputmode="decimal" />'],
    ["API key by label", '<input aria-label="Anthropic API key" />'],
    ["token by placeholder", '<input placeholder="Paste your GitHub token" />'],
    ["secret by name", '<input name="client_secret" />'],
    ["PAT", '<input aria-label="PAT" />'],
    ["password autocomplete", '<input autocomplete="current-password" />'],
    ["URL field by placeholder", '<input placeholder="http://localhost:3100" />'],
    ["cron", '<input aria-label="Cron expression" />'],
    ["readonly", "<textarea readonly></textarea>"],
    ["disabled", "<textarea disabled></textarea>"],
    ["opt-out", '<textarea data-dictation="off"></textarea>'],
    ["opt-out ancestor", '<div data-dictation="off"><textarea></textarea></div>'],
    ["a div", "<div></div>"],
    ["a button", "<button>x</button>"],
  ])("%s gets no mic", (_n, markup) => {
    const el = html(markup);
    const target = el.matches("input,textarea") ? el : el.querySelector("input,textarea") || el;
    expect(isDictationTarget(target)).toBe(false);
  });

  it("code editors and terminals are skipped", () => {
    const cm = html('<div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div>');
    expect(isDictationTarget(cm.querySelector(".cm-content"))).toBe(false);
  });

  it("names the field from aria-label, a <label for>, or the placeholder", () => {
    expect(targetLabel(html('<textarea aria-label="Description"></textarea>') as HTMLTextAreaElement)).toBe("Description");
    html('<label for="x1">Done when</label>');
    expect(targetLabel(html('<textarea id="x1"></textarea>') as HTMLTextAreaElement)).toBe("Done when");
    expect(targetLabel(html('<input placeholder="Search lessons" />') as HTMLInputElement)).toBe("Search lessons");
  });
});

describe("shapeInsertion", () => {
  it("capitalises at the start and after a sentence end", () => {
    expect(shapeInsertion("", "", "hello there", false)).toBe("Hello there");
    expect(shapeInsertion("Done.", "", "next one", false)).toBe(" Next one");
  });
  it("spaces off a preceding word but not before punctuation", () => {
    expect(shapeInsertion("Fix the", "", "login bug", false)).toBe(" login bug");
    expect(shapeInsertion("Fix the bug", "", ", then ship", false)).toBe(", then ship");
    expect(shapeInsertion("(", "", "see notes", false)).toBe("see notes");
  });
  it("pads before a following word", () => {
    expect(shapeInsertion("Fix ", "bug", "the login", false)).toBe("the login ");
  });
  it("collapses newlines in single-line fields", () => {
    expect(shapeInsertion("", "", "one\ntwo\n\nthree", true)).toBe("One two three");
    expect(shapeInsertion("", "", "- one\n- two", false)).toBe("- one\n- two");
  });
});

describe("insertAt / undo", () => {
  function ta(value: string, caret: number, end = caret) {
    const el = html("<textarea></textarea>") as HTMLTextAreaElement;
    el.value = value;
    el.setSelectionRange(caret, end);
    return el;
  }

  it("inserts at the saved cursor, fires input (React onChange), and moves the caret", () => {
    const el = ta("Fix  today", 4);
    const onInput = vi.fn();
    el.addEventListener("input", onInput);
    const rec = insertAt(el, "the login bug", { start: 4, end: 4 })!;
    expect(el.value).toBe("Fix the login bug today");
    expect(onInput).toHaveBeenCalled();
    expect(el.selectionStart).toBe(rec.end);
    undoInsert(rec);
    expect(el.value).toBe("Fix  today");
  });

  it("replaces a selection", () => {
    const el = ta("Ship it on Monday", 11, 17);
    insertAt(el, "friday", { start: 11, end: 17 });
    expect(el.value).toBe("Ship it on friday");
  });

  it("uses the browser's native insertText (native undo stack) when available", () => {
    const el = ta("", 0);
    const exec = vi.fn((_cmd: string, _ui: boolean, text: string) => {
      el.setRangeText(text, el.selectionStart!, el.selectionEnd!, "end");
      return true;
    });
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    const rec = insertAt(el, "hello", { start: 0, end: 0 })!;
    expect(exec).toHaveBeenCalledWith("insertText", false, "Hello");
    expect(rec.native).toBe(true);
    expect(el.value).toBe("Hello");
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it("replaceInserted swaps only the dictated span, and refuses if the user edited it", () => {
    const el = ta("A: ", 3);
    const rec = insertAt(el, "um fix it", { start: 3, end: 3 })!;
    expect(el.value).toBe("A: um fix it");
    const next = replaceInserted(rec, "Fix it.")!;
    expect(el.value).toBe("A: Fix it.");
    el.value = "A: changed by hand";
    expect(replaceInserted(next, "nope")).toBeNull();
    expect(el.value).toBe("A: changed by hand");
  });

  it("single-line inputs never get newlines", () => {
    const el = html("<input />") as HTMLInputElement;
    insertAt(el, "fix\nthe bug", { start: 0, end: 0 });
    expect(el.value).toBe("Fix the bug");
  });
});
