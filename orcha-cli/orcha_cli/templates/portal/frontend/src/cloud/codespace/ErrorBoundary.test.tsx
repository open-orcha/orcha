/**
 * ErrorBoundary — pane-scoped render-error containment (Learn-tab black-
 * screen bug fix): a throw inside `children` renders the compact fallback
 * instead of unmounting whatever's OUTSIDE the boundary, and the "reload
 * pane" button clears the tripped state so the pane can try again.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary label="content">
        <div>all good</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("catches a render throw and shows the compact fallback, labeled by pane", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <div data-testid="sibling">still here</div>
        <ErrorBoundary label="content">
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText(/something broke here — reload pane/i)).toBeInTheDocument();
    expect(screen.getByText(/reload content pane/i)).toBeInTheDocument();
    // the crash is CONTAINED — the sibling outside the boundary is untouched.
    expect(screen.getByTestId("sibling")).toBeInTheDocument();
  });

  it("a sibling boundary (e.g. the rail) keeps working when a DIFFERENT pane's boundary trips", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <ErrorBoundary label="tree">
          <div>tree pane content</div>
        </ErrorBoundary>
        <ErrorBoundary label="content">
          <Boom />
        </ErrorBoundary>
        <ErrorBoundary label="rail">
          <div>rail pane content</div>
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("tree pane content")).toBeInTheDocument();
    expect(screen.getByText("rail pane content")).toBeInTheDocument();
    expect(screen.getByText(/reload content pane/i)).toBeInTheDocument();
  });

  it("'reload pane' clears the tripped state and re-renders children", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("still broken");
      return <div>recovered</div>;
    }
    render(
      <ErrorBoundary label="content">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/reload content pane/i)).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByText(/reload content pane/i));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
