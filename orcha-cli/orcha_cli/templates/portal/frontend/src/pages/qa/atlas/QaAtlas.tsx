/**
 * The Screen atlas: every screen at a glance, with its looks per state and across platforms. Reads
 * the atlas once for the first paint (its own skeleton meanwhile); the board keeps it live from
 * there. Filters and the open screen come from the URL, so a link opens the same view.
 */
import { useEffect, useState } from "react";
import { PortRoot, useSearchParams } from "../map/kit";
import type { QaNav } from "../QaPage";
import { AtlasBoard } from "./atlas-board";
import { AtlasSkeleton } from "./atlas-skeleton";
import { getAtlas } from "./atlasApi";
import { filtersFrom } from "./model";
import { parseAtlas, type Atlas } from "./types";

function Loaded({ cid, nav }: { cid: string; nav: QaNav }) {
  const params = useSearchParams();
  const since = nav.get("since")?.slice(0, 80) ?? null;
  const [first, setFirst] = useState<{ atlas: Atlas | null; error: string | null } | null>(null);
  const ready = Boolean(first?.atlas);
  // Until it has read once, each of the page's re-reads (and Try again) tries again.
  useEffect(() => {
    if (ready) return;
    const ctl = new AbortController();
    getAtlas(cid, since, ctl.signal).then(
      (json) => { if (!ctl.signal.aborted) setFirst({ atlas: parseAtlas(json), error: null }); },
      (e) => { if (!ctl.signal.aborted) setFirst({ atlas: null, error: e instanceof Error ? e.message : String(e) }); },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, nav.nonce, ready]);
  if (!first) return <AtlasSkeleton />;
  return (
    <div className="v-panel flex min-h-0 flex-1 flex-col" data-qa-atlas>
      <AtlasBoard key={ready ? "read" : "failed"} cid={cid} nav={nav} atlas={first.atlas} error={first.error} filters={filtersFrom(params)} screen={nav.get("screen")} since={since} />
    </div>
  );
}

export function QaAtlas({ cid, nav }: { cid: string; nav: QaNav }) {
  return (
    <PortRoot refresh={nav.refresh}>
      <Loaded key={cid} cid={cid} nav={nav} />
    </PortRoot>
  );
}
