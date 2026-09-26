/**
 * RepoBadge — a local binding renders the workspace name + a "Local" chip
 * and never a github.com link (Orcha Cloud local run, Addendum 2); a normal
 * binding renders the owner/name text, optionally linked.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RepoBadge } from "./RepoBadge";

afterEach(() => { cleanup(); });

describe("RepoBadge", () => {
  it("renders nothing for an unbound repo", () => {
    const { container } = render(<RepoBadge repo={null} />);
    expect(container.textContent).toBe("");
  });

  it("local binding: workspace name + Local chip, no anchor at all", () => {
    render(<RepoBadge repo="local" workspaceName="quantal-ehr" />);
    expect(screen.getByText("quantal-ehr")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(document.querySelector("a")).toBeNull();
  });

  it("local binding with no workspace name falls back to a neutral label", () => {
    render(<RepoBadge repo="local" />);
    expect(screen.getByText("This machine")).toBeInTheDocument();
  });

  it("GitHub binding renders the owner/name as plain text by default (no link)", () => {
    render(<RepoBadge repo="acme/app" />);
    expect(screen.getByText("acme/app")).toBeInTheDocument();
    expect(document.querySelector("a")).toBeNull();
  });

  it("GitHub binding with link=true renders a github.com anchor", () => {
    render(<RepoBadge repo="acme/app" link />);
    const a = document.querySelector("a")!;
    expect(a).not.toBeNull();
    expect(a.getAttribute("href")).toBe("https://github.com/acme/app");
    expect(a.textContent).toContain("acme/app");
  });

  it("never builds a github.com/local link even when link=true", () => {
    render(<RepoBadge repo="local" workspaceName="quantal-ehr" link />);
    expect(document.querySelector("a")).toBeNull();
  });

  // local-binding + GitHub-origin fall-through (simultaneous local binding +
  // GitHub hub): the Local badge can ALSO show the detected origin repo as a
  // muted suffix — both truths visible at once.
  it("local binding + originRepo: shows the Local chip AND a muted origin suffix", () => {
    render(<RepoBadge repo="local" workspaceName="quantal-ehr" originRepo="acme/site" />);
    expect(screen.getByText("quantal-ehr")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("· acme/site")).toBeInTheDocument();
  });

  it("local binding with no originRepo shows no suffix at all", () => {
    render(<RepoBadge repo="local" workspaceName="quantal-ehr" />);
    expect(document.querySelector(".repo-badge-origin")).toBeNull();
  });

  it("originRepo is ignored on a non-local (GitHub) binding", () => {
    render(<RepoBadge repo="acme/app" originRepo="acme/site" />);
    expect(document.querySelector(".repo-badge-origin")).toBeNull();
    expect(screen.getByText("acme/app")).toBeInTheDocument();
  });
});
