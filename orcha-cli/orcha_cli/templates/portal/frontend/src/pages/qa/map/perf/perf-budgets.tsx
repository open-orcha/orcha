import { useEffect, useState } from "react";
import { ArrowLeft } from "../kit/icons";
import { Link, Skeleton } from "../kit";
import { errText, qaHref } from "../../parts";
import type { QaNav } from "../../QaPage";
import { getPerfSettings } from "./api";
import { PerfSettingsSection } from "./perf-settings-section";
import type { PerfSettings } from "./perf-settings";

/** The speed budgets, reached from Slowest screens' Budgets button. */
export function PerfBudgets({ cid, nav }: { cid: string; nav: QaNav }) {
  const [load, setLoad] = useState<{ settings: PerfSettings | null; error: string | null }>({ settings: null, error: null });
  useEffect(() => {
    const ctl = new AbortController();
    getPerfSettings(cid, ctl.signal).then(
      (settings) => setLoad({ settings, error: null }),
      (e) => {
        if (!ctl.signal.aborted) setLoad({ settings: null, error: errText(e) });
      },
    );
    return () => ctl.abort();
  }, [cid]);
  const slowestHref = qaHref({ view: "map", platform: nav.platform === "ios" ? null : nav.platform, sub: "slowest" });
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-4 py-5 sm:px-6" data-perf-budgets>
      <header className="min-w-0">
        <Link href={slowestHref} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          <ArrowLeft className="size-3" aria-hidden /> Slowest screens
        </Link>
        <h1 className="mt-1 text-[15px] font-semibold text-fg">Budgets</h1>
        <p className="mt-0.5 text-sm text-fg-2">Embodent times every screen on every run and compares it with its usual time.</p>
      </header>
      {load.error ? <p className="py-6 text-center text-sm text-danger">Could not load the budgets: {load.error}</p> : null}
      {load.settings ? (
        <PerfSettingsSection cid={cid} slowestHref={slowestHref} initial={load.settings} actor={nav.auth.human?.id ?? null} can={nav.auth.can} reason={nav.auth.reason} />
      ) : load.error ? null : <Skeleton className="h-64 w-full" />}
    </div>
  );
}
