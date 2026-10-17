/**
 * Proof-of-work evidence + Verdikt — the integrator's mount points.
 *
 *   Verification gate (TaskDetail GateSurface, verify branch, first row of .td-g-rows):
 *     <EvidencePack taskId={t.id} actorId={actor?.id ?? null} noActorReason={noHuman} bump={bump} />
 *   Needs-you rows (one fetch per list):
 *     const sums = useEvidenceSummaries(cid, bump);
 *     summaryText(sums?.[task.id])   (plain text for the row's second line) or
 *     <EvidenceSummaryLine summary={sums?.[task.id]} short />
 *   Settings → Integrations:
 *     <VerdiktSettingsSection cid={cid} />   (pages/settings/integrations/VerdiktSettings)
 */
export { EvidencePack, EvidenceDetails, type EvidencePackProps } from "./EvidencePack";
export { EvidenceSummaryLine, summaryParts, summaryText } from "./EvidenceSummaryLine";
export { VerdiktPanel } from "./VerdiktPanel";
export { AutofixSection, AutofixStatus, AutofixTimeline, AutofixOverride } from "./AutofixPanel";
export { useEvidence, useEvidenceSummaries } from "./useEvidence";
export { evidenceCss } from "./evidenceCss";
export type * from "./evidenceTypes";
