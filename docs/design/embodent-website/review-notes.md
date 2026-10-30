# Evidence and review notes

Prepared by Dana for Kedar · 30 October 2026 · Design revision 3

The desktop and phone designs are ready for team review. Kedar approved the plan; final design approval is still pending. This package is a website design specification and prototype, with no production website edits or deployment.

## What changed after the plan reviews

CodeCleanupAgent cleared plan revision 1.2 after its two corrections were added. Usage now covers Workflows, dependencies and per-task autonomy OFF/ON. Installation distinguishes stopping from data removal, places backups first, and contains no copyable destructive reset command. Code Reviewer's requested release, approval-copy and accessibility checks are addressed below. Those plan verdicts do not certify this deliverable.

Revision 2 corrects a malformed dark accent value in the initial token export to the actual app color `#8D93F7`, aligns the reading-width token to the 780 px design, and labels the terminal guide as installing development main separately from the downloadable Mac release. Revision 2 screenshots and validation were superseded by revision 3. Earlier checks do not stand in for this revision's results.

## Deliverable review corrections — revision 3

- Code Reviewer found that the standalone Usage and GitHub navigation links were narrower than the specified 44 px minimum. The shared header/footer link rules now set both `min-width:44px` and `min-height:44px`. Centering keeps desktop labels balanced; expanded phone navigation stays left-aligned. All 15 preview PNGs were refreshed, along with the social preview and `validation.json`. Desktop home and expanded phone navigation were visually rechecked after the change.
- CodeCleanupAgent correctly identified the missing native 200% browser text-zoom evidence. The requirement is now explicitly outstanding in this document and the handoff entry point. No agent is claiming that scripted font doubling satisfies it, and no zoom defect has been proven. Final design clearance still requires this check and both review findings to be addressed through the team lead.
- Safari loaded the current local prototype and exposed its normal navigation and text-enlargement menu in the accessibility tree, but screen capture was unavailable. A subsequent attempt to open a dedicated Chrome review tab was rejected by the browser URL policy for the local file. No zoom action or passing native-zoom result is claimed; no alternate URL, browser-control bypass or other workaround was used after that rejection.

### Scoped review result received

On 30 October 2026, Code Reviewer returned **CLEAN for the revision 3 navigation click-area correction**. The reviewer checked the shared CSS, all 70 supplied link measurements, all 44 manifest entries, desktop home images in both themes and the open phone menu. No correction-specific findings remain. This was an independent inspection of the supplied evidence; the reviewer did not rerun browser measurements or perform native zoom.

The reviewed package manifest had SHA-256 `213e4319bfbf9126ca5369764f2dfb2ba5afef649b18dd19c1171e8e92b8b52e`. After consuming that response, Dana updated only this review record and the README status, then refreshed their manifest entries. The prototype, styles, assets, measurements and screenshots remain the exact reviewed revision 3 files. No additional browser check is claimed.

The task-scoped question to Kedar for native 200% browser zoom observations remains open. After that evidence is received and any findings are resolved, return it with this scoped review through CodeCleanupAgent for the combined recommendation. Overall design clearance and Kedar's final task verification remain pending.

## Product and release evidence

Checked again on 30 October 2026. Links below point to source or a published release; `v2.1.0` denotes the advertised Mac version. Recheck release constants immediately before WebsiteAgent's production handoff.

| Design claim | Evidence inspected | Consequence |
| --- | --- | --- |
| Mac download is for Apple Silicon | [Published 2.1.0 release](https://github.com/open-orcha/orcha/releases/tag/v2.1.0) and GitHub release API: published 29 October, not draft or prerelease; arm64 DMG and ZIP plus checksums | Hardware label before the action; no Intel/Windows/Linux desktop claim. Binary not installed or downloaded in this design task. |
| Website source and version | WebsiteAgent's task response; [website main constants](https://github.com/Quantal-Labs-AI/orcha-website/blob/main/src/consts.js) currently expose `APP_VERSION`, `RELEASE_TAG`, `MAC_DMG_URL`, `RELEASE_URL` | Latest website main is implementation baseline; leave the older local checkout intact. Keep values centralized. |
| Mac bundles local runtime; coding agent still required | [Release README](https://github.com/open-orcha/orcha/blob/v2.1.0/README.md#installation), runtime and prerequisite sections | No mandatory Docker/Homebrew steps. Explain local project service versus provider-hosted AI requests. README's older “not on Releases yet” paragraph is contradicted by published release metadata and is not copied. |
| Terminal path differs from Mac download | [Release README terminal section](https://github.com/open-orcha/orcha/blob/v2.1.0/README.md#option-2--the-command-line-with-uv-macos) | Its command fetches `main`, despite the guide being version-pinned. Explicitly call this the development version; keep it secondary. External setup/install scripts were not executed. |
| Workflows and review loops | 2.1.0 release notes plus [versioned workflow routes](https://github.com/open-orcha/orcha/blob/v2.1.0/orcha-cli/orcha_cli/templates/portal/portal_backend/workflow_routes.py) | Show goal → tasks → dependency → start → review → finish. Loop copy uses available outcomes, limits, history and human decisions. |
| Per-task autonomy and human finish | [2.1.0 TaskAuthority](https://github.com/open-orcha/orcha/blob/v2.1.0/orcha-cli/orcha_cli/templates/portal/frontend/src/pages/tasks/TaskAuthority.tsx), especially its rendered descriptions and owner checks | OFF requires plan/result approval; ON permits the assigned agent's future approvals. Dependencies/holds/stop instructions remain. Human finishes workflow. Example visibly uses OFF. |
| Ordinary stop preserves history; restart uses same project | [2.1.0 lifecycle implementation](https://github.com/open-orcha/orcha/blob/v2.1.0/orcha-cli/orcha_cli/cli_native_lifecycle.py), `down` and `up`; [README lifecycle](https://github.com/open-orcha/orcha/blob/v2.1.0/README.md#lifecycle) | Copyable `orcha down` and `orcha up`; explain login-service restart. No reset disguised as stop. Commands were inspected, not executed. |
| Backup and restore | [2.1.0 backup implementation](https://github.com/open-orcha/orcha/blob/v2.1.0/orcha-cli/orcha_cli/cli_backup.py), `backup` and `restore` | Keep database, attachments and manifest together. Restore requires stopped service and replaces current data; original files are retained by the implementation. Public copy stays simple and directs advanced users to help. |
| Name and citation | [Project citation](https://github.com/open-orcha/orcha/blob/v2.1.0/CITATION.cff), project license and existing Halo E artwork | Change product label to Embodent; preserve `orcha`, repository, registered citation title, author and DOI. Font and project licenses accompany assets. |

The live `/openapi.json` was read on 30 October. Relevant available operations are workflow creation/tasks/start/finish, task autonomy and approval history, task messages, request respond/nudge/close, and agent conversations/turns. This establishes that the marketed capabilities exist in the current service; versioned source and release notes establish the advertised release coverage. The prototype never calls these APIs. It introduces no backend asks.

The workflow illustration uses invented workshop content. It describes supported concepts without presenting itself as a screenshot of the app. It includes real text and a caption, so the explanation survives missing images and is available to assistive technology. No private project content, account data, local paths or credentials appear in the public preview.

## Visual and interaction checks

`validation.json` records 43 passing browser checks, with no page-script errors, on revision 3. Ten added checks measure every shared header/footer link at five viewport widths in both themes; Usage and GitHub are now at least 44 × 44 CSS px. This includes all four public page designs plus the component-state gallery at 320, 390, 768, 1024 and 1440 CSS pixels: no horizontal page overflow, one main H1, and all in-page anchors resolving. Additional checks cover valid exported color values, the rendered dark link color, desktop/phone menu visibility, phone menu Escape/focus return, theme persistence, command-copy failure and success feedback, and doubled hero/body/button text at phone width. Clipboard success uses a stub; no system clipboard or command execution is claimed.

Visual inspection covers the rendered desktop dark/light and phone home layouts, guide layouts, open phone navigation, command/download recovery, focus and text-size examples. The type and layout remain legible, text wraps, the logo is not stretched, and the main action stays clear. `contrast.json` contains 42 passing measured text/button/decision-panel pairs; the lowest tested ratio is 4.70:1. Decorative dividers are not treated as meaningful control boundaries; actual controls use the stronger outline.

The default delivered media is static, with no motion or autoplay. If video is added later, the component inventory requires a poster, user-initiated playback, captions for speech, and a text fallback. This package does not certify an absent video.

The retained revision 2 `accessibility-tree.txt` captures the header names, expanded phone menu and selected Appearance option. The additional accessibility check passed its name/state tests and all-element text enlargement for all four pages at 390 px. Its first live OS-theme assertion ran before the browser delivered the change event; that failed assertion is retained in `accessibility-validation.json`. A focused follow-up, `appearance-event-validation.json`, waits for the actual media-query event and passes light → dark → light. No product change was needed for that timing correction.

### Limits of these checks

The automated reflow and text-size checks are not full WCAG certification, an end-to-end install test, or a VoiceOver/TalkBack session. Native browser control semantics, names and selected/expanded states are specified in the handoff. The approved 200% native browser text-zoom check is **outstanding on this design**, not deferred to WebsiteAgent. The earlier scripted enlargement does not satisfy it. See `native-zoom-check.md` for the blocked attempt and the observations still needed. WebsiteAgent must also repeat accessibility checks on the implementation, including its accessibility tree, real screen-reader behavior, browser zoom, disabled JavaScript, and Safari/Firefox as well as Chromium. The prototype uses templates for local review; production Astro content and navigation must render without JavaScript. The release-unavailable state is a simulated design, not an assertion that downloads are currently unavailable.

## Review and implementation checklist

- CodeCleanupAgent: brand fit, page coverage, clarity for a new visitor, plan-review corrections and handoff completeness.
- Code Reviewer: source-backed capability/install copy, tokens and assets, links, interaction/accessibility notes and boundaries of the validation evidence.
- Address review findings in these same filenames, then request Kedar's final task verification. Do not mark this design accepted on an agent verdict.
- WebsiteAgent: use a fresh worktree from website main, implement the true route map, preserve base-path handling, central release values, legacy guide anchors and the unlisted public Stats route. Strip review-only banners and gallery.
- Recheck all release/download and provider setup links before shipping. Audit public Stats markup and metadata without exporting operator account guidance. Use provided social image and matching logo variants.
- Respect the workflow's existing ordering. Design approval does not authorize publishing or change the two following tasks. Only Kedar merges to website main, which automatically deploys.
