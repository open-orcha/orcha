/**
 * "Add a Quality workflow": the one way to bring ready-made Quality work into a workflow. Each block
 * is a line of plain words and a tiny preview of its steps; picking one puts them in after the chosen
 * step, already wired, and every step stays editable.
 */
import { useState } from "react";
import { Button, Dialog, MenuButton } from "../../components/primitives";
import { Icon } from "../../components/ui";
import { useLoad } from "../qa/parts";
import { DEFAULT_QA_SETTINGS, getQaSettings, type QaWorkflowBlock } from "../qa/requests/api";
import { finishProjectLine } from "../qa/runTask/finishing";
import { blockPreview } from "./workflowBlocks";
import { draftTaskName, type WorkflowDraft } from "./workflowDraft";
import { qualityWord } from "./workflowQa";

/** One line each: the first sentence says what the block does. */
const firstSentence = (s: string) => s.split(/(?<=\.)\s/)[0];

export function WorkflowBlockPicker({ cid, blocks, draft, initialAfter, onPick, onClose }: {
  cid: string; blocks: readonly QaWorkflowBlock[]; draft: WorkflowDraft; initialAfter: string | null;
  onPick: (block: QaWorkflowBlock, after: string | null) => void; onClose: () => void;
}) {
  const last = draft.tasks.at(-1)?.key ?? null;
  const [after, setAfter] = useState<string | null>(initialAfter ?? last);
  const point = draft.tasks.find((t) => t.key === after);
  const settings = useLoad((s) => getQaSettings(cid, s), [cid]).data ?? DEFAULT_QA_SETTINGS;
  return (
    <Dialog title="Add a Quality workflow" size="md" onClose={onClose}
      description="Ready-made steps with their routing wired. You can change any step after adding it."
      footer={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <div className="wf-blocks">
        {draft.tasks.length ? (
          <div className="wf-blocks-at">
            <span className="wf-muted">Add it after</span>
            <MenuButton size="sm" menuLabel="Add it after" value={point ? draftTaskName(point, draft.tasks) : "Choose a step"}
              items={draft.tasks.map((t) => ({ label: draftTaskName(t, draft.tasks), checked: t.key === after, onSelect: () => setAfter(t.key) }))} />
          </div>
        ) : null}
        <div className="wf-block-list" role="group" aria-label="Quality workflows">
          {blocks.map((b) => {
            const { steps, rounds, loopsBack } = blockPreview(b);
            const name = qualityWord(b.name);
            return (
              <button key={b.key} type="button" className="wf-block-opt" aria-label={name} data-block={b.key} onClick={() => onPick(b, after)}>
                <span className="wf-block-name">{name}</span>
                {b.description ? <span className="wf-muted wf-block-line">{firstSentence(qualityWord(b.description))}</span> : null}
                <span className="wf-preset-flow" aria-hidden="true">
                  {steps.map((s, i) => (
                    <span key={s.key} className="wf-preset-step-wrap">
                      {i > 0 ? <Icon name="chev-right" cls="v2-ico wf-preset-arrow" /> : null}
                      <span className={"wf-preset-step" + (s.tone ? ` is-${s.tone}` : "")}>{s.title}</span>
                    </span>
                  ))}
                  {rounds && loopsBack ? <span className="wf-preset-loop">↺ Up to {rounds} {rounds === 1 ? "round" : "rounds"}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        <p className="wf-muted wf-blocks-note">{finishProjectLine(settings.finish_when_proven)}</p>
      </div>
    </Dialog>
  );
}
