/**
 * Metrics: Quality's share of the window, as the project's metrics report it. It is already in
 * the totals above, so this says "of which". A window with no runs shows nothing.
 */
import { minutesWord, plural } from "../qaWords";
import "../qa.css";
import "./runTask.css";

export interface QualityShare { runs: number; stopped: number; seconds: number; cost_usd: number }

export function QualityMetrics({ qa, days }: { qa: QualityShare | null | undefined; days: number }) {
  if (!qa?.runs) return null;
  const finished = qa.runs - qa.stopped;
  const perRun = qa.seconds / 60 / Math.max(1, finished);
  return (
    <section className="mx-sec aq-metrics" aria-label="Quality runs" data-quality-metrics>
      <div className="td-block-k">Quality runs</div>
      <dl className="rr-facts aq-metrics-facts">
        <div className="rr-fact"><dt>Runs</dt><dd>{qa.runs}</dd></div>
        {qa.stopped ? <div className="rr-fact"><dt>Did not finish</dt><dd>{qa.stopped}</dd></div> : null}
        {qa.seconds ? <div className="rr-fact"><dt>Time per run</dt><dd>{perRun < 1 ? "Under a minute" : minutesWord(perRun)}</dd></div> : null}
      </dl>
      <p className="qa-muted">{plural(qa.runs, "run")} in the last {days} days.</p>
    </section>
  );
}
