/**
 * Never lose a run. The pill shows on every Quality view ("● Mapping · 3:12", a thumbnail when one
 * exists, the device), the offer on the tab's landing and on onboarding. One click returns to the run.
 */
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ButtonLink } from "../../../components/primitives";
import { useSnapshot } from "../../../state/SnapshotProvider";
import { platformWord } from "../qaWords";
import { getLive } from "../runs/api";
import { urlFor } from "../runs/replay/use-signed-url";
import { liveRunHref, liveWord, pillWords, showing, type LiveRun } from "./runFlow";
import { useLiveRun } from "./useLiveRun";
import "./run.css";

const FRAME_POLL_MS = 8_000;

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The newest frame of the run, while it has a device. */
function useLatestFrame(cid: string | null, run: LiveRun | null): string | null {
  const [frame, setFrame] = useState<string | null>(null);
  const id = run && !run.waiting ? run.sessionId : null;
  const platform = run?.platform ?? null;
  useEffect(() => {
    setFrame(null);
    if (!cid || !id) return;
    const ctl = new AbortController();
    const read = () => {
      if (document.hidden) return;
      getLive(cid, platform, ctl.signal).then((tiles) => {
        const got = tiles.find((t) => t.session.id === id)?.frame_id ?? null;
        if (!ctl.signal.aborted && got) setFrame(got);
      }, () => { /* the thumbnail is a nicety: the pill stands without it */ });
    };
    read();
    const t = setInterval(read, FRAME_POLL_MS);
    return () => { ctl.abort(); clearInterval(t); };
  }, [cid, id, platform]);
  return frame;
}

export function LiveRunPill() {
  const { cid } = useSnapshot();
  const { search } = useLocation();
  const run = useLiveRun(cid);
  const now = useNow(!!run);
  const frame = useLatestFrame(cid, run);
  if (!run || showing(run, search)) return null;
  const words = pillWords(run, now);
  const device = !run.waitingFor ? run.device : null;
  return (
    <Link className={"qa-livepill" + (run.waiting ? " is-waiting" : "")} to={liveRunHref(run, search)} aria-label={`${words}${device ? ` on ${device}` : ""}. Open the run`} data-qa-live-pill={run.key}>
      {frame ? <img className="qa-livepill-thumb" src={urlFor(frame)} alt="" /> : <span className="qa-livedot" aria-hidden="true" />}
      <span className="qa-livepill-t">{words}</span>
      {device ? <span className="qa-livepill-d">{device}</span> : null}
    </Link>
  );
}

/** Coming back to the tab while something runs: say so, and offer the way to it. */
export function LiveRunOffer() {
  const { cid } = useSnapshot();
  const { search } = useLocation();
  const run = useLiveRun(cid);
  if (!run || showing(run, search)) return null;
  const on = run.waitingFor ? `Waiting for ${run.waitingFor}` : run.device ? `${liveWord(run.kind)} on ${run.device}` : run.platform ? `${liveWord(run.kind)} on ${platformWord(run.platform)}` : liveWord(run.kind);
  return (
    <div className="qa-liveoffer" role="status" data-qa-live-offer={run.key}>
      <span className="qa-livedot" aria-hidden="true" />
      <span className="qa-liveoffer-t">{on}{run.goal ? ` · ${run.goal}` : ""}</span>
      <ButtonLink size="sm" variant="primary" to={liveRunHref(run, search)}>Watch live</ButtonLink>
    </div>
  );
}
