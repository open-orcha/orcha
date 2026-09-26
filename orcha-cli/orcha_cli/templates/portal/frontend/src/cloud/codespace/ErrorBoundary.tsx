/**
 * Pane-scoped error boundary — Code Space's black-screen bug (a render throw
 * anywhere in the tree/content/rail pane unmounted the ENTIRE page, since
 * nothing in this codebase catches render errors: see ThreadView.tsx's fixed
 * detail.thread crash for the concrete case that surfaced it) showed one pane
 * can misbehave without the whole three-pane shell going dark.
 *
 * React only exposes error-boundary semantics through a class component
 * (getDerivedStateFromError / componentDidCatch — no hook equivalent) — this
 * is intentionally the one class component in codespace/**, everything else
 * stays function components per house convention.
 *
 * Each of the three CodeSpacePage panes gets its OWN boundary instance (keyed
 * so a file/tab change remounts a previously-tripped boundary — see
 * CodeSpacePage.tsx's key wiring): one pane crashing leaves the other two
 * fully interactive, and the compact fallback offers a "reload pane" reset
 * that clears the boundary's error state without a full-page reload.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  // Short label identifying which pane tripped, e.g. "tree" / "content" /
  // "rail" — rendered in the fallback so a bug report says exactly where.
  label: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`Code Space ${this.props.label} pane crashed:`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="cs-pane-crash" role="alert">
          <div className="cs-pane-crash-msg">something broke here — reload pane</div>
          <button type="button" className="btn ghost sm" onClick={this.reset}>
            Reload {this.props.label} pane
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
