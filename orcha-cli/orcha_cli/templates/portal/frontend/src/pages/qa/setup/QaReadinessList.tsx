/**
 * Next to "QA tools": one line per platform, "Ready" or what is missing in plain words, from the same
 * checks as `orcha qa doctor`. The web line offers Download now for the test browser, shows its
 * progress while it downloads (it polls), and Try again after a failure.
 */
import { useEffect, useState } from "react";
import { Button } from "../../../components/primitives";
import type { QaAuthority } from "../authority";
import { errText, useLoad } from "../parts";
import { platformWord } from "../qaWords";
import type { Platform } from "../qaApi";
import { browserAction, downloadQaBrowser, getQaReadiness, type QaPlatformReadiness } from "./setup";

/** How often the list is read again while the test browser downloads. */
export const DOWNLOAD_POLL_MS = 2000;

export function QaReadinessList({ cid, auth }: { cid: string; auth: QaAuthority }) {
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const res = useLoad((s) => getQaReadiness(cid, s), [cid], tick);
  const rows = res.data?.available ? res.data.platforms : [];
  const downloading = rows.some((r) => r.browser?.state === "downloading");
  useEffect(() => {
    if (!downloading) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), DOWNLOAD_POLL_MS);
    return () => window.clearTimeout(t);
  }, [downloading, tick]);
  if (res.status === 404 || !res.data?.available) return null; // an older server, or one without the QA package
  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      await downloadQaBrowser(cid, auth.human?.id ?? null);
      setTick((n) => n + 1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="qa-field qa-finish" data-qa-readiness>
      <span className="qa-label">Ready to test</span>
      <ul className="qa-readiness">
        {rows.map((r) => <ReadinessLine key={r.platform} row={r} busy={busy} can={auth.can} onDownload={() => void download()} />)}
      </ul>
      {err ? <p className="qa-error" role="alert">{err}</p> : null}
    </div>
  );
}

function ReadinessLine({ row, busy, can, onDownload }: { row: QaPlatformReadiness; busy: boolean; can: boolean; onDownload: () => void }) {
  const action = browserAction(row.browser);
  const pct = row.browser?.state === "downloading" ? row.browser.percent ?? 0 : null;
  return (
    <li className="qa-readiness-row" data-platform={row.platform} data-ready={row.ready ? "yes" : "no"}>
      <span className="qa-readiness-name">{platformWord(row.platform as Platform)}</span>
      <span className={row.ready ? "qa-readiness-words qa-ok" : "qa-readiness-words qa-muted"}>
        {row.words}
        {row.link ? <> <a href={row.link} target="_blank" rel="noreferrer">Get it from Google</a></> : null}
      </span>
      {pct !== null ? <progress className="qa-readiness-progress" max={100} value={pct} aria-label="Test browser download" /> : null}
      {action ? (
        <Button size="sm" busy={busy} disabled={!can} onClick={onDownload} data-download-browser>
          {action === "retry" ? "Try again" : "Download now"}
        </Button>
      ) : null}
    </li>
  );
}
