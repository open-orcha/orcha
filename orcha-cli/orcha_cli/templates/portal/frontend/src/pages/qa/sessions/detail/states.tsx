import type { CSSProperties, ReactNode } from "react";
import { Ban, Clock, OctagonAlert } from "../../map/kit/icons";
import type { Exploration } from "../explorations";
import { queuedWords, type QueuePlace } from "./model";

/** Queued: calm, with the agent it waits for and its place in
 * line when the queue knows it. */
export function QueuedFace({ queue }: { queue: QueuePlace }) {
  const words = queuedWords(queue);
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-panel px-4 py-12 text-center" data-face="queued">
      <div className="relative flex size-16 items-center justify-center" aria-hidden>
        <span className="v-ripple absolute inset-0 rounded-full border border-border-strong" />
        <span className="v-ripple absolute inset-0 rounded-full border border-border-strong" style={{ "--d": "1.2s" } as CSSProperties} />
        <span className="v-float flex size-10 items-center justify-center rounded-full border border-border bg-panel-2">
          <Clock className="size-4.5 text-fg-2" strokeWidth={1.75} />
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-fg">{words.title}</p>
        <p className="max-w-sm text-sm text-muted" data-queue-position={queue.position ?? undefined} data-queue-waiting={queue.waiting ?? undefined}>
          {words.body}
        </p>
      </div>
    </div>
  );
}

/** Failed or stopped: what happened. Run again sits in the title's actions, as on every job page. */
export function EndedFace({ exploration, children }: { exploration: Exploration; children?: ReactNode }) {
  const failed = exploration.status === "failed";
  return (
    <div className="flex flex-col gap-5" data-face="ended" data-ended={exploration.status}>
      <div role={failed ? "alert" : "status"} className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
        <div className="flex items-start gap-2.5">
          {failed ? (
            <OctagonAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} />
          ) : (
            <Ban aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={1.75} />
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium text-fg">{failed ? "This exploration failed" : "This exploration was stopped"}</p>
            {exploration.error ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-fg-2" data-ended-error>
                {exploration.error}
              </pre>
            ) : (
              <p className="text-sm text-muted">{failed ? "No error was recorded." : "It stopped before it finished."}</p>
            )}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
