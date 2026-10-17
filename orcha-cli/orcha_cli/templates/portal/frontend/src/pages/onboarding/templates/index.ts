/**
 * General-mode + industry templates — what the integrator mounts.
 *   - Settings › General: <ProjectModeSection cid={cid} />  (mode switch + "Apply a template…")
 *   - Anywhere else:      <ApplyTemplateDialog cid={cid} onClose={…} />
 *   - Onboarding:         already wired (fork option + step "template", deep link
 *                         /onboarding?step=template).
 * Nav / shell hooks live in lib/projectMode.ts (sectionsForMode, autonomyLabelFor,
 * modeWords, useProjectMode).
 */
export { ProjectModeSection } from "./ProjectModeSection";
export { ApplyTemplateDialog } from "./ApplyTemplateDialog";
export { TemplateApplyFlow, TemplateGallery, PlanView, ResultView, TEMPLATE_GLYPH } from "./TemplateApplyFlow";
export { TemplateStep } from "./TemplateStep";
export * from "./templatesApi";
