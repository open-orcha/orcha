# Embodent website design plan

Prepared by Dana for Kedar · 30 October 2026 · Revision 1.2

**Status: Kedar approved the plan on 30 October 2026; CodeCleanupAgent cleared revision 1.2 on the same day.** Code Reviewer found revision 1 clean at the plan stage. Revision 1.2 incorporates CodeCleanupAgent's requested content checks on revision 1.1. This is the plan for the website design task, not finished designs or permission to publish. The task is complete only when the web designs exist and Kedar verifies them.

## Proposal

Make openorcha.io look and read like the current Embodent app. Lead with **“Orcha is now Embodent (Embodied Agent).”** Use the existing Halo E logo, charcoal and indigo app theme, and a real product view showing agents working toward an objective with a decision waiting for the person. Deliver desktop and phone layouts, light and dark variants, exact copy and interaction notes for WebsiteAgent to implement.

The site’s job is to explain the product, show what the user controls, and lead to an accurate installation guide. The domain stays openorcha.io. The product name changes; CLI commands, repository URLs and API names retain their actual names.

## What I checked

| Source | Finding | Design consequence |
| --- | --- | --- |
| [Public homepage](https://openorcha.io), inspected 30 October | Orcha name; older Docker/Postgres and read-only portal descriptions | Propose corrected product copy alongside the visual refresh; confirm install and release facts before final copy |
| Website source at `/Users/kedar/ai_apps/orcha-website` | Historical Astro reference with Home, Installation, Usage, Attribution and an unlisted Stats route; WebsiteAgent confirmed this checkout is stale | Keep the existing public destinations; use latest `main` of `Quantal-Labs-AI/orcha-website` as the implementation baseline |
| `desktop/resources/logo-mark.svg`, `logo-mark-mono.svg`, `icon.svg` in the Orcha repo | Existing Embodent Halo E identity | Reuse the artwork; no new logo exploration |
| `orcha-cli/orcha_cli/templates/portal/static/styles/v2-tokens.css` and `frontend/src/shell/theme.ts` | Current app has dark and light themes, Inter Variable, indigo primary buttons | Map website tokens to implemented values; use larger text and spacing for a public website |
| Current Orcha `README.md` and `/openapi.json` | Local process/SQLite runtime and interactive workflow/task/agent surfaces exist | Marketing example must describe supported behavior; no new product actions or backend work are proposed |
| `docs/orcha-v2-design-system.md` | Some prose still says dark-only, while implemented tokens and theme code support light | Prefer the actual theme code for this proposal; have reviewers check this explicitly |
| Website Git status | Existing edits in README, constants, home and installation pages | Treat that checkout as reference; coordinate with WebsiteAgent and leave those edits intact |

The local website checkout and public page are distinct baselines. WebsiteAgent's response on 30 October confirms that the local checkout and its edits are stale; leave them intact. Use a fresh worktree from the website repository's latest `main` for any future handoff PR. Its merges automatically deploy openorcha.io, so only Kedar may merge.

### Source and release clarification — revision 1.1

The scope and visual direction are unchanged. The following evidence replaces the earlier uncertainty about the current Mac download:

- WebsiteAgent identified latest `main` of `Quantal-Labs-AI/orcha-website` as the website source. Independently read [`src/consts.js` on main](https://github.com/Quantal-Labs-AI/orcha-website/blob/main/src/consts.js): `APP_VERSION` is `2.1.0`, and `MAC_DMG_URL`, `MAC_ZIP_URL` and `RELEASE_URL` derive their destinations from it. Final specs must reference those constants rather than hardcode a version.
- Independently checked the [published Embodent 2.1.0 release](https://github.com/open-orcha/orcha/releases/tag/v2.1.0) through GitHub's API: published 29 October 2026, not a draft or prerelease, with Apple Silicon DMG and ZIP assets. There is no Intel/universal asset in that release. State **“Mac with Apple Silicon”** next to the Mac download; do not imply availability on other platforms.
- Independently fetched the [live Installation page](https://openorcha.io/installation): it links to `Embodent-2.1.0-arm64.dmg`. WebsiteAgent also checked that the download returns HTTP 200; Dana has verified the release asset listing and page destination, not downloaded the binary.
- Keep the proposed homepage **Get started → Installation** route. The Installation page can offer the verified Mac download alongside appropriate setup guidance. Recheck current release and prerequisite facts when creating the final handoff.

This is a planning clarification, not a completed design. At revision 1.1, Kedar's plan approval and both team reviews were pending. The current review position is recorded below; a reviewer's acceptance of an assignment is not a review verdict.

### Review corrections — revision 1.2

The visual direction and page scope remain unchanged. These additions make the content audit and final checks explicit:

1. **Usage: Workflows, dependencies and approval settings.** Replace the old plan-only / PR / full-autonomy walkthrough with the current Workflows and per-task autonomy OFF/ON model. Explain how dependencies govern when work can start. Remove blanket claims that every task always requires human sign-off: with autonomy OFF, the plan and finished work need approval; with autonomy ON, the assigned agent may approve its own future plan and result, while a person still finishes the workflow. Show the chosen human-decision example with autonomy OFF. Code Reviewer must check the final copy and imagery against the supported version being advertised, not only current development source. If a feature is absent from that release, omit it or explicitly label its version scope.
2. **Installation: stop, restart, backup and reset.** Audit the exact commands and their behavior for the advertised release. Ordinary stopping must use the verified path that preserves project history; the inspected native implementation uses `orcha down` for that purpose. Do not present `orcha down -v` as an ordinary stop command. If a reset/delete example is retained, place it in a separate advanced section, with the data-loss explanation and backup advice before the command and its copy control. Verify restart and backup/restore instructions as part of the same review. This is a documentation/design check; no stop, reset or delete command is executed for this task.
3. **Rendered accessibility checks.** In addition to the existing checks, verify screen-reader names and expanded/selected states, phone-menu focus return, announcements for command-copy results, 200% text zoom and narrow-screen reflow, and a text equivalent for product media. Include captions when selected video contains speech. Source-level contrast checks do not certify the final screens.
4. **Public metadata and example content.** Include page titles, descriptions, theme-color, social previews, logo alternatives and the logo home-link name in the brand checklist. Treat `/stats` as an unlisted public route, not an authenticated private area; the shared-theme audit must keep operator-specific analytics/account guidance out of exported public content. Use seeded product examples or scrub fresh captures so no real request text, private paths, credentials or project data appear in the deliverables.

Source checks for these additions: CodeCleanupAgent's [revision 1.1 review](/Users/kedar/ai_apps/openorcha/.orcha-worktrees/CodeCleanupAgent-1793376006619/.orcha/outputs/embodent-website-plan-review.txt) inspected current website main, including `src/pages/usage.astro` and `src/pages/installation.astro`. Dana independently inspected `cli_native_lifecycle.py:176–204`, `TaskAuthority.tsx:112–121`, `WorkflowTaskRows.tsx:57`, and the live OpenAPI `TaskAutonomyUpdate` schema on 30 October. These confirm current behavior; the supported release still needs the final version-specific check. Code Reviewer's [plan review](/Users/kedar/ai_apps/openorcha/.orcha-worktrees/Code-Reviewer-1793376010011/.orcha/reviews/embodent-website-plan/review.md) was CLEAN for revision 1 with release, autonomy-copy and rendered-accessibility checks carried forward. Its stale-download-constants observation concerns the older reference checkout; revision 1.1's current-main source clarification remains in force.

## Small reviewable pieces

1. **Theme and content map.** Confirm logo sources, dark/light tokens, type scale, shared navigation, proposed homepage wording and which older claims need replacement.
2. **Homepage and responsive navigation.** Design a desktop home page, a phone home page, an open phone menu, and the product example. Make the name change visible near the top, with the main “Get started” action leading to Installation.
3. **Guide templates and handoff.** Design the Installation page and reusable long-form guide layout for Usage and Open Source. Specify component states, media fallback, download availability states, assets, accessibility and exact destinations. Include the existing unlisted public Stats route in the shared-theme audit, without adding it to public navigation. Apply the Workflows, approval-setting, stop/restart/backup/reset and metadata checks above before final review.

Each piece will be independently readable. Review corrections feed back into the same files. CodeCleanupAgent reviews the plan and brand fit; Code Reviewer checks the design against implementation and product facts. Kedar approves the plan before screens are produced and verifies the finished designs. WebsiteAgent owns production implementation and publication in the following workflow tasks; Kedar alone merges.

## Proposed visual direction

The product view is the focal point: a readable agent team, its current work and a human decision. Keep the surrounding page quiet. Replace the old ocean imagery and emoji feature cards with the actual Embodent mark and product imagery. Avoid invented performance metrics or availability claims.

### Color foundations

These are mappings to the current app, not new brand colors.

| Role | Dark | Light |
| --- | --- | --- |
| Page background | `#0E0F10` | `#F4F4F5` |
| Content panel | `#151618` | `#FFFFFF` |
| Main text | `#EEEFF1` | `#1C1D1F` |
| Supporting text | `#B4B7BE` | `#4E525A` |
| Links / focus | `#8D93F7` | `#505AC9` |
| Primary button | `#5E6AD2` with `#FFFFFF` label | `#5E6AD2` with `#FFFFFF` label |

Use the logo's original near-white ink in dark mode and its currentColor variant in dark ink for light mode. Retain the 50% outer halo. Use semantic colors only where a product example needs a status, always with a readable label or symbol.

Proposed appearance behavior: dark on first visit, with a clearly named Dark / Light / System control, matching the app's preference vocabulary. Remember the local choice and avoid a wrong-theme flash. The guide pages share the same choice. Final specs will show keyboard and focus behavior as well as the control's compact phone treatment.

### Type and spacing

- Inter Variable for headings and body, using the app's existing licensed font assets. Monospace only for commands. Preserve the font license in the asset handoff.
- Proposed website scale: 56/60 px desktop hero, 36/40 px phone hero, 32/38 px section headings, 18/28 px introduction, 16/26 px body, 14/20 px supporting labels. These are website sizes, not changes to the app's dense interface.
- Left-aligned copy; reading columns around 60–72 characters. Four-pixel spacing rhythm; 16–24 px phone gutters; 48–96 px section separation according to viewport.
- Maximum content width around 1200 px. Use 6 px control corners and 10 px product-frame corners from the app rather than applying one large radius to every element. Specify at least 44 px interactive targets.

### Layout sketch

```text
Desktop
Halo E + Embodent       Installation  Usage  Open source   Appearance
Orcha is now Embodent (Embodied Agent).

Your AI team,           Product view: shared objective,
with you in charge.    agents at work, decision awaiting you
Short explanation
[Get started] [See how it works]

Describe the objective → Agents work together → Review the result
Product examples with short explanations
Installation guidance / closing action
Source, attribution, existing project links

Phone
Halo E + Embodent                           Menu
Name-change statement
Headline / short explanation
[Get started]
[See how it works]
Product example readable at phone width
Stacked explanations and guide links
Footer
```

The “See how it works” action goes to an in-page product explanation, with a still image first and optional user-triggered video. A phone view uses a legible crop or purpose-made seeded example, not an unreadably shrunken desktop screenshot. Any staged example is labeled as an example.

## Content and navigation coverage

| Surface | Planned design coverage |
| --- | --- |
| Home `/` | Rebrand statement; proposed headline “Your AI team, with you in charge.”; supported capabilities; product example; getting started; footer |
| Installation `/installation` | Shared theme; supported install paths and prerequisites; download versus instructions; release-unavailable state; command copy feedback; verified stop/restart/backup guidance; any destructive reset separated with its data-loss explanation before copying |
| Usage `/usage` | Readable guide template and section navigation; current Workflows, dependencies and per-task autonomy OFF/ON; accurate plan/result approval and human workflow-finish wording; version-checked product examples |
| Open Source `/attribution` | Branding plus source, license, citation and credit treatment; preserve real project names and destinations |
| Shared header/footer | Desktop navigation, current-page indication, phone menu closed/open, Escape/close/back behavior, keyboard focus, appearance choice |
| Product media | Poster, loading, playback, unavailable-media fallback, descriptive alternative text, reduced-motion handling |
| Links and downloads | Exact target map; enabled/unavailable states; no fake download, login, app-store or live agent controls |

Proposed introductory copy: “Bring Claude Code and Codex agents together around a shared objective. Follow their work, answer questions, and review results in one place.” Review against current supported releases before final sign-off. Replace old Docker-only and read-only-dashboard claims with verified current wording. Do not rename `orcha` commands to `embodent` or invent new API paths.

## Deliverables after approval

All task artifacts go under `.orcha/outputs/embodent-website/`, with every file under 10 MiB:

- `README.md`: review entry point, annotated page specs, states, navigation/target map, content and implementation checklist.
- `tokens.json` and `tokens.css`: shared website design tokens, source mapping and both themes.
- `preview.html`: self-contained design prototype, explicitly marked as a design preview; no production API mutations.
- PNG previews for desktop (1440 px) and phone (390 px), plus light-theme and interaction-state examples. Check 320 px, tablet width and text zoom in the prototype.
- `assets/`: existing logo variants, favicon/social-image guidance and required exports, with source and license notes. Keep oversized videos outside task attachments and reference the repository originals.
- `review-notes.md`: checked facts, visual/accessibility findings, corrections and any remaining release-dependent decisions.

Quality checks: readable contrast, keyboard-only navigation, visible focus, meaningful link labels, no horizontal page overflow, text resizing, reduced motion, valid logo proportions, correct dark/light imagery, and a realistic supported install path. A design preview never calls a state-changing product API. If a later approved concept needs an unsupported action, list that as a new API request before adding it.

## Approval being requested

Approve this scope and direction so Dana can create the screens and build-ready handoff: current Embodent branding, desktop/phone and dark/light layouts, refreshed public-page copy, existing site destinations, and a clear Orcha-to-Embodent announcement. This approval does not accept unfinished designs or authorize production deployment. Final acceptance remains Kedar's task verification.
