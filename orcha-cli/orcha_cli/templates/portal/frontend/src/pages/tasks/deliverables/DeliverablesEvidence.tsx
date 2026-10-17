/**
 * The verification gate's "Deliverables" row (D12: one line + a disclosure).
 * Line: each deliverable's name + version chip (first 3, then "+N"). The
 * disclosure — only when some deliverable has an earlier version — shows the
 * text diff of each updated deliverable (previous → latest version), so the
 * reviewer sees exactly what the latest run changed before accepting.
 * Renders nothing when there are no deliverables (or the API is absent).
 */
import { Icon } from "../../../components/ui";
import { useDeliverables } from "./api";
import { DeliverableDiff } from "./DeliverableDiff";
import { deliverablesCss } from "./deliverablesCss";

export function DeliverablesEvidence({ tid, noDiff }: { tid: string; noDiff?: boolean }) {
  const { state } = useDeliverables(tid);
  if (state.status !== "ok" || !state.data.deliverables.length) return null;
  // what the latest run CHANGED leads, then run outputs, then human attachments
  const rank = (d: (typeof state.data.deliverables)[number]) => (d.version_count > 1 ? 0 : d.latest?.source === "run_output" ? 1 : 2);
  const list = state.data.deliverables.slice().sort((a, b) => rank(a) - rank(b));
  const updated = list.filter((d) => d.version_count > 1 && d.latest_version > 1);
  const shown = list.slice(0, 3);
  return (
    <div className="td-g-row dlv-ev" aria-label="Deliverables evidence" data-testid="deliverables-evidence">
      <style>{deliverablesCss}</style>
      <span className="td-g-k">Deliverables</span>
      <div className="td-g-v">
        <span className="dlv-ev-line">
          {shown.map((d) => (
            <span key={d.id} className="dlv-ev-file" title={d.path + " · " + d.version_count + " version" + (d.version_count === 1 ? "" : "s")}>
              {d.name}
              {d.version_count > 1 ? <span className="dlv-ver" style={{ marginLeft: 4 }}>v{d.latest_version}</span> : null}
            </span>
          ))}
          {list.length > shown.length ? <span className="v2-muted">+{list.length - shown.length} more</span> : null}
          {!updated.length ? <span className="v2-muted">· first versions</span> : null}
        </span>
        {updated.length && !noDiff ? (
          <details className="dlv-ev-diff">
            <summary>
              <Icon name="chev" cls="v2-ico wk-disc-chev" />
              Changes in {updated.length} deliverable{updated.length === 1 ? "" : "s"}
            </summary>
            <div className="dlv-ev-diffs">
              {updated.map((d) => (
                <DeliverableDiff key={d.id} tid={tid} did={d.id} from={d.latest_version - 1} to={d.latest_version} />
              ))}
            </div>
          </details>
        ) : updated.length ? (
          <span className="v2-muted"> · {updated.length} updated</span>
        ) : null}
      </div>
    </div>
  );
}
