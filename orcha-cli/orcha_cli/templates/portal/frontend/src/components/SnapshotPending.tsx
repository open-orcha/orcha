/**
 * What a page shows while it has NO snapshot yet. Disconnected ≠ loading ≠
 * empty (brief §3/§7): while the first load is still in progress this is a
 * skeleton; once the first load has FAILED (error / offline) it is an honest
 * "project data unavailable" state with Retry — never an endless "Loading…".
 */
import { useSnapshot } from "../state/SnapshotProvider";
import { Button } from "./primitives/Button";
import { EmptyState, Skeleton } from "./primitives/Layout";

export function SnapshotPending({ lines = 6, label, what = "project data" }: { lines?: number; label: string; what?: string }) {
  const { error, errorKind, connection, refresh } = useSnapshot();
  // A 403/404 is an ANSWER from a reachable backend, not an outage: say what it
  // means and offer no Retry (it can't help; the shell bar links All projects).
  if (errorKind === "forbidden") {
    return (
      <EmptyState
        icon="shield"
        title="You're not a member of this project"
        body="Ask an owner of this project for an invite."
      />
    );
  }
  if (errorKind === "not_found") {
    return (
      <EmptyState
        icon="alert"
        title="Project not found"
        body="It may have been removed, or the link is wrong."
      />
    );
  }
  if (error || connection === "offline") {
    // neutral, not an alarm: the offline bar above already carries the error
    // detail (and the API path) behind its Details disclosure
    return (
      <EmptyState
        icon="alert"
        title={`Couldn't load ${what}`}
        body="The Embodent backend did not answer. Nothing is shown rather than guesses."
        action={<Button variant="secondary" onClick={() => void refresh()}>Retry</Button>}
      />
    );
  }
  return <Skeleton lines={lines} label={label} />;
}
