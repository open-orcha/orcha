/** Every running session at once, `?view=sessions&sub=live`: the live wall with a way back. */
import { ChevronLeft } from "../map/kit/icons";
import type { QaNav } from "../QaPage";
import { LiveWall } from "./live-wall/live-wall";

export function QaLiveWall({ cid, nav }: { cid: string; nav: QaNav }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button type="button" onClick={() => nav.set({ sub: null })} className="inline-flex h-8 w-fit shrink-0 items-center gap-1 px-4 text-xs text-muted transition-colors hover:text-fg" data-wall-back>
        <ChevronLeft aria-hidden className="size-3.5" />
        All sessions
      </button>
      <LiveWall cid={cid} onNewRun={() => nav.runQa()} newRunReason={nav.auth.can ? null : (nav.auth.reason ?? "Only a person can start QA work")} />
    </div>
  );
}
