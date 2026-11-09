import { useState } from "react";
import { ArrowUpRight, Sparkles } from "../../map/kit/icons";
import { Dialog } from "../../map/kit";
import { fmtRelative } from "../../map/kit";
import type { Platform } from "../../qaApi";
import { cn } from "../../map/kit";
import { AppModelView } from "./app-model-panel";
import { useAppModel } from "./use-workflow-walks";
import styles from "./workflows.module.css";

/**
 * The App model's small entry on the project's Explore tab: one line of what Orcha
 * understands the app to be and how its workflows stand, opening the full panel in a side
 * sheet. Shown only once a model exists, so a project that never walked its workflows keeps a
 * clean tab.
 */
export function AppModelEntry({ cid, platform, appName }: { cid: string; platform: Platform; appName: string }) {
  const state = useAppModel(cid, platform);
  const [open, setOpen] = useState(false);
  const model = state.data?.model ?? null;
  if (!model) return null;
  const wf = model.workflows;
  const walked = wf.filter((w) => w.status !== "unwalked").length;
  const failed = wf.filter((w) => w.status === "failed").length;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "v-lift group flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-panel px-4 py-3 text-left outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring",
          styles.reveal,
        )}
        aria-haspopup="dialog"
        data-app-model-entry={state.data?.version ?? ""}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary dark:text-chart-1" aria-hidden>
          <Sparkles className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold text-fg">What Embodent understands {appName} to be</span>
          <span className="truncate text-xs text-fg-2">{model.purpose || "Its personas, core jobs and workflows."}</span>
        </span>
        <span className="hidden shrink-0 flex-col items-end text-xs sm:flex">
          <span className="tabular text-fg">
            {wf.length} workflow{wf.length === 1 ? "" : "s"} · {walked} walked
            {failed ? <span className="text-danger"> · {failed} failed</span> : null}
          </span>
          <span className="text-muted" suppressHydrationWarning>
            Version {state.data?.version} · {fmtRelative(state.data?.created_at)}
          </span>
        </span>
        <ArrowUpRight aria-hidden className="size-4 shrink-0 text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} placement="side" title="App model" className="sm:max-w-[560px]">
        <AppModelView state={state} appName={appName} className="border-0 p-0" />
      </Dialog>
    </>
  );
}
