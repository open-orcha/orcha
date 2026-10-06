import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { ProjectIconPicker } from "./EmojiPicker";
import * as icons from "../../cloud/projects/projectIcons";

function stubPut(status: number | "offline") {
  global.fetch = vi.fn(async () => {
    if (status === "offline") throw new TypeError("Failed to fetch");
    return { ok: status < 400, status, json: async () => ({ icon: { kind: "emoji", value: "🦊" } }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

function Harness({ onClose }: { onClose: () => void }) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={anchor}>anchor</button>
      <ProjectIconPicker cid="c1" name="orcha-web" anchor={anchor} open onClose={onClose} />
    </>
  );
}

const pickFirstEmoji = () => {
  const cell = document.querySelector<HTMLElement>("[data-cell]");
  expect(cell).not.toBeNull();
  fireEvent.click(cell!);
};

afterEach(() => { cleanup(); localStorage.clear(); icons._resetProjectIconsForTests(); vi.restoreAllMocks(); });

describe("ProjectIconPicker — a pick that isn't saved is never a silent revert", () => {
  it("403: keeps the picker open, says why, and restores the previous icon", async () => {
    stubPut(403);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    pickFirstEmoji();
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to change this project's icon.");
    expect(onClose).not.toHaveBeenCalled();
    expect(icons.projectIcons().c1).toBeUndefined();
  });

  it("404 from an older portal explains that shared icons aren't supported yet", async () => {
    stubPut(404);
    render(<Harness onClose={vi.fn()} />);
    pickFirstEmoji();
    expect(await screen.findByRole("alert")).toHaveTextContent("doesn't support shared icons yet");
  });

  it("unreachable: restores the previous icon (no pick left on screen that wasn't stored)", async () => {
    stubPut("offline");
    render(<Harness onClose={vi.fn()} />);
    pickFirstEmoji();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Embodent");
    expect(icons.projectIcons().c1).toBeUndefined();
  });

  it("success: closes the picker and keeps the stored icon", async () => {
    stubPut(200);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    pickFirstEmoji();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(icons.projectIcons().c1).toEqual({ kind: "emoji", value: "🦊" });
  });
});
