/**
 * Apply an industry template to an EXISTING project, in a dialog. Same flow as
 * onboarding's "Start from a template" (TemplateApplyFlow): pick → choose →
 * review exactly what will be created → confirm → result.
 */
import { Dialog } from "../../../components/primitives";
import { useSnapshot } from "../../../state/SnapshotProvider";
import { TemplateApplyFlow } from "./TemplateApplyFlow";
import "./templates.css";

export function ApplyTemplateDialog({ cid, initialKey, onClose }: { cid: string; initialKey?: string | null; onClose: () => void }) {
  const { refresh } = useSnapshot();
  return (
    <Dialog title="Apply a template" size="lg" onClose={onClose} closeOnBackdrop={false} className="tpl-dialog">
      <TemplateApplyFlow
        cid={cid}
        initialKey={initialKey}
        compact
        onCancel={onClose}
        doneLabel="Close"
        onDone={() => { void refresh(); onClose(); }}
      />
    </Dialog>
  );
}
