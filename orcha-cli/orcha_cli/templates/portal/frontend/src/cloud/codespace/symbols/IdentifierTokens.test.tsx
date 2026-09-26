/**
 * IdentifierTokens — renders a highlighted line's tokens like the shared
 * TokenSpans, but "plain" tokens that look like identifiers become clickable
 * — offering "Find symbol '<word>'" (workspace symbol search, never "go to
 * definition") via onIdentifierClick.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Token } from "../../github/browse/highlight";
import { IdentifierTokens } from "./IdentifierTokens";

describe("IdentifierTokens", () => {
  afterEach(() => cleanup());

  it("renders plain identifier-shaped tokens as clickable", () => {
    const tokens: Token[] = [{ kind: "plain", text: "fooBar" }];
    const onClick = vi.fn();
    render(<IdentifierTokens tokens={tokens} onIdentifierClick={onClick} />);
    const el = screen.getByText("fooBar");
    expect(el).toHaveClass("cs-ident-tok");
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledWith("fooBar");
  });

  it("does not make keyword/string/number/comment tokens clickable", () => {
    const tokens: Token[] = [
      { kind: "keyword", text: "const" },
      { kind: "string", text: '"hi"' },
      { kind: "number", text: "42" },
      { kind: "comment", text: "// note" },
    ];
    render(<IdentifierTokens tokens={tokens} onIdentifierClick={vi.fn()} />);
    expect(screen.getByText("const")).not.toHaveClass("cs-ident-tok");
    expect(screen.getByText('"hi"')).not.toHaveClass("cs-ident-tok");
    expect(screen.getByText("42")).not.toHaveClass("cs-ident-tok");
    expect(screen.getByText("// note")).not.toHaveClass("cs-ident-tok");
  });

  it("does not make punctuation/whitespace plain tokens clickable", () => {
    const tokens: Token[] = [{ kind: "plain", text: " = " }];
    const { container } = render(<IdentifierTokens tokens={tokens} onIdentifierClick={vi.fn()} />);
    expect(container.querySelector(".cs-ident-tok")).toBeNull();
    expect(container.textContent).toBe(" = ");
  });

  it("renders an empty line as a single space, matching TokenSpans", () => {
    const { container } = render(<IdentifierTokens tokens={[]} onIdentifierClick={vi.fn()} />);
    expect(container.textContent).toBe(" ");
  });
});
