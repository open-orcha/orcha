/**
 * Onboarding step "template" — "Start from a template" on the setup fork.
 * OnboardingPage renders it for step === "template" (and for the deep link
 * /onboarding?step=template); leaving returns to the fork, finishing lands on
 * the project Overview with a fresh snapshot.
 */
import { TemplateApplyFlow } from "./TemplateApplyFlow";

export interface TemplateStepProps {
  cid: string | null;
  /** why this identity may not add agents (viewer / no manage_agents), else null */
  denied: string | null;
  onBack: () => void;
  onFinished: () => void;
}

export function TemplateStep({ cid, denied, onBack, onFinished }: TemplateStepProps) {
  return (
    <div className="ob wide" id="obTemplate">
      <div className="form-h">
        <h1 className="v2-t-display">Start from a template</h1>
        <p className="v2-t-body-lg">
          A ready-made team for your kind of work — roles with prompts, routines and definition-of-done presets.
          You choose what to keep and review everything before it's created.
        </p>
      </div>
      {denied ? <p className="ob-muted ob-denied" role="note">{denied}. You can look through the templates, but not apply one.</p> : null}
      {cid ? (
        <TemplateApplyFlow cid={cid} compact onCancel={onBack} doneLabel="Go to Overview" onDone={onFinished} />
      ) : (
        <p className="ob-muted">Open a project first.</p>
      )}
    </div>
  );
}
