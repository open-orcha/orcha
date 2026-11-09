import { Check, LoaderCircle, X } from "../../map/kit/icons";
import { describeCommand } from "./recording";
import type { InputRow } from "./recording-inputs";

/**
 * The person's inputs in order, each with whether the device took it and what it said. An
 * input shows the moment it is made (`sending`), before the server has stored it.
 */
export function RecordingCommands({ rows }: { rows: readonly InputRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">Nothing yet. Click the screen to tap it.</p>;
  }
  return (
    <ol className="flex flex-col gap-1" data-recording-commands>
      {rows.map((c) => (
        <li key={c.key} className="flex items-start gap-2 text-sm" data-command-status={c.status}>
          <span className="w-5 shrink-0 text-right font-mono text-xs tabular text-muted">{c.seq != null ? `${c.seq}.` : "·"}</span>
          {c.status === "pending" || c.status === "sent" || c.status === "sending" ? (
            <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted" aria-label={c.status} />
          ) : c.status === "done" ? (
            <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-label="done" />
          ) : (
            <X className="mt-0.5 size-3.5 shrink-0 text-sev-blocker" aria-label="failed" />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-fg">{describeCommand(c.kind, c.args)}</span>
            {c.result ? (
              <span className={c.status === "failed" ? "text-xs text-danger" : "truncate text-xs text-muted"} title={c.result}>
                {c.result}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
