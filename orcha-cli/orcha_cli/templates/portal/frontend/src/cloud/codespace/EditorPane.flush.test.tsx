/**
 * EditorPane (parity C-13, brief "preserve unsaved drafts across
 * navigation"): an autosave still inside its 800 ms debounce when the pane
 * unmounts (file switch / leaving edit mode) is flushed as the same
 * conflict-checked PUT, not silently dropped.
 */
import { cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorPane } from "./EditorPane";

describe("EditorPane flush-on-unmount", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("PUTs the pending edit with its base hash when unmounted mid-debounce", async () => {
    const puts: { url: string; body: unknown }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") puts.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => ({ ok: true, content_hash: "h2" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { container, unmount } = render(
      <EditorPane cid="c1" path="notes.txt" initialContent="hello" contentHash="h1" onDirty={() => {}} />,
    );
    const dom = container.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(dom)!;
    view.dispatch({ changes: { from: 5, insert: " world" } });
    expect(puts).toHaveLength(0); // still inside the debounce window
    unmount();
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe("/api/containers/c1/code/worktree/file");
    expect(puts[0].body).toEqual({ path: "notes.txt", content: "hello world", base_hash: "h1" });
  });

  it("a read-only pane never writes", () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { unmount } = render(
      <EditorPane cid="c1" path="big.ts" initialContent="x" contentHash={null} readOnly onDirty={() => {}} />,
    );
    unmount();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
