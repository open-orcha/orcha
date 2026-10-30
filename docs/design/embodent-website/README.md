# Embodent website design handoff

Prepared by Dana for Kedar · 30 October 2026 · Design revision 3

**For review.** Kedar approved the design plan. These designs still need team review and Kedar's final task verification. WebsiteAgent owns implementation and the later local preview; only Kedar merges and accepts the finished work.

The checks and their limits are recorded in [review notes](review-notes.md). Code Reviewer cleared the revision 3 navigation click-area correction on 30 October; this is a scoped result, not overall design clearance. **The approved native browser text-zoom check at 200% is still outstanding and blocks final design clearance.** See [the remaining check](native-zoom-check.md).

Open [the interactive preview](preview.html) with this folder's accompanying files. Start with [desktop dark](previews/home-desktop-dark.png), [phone dark](previews/home-phone-dark.png) and [desktop light](previews/home-desktop-light.png). Navigation and Appearance work in the preview; its product example is static. It never connects to Orcha or changes project data. Download and external documentation links lead to their actual destinations when clicked.

The visual direction is the existing Embodent app: Halo E, Inter Variable, charcoal surfaces and indigo controls. The homepage announces **“Orcha is now Embodent (Embodied Agent).”** The product example explains the shared objective and the user's decision. It uses invented workshop content, explicitly labeled as an illustration; it is not a capture of a private project or a promise of exact app layout.

## Reviewable pieces

| Piece | Files | What to review |
| --- | --- | --- |
| Theme and content map | `tokens.json`, `tokens.css`, `assets/`, this document | App-theme match, typography, responsive rules, page destinations and brand assets |
| Homepage and navigation | `preview.html?page=home`, `preview.css`, homepage/menu PNGs | Name change, product explanation, desktop/phone hierarchy, menu and appearance behavior |
| Guides and final handoff | Installation / Usage / Open source in the preview, `components.md`, `review-notes.md` | Exact copy, download truthfulness, approval settings, data-preserving stop guidance, recovery states and accessibility |

All copy visible in the preview is proposed final copy. The review-only banner and Component states page are design annotations and must not ship. The prototype's `?page=` links are for local preview only; implement the real routes below. Preserve the website's base-path handling. Preserve this folder's filenames when revising the handoff.

## Navigation and destination map

```text
Logo → Home
Home → Get started → Installation → Mac download / release notes
     → See how it works → #how-it-works
     → Explore Workflows → Usage #workflows
     → Communication → Usage #collaboration
Header / footer → Installation | Usage | Open source
Open source → GitHub source | MIT license | project archive
Appearance → Dark | Light | System (local browser preference)
```

| Element | Production destination / rule |
| --- | --- |
| Logo, Home | `/` using `BASE_URL`; accessible name `Embodent home` |
| Get started | `/installation`; consistent label at hero and closing section |
| Installation | `/installation` |
| Usage | `/usage` |
| Open source | `/attribution`; retain the existing route |
| See how it works | Home `#how-it-works`; no video autoplay |
| Explore Workflows | `/usage#workflows` |
| Communication guide | `/usage#collaboration` |
| Download for Mac | `MAC_DMG_URL` from website `src/consts.js`; current verified asset is Apple Silicon |
| Release notes | `RELEASE_URL`; unavailable-download fallback uses `REPO + '/releases'` |
| Source and GitHub | Existing `REPO` constant, `https://github.com/open-orcha/orcha` |
| License | `REPO + '/blob/main/LICENSE'` |
| Permanent archive | Existing `ZENODO_DOI_URL`, `https://doi.org/10.5281/zenodo.20740087` |
| Terminal installation | `REPO + '/blob/' + RELEASE_TAG + '/README.md#option-2--the-command-line-with-uv-macos'` |
| Lifecycle / recovery | `REPO + '/blob/' + RELEASE_TAG + '/README.md#lifecycle'` |
| Claude Code setup | `https://code.claude.com/docs/en/setup` |
| Codex CLI setup | `https://developers.openai.com/codex/cli/` (currently redirects to the official ChatGPT Learn guide) |
| Inter license | The shipped `OFL-inter.txt`, under the production assets base path |
| `/stats` | Existing unlisted public route; no header/footer link, no assumption of access control |

Use existing release constants for version labels and destinations. The frozen preview shows 2.1.0 only to document the checked release. The linked terminal guide installs development main, explicitly labeled separately from the Mac release. Do not replace CLI names, repository names, environment variables or citation titles with `embodent`.

## Shared layout and responsive behavior

At 1440 px, content is 1200 px wide with centered margins. Desktop gutters are at least 48 px until the 1150 px adjustment. At 390 px, gutters are 20 px; at 320 px, 16 px. The reading column is at most 780 px in this preview; prose itself stays below about 72 characters. Sizes are specified in CSS pixels.

| Width | Navigation | Homepage | Guides |
| --- | --- | --- | --- |
| Above 1040 px | 88 px header; logo left, public links and Appearance right | Two-column hero, copy left, product example right; 56/60 px H1 | 208 px section index plus reading column |
| 881–1040 px | Same full navigation | Single-column hero; product example below actions | 180 px index; reduced column gap |
| 601–880 px | 76 px header with Menu disclosure | Stacked hero; three explanatory steps may stay across | Section index becomes an inline “On this page” disclosure |
| 320–600 px | Logo and Menu; open navigation pushes content down | 36/40 px H1 (34 px at smallest size), full-width stacked actions, readable product rows; process steps vertical | Single column; 36/42 px title, 25/32 px section headings; download actions stack |

No fixed-height text containers. Allow headings, button labels, menu labels and status text to wrap when enlarged. No horizontal page scrolling. Long commands wrap inside their own blocks. Layout changes do not reorder the reading order. Standalone navigation targets are at least 44 × 44 CSS px; primary actions are at least 48 px tall. Do not shrink a full desktop screenshot to fit a phone.

### Header, menu and appearance

- Desktop: logo is the home link; current destination uses `aria-current="page"`, bright text and an underline. Home does not need a redundant header item.
- Phone: Menu is a normal button with `aria-expanded` and `aria-controls`. Opening it reveals the links and Appearance in document flow. It is a disclosure, not a modal: no backdrop, no focus trap and no scroll lock. Tab follows the revealed controls. Escape closes it and returns focus to Menu. Selecting a destination navigates normally. The next page loads with the menu closed. Opening a menu adds no browser-history entry.
- The selected appearance is Dark, Light or System. Dark is the default for a new visitor, matching the app. System follows the OS live. Save the site choice locally, independently of the app's preference. Resolve before first paint; failure to persist must still leave a usable session choice. Keep the native select and its visible Appearance label. Do not send site appearance to Orcha's preferences API.
- Browser Back follows ordinary document history. In-page anchors preserve familiar Back behavior; the menu itself does not intercept Back.
- Include a first-focus Skip to content link. Keep the header in normal flow; the desktop guide index may stick without covering a focused item.

## Screen specifications

### Homepage

Order: header → name-change statement / headline / explanation / actions → illustrative product → three-step explanation → communication explanation → closing action → footer. At desktop widths, the product is beside the headline; on a phone it follows the actions.

The hero copy is **“Your AI team, with you in charge.”** Follow it with the two-sentence description in the preview. Primary action is **Get started**. Secondary action is **See how it works**. The availability line reads **“Mac app for Apple Silicon · Runs on your computer.”** It describes the app location, not offline AI; the Installation page explicitly explains that agent requests go to their provider.

The product illustration is a workshop booking workflow with Designer, Builder and Reviewer. The first task is waiting for a plan decision; the dependent tasks are waiting. Autonomy OFF is visible. Status requires both text and shape/color. Keep the figure caption. Its rows and decision panel are not buttons, inputs or links and have no hover affordance. A desktop product screenshot can replace the illustration only after release/branding/readability/privacy review; match the phone treatment independently.

The lower three steps are a real sequence: describe the outcome, let the team work, choose when to step in. Marketing claims are mapped to real product behavior in `review-notes.md`. No counters, performance claims, pricing claims, store badges or fake live agent actions.

### Installation

Order: introduction → Mac availability and download → short setup → first project → terminal-guide link → ordinary stop and start → backup and advanced recovery guidance. The section index mirrors these anchors.

The Mac panel names Apple Silicon and the current version beside the download. Keep the hardware scope visible before the action. Do not infer Windows, Linux or Intel desktop availability. Source review confirms the current app bundles its runtime; remove the old mandatory Docker/Homebrew steps, duplicated prerequisites and obsolete installation commands. Do not promise an entirely installation-free process: users still need an installed and signed-in coding agent. Link to provider-owned setup instructions instead of copying shell installers.

The lifecycle examples are `orcha down`, `orcha up` and `orcha backup`. They are copyable text, never executed by the website. Labels distinguish each command. The backup section precedes any advanced discussion of data removal. This design intentionally contains no copyable destructive reset command. The older `/installation#advanced` and `#uninstall` URLs should remain as aliases to Terminal setup and Stop and return. Preserve `#reset` as an alias to backup/recovery so old links land on the data-loss explanation, not a command.

For release-unavailable state, replace the download action with **“The Mac download is unavailable”**, explanation and **View releases**. Do not leave a false enabled download or an unexplained disabled button. A public static site should use build-time/release-maintainer knowledge for this state; do not add an unreliable client-side GitHub request on every page view. A download click relies on the browser's own download UI; never show “Installed” or “Download complete.”

### Usage

Order: Workflows → approval settings → communication → result review → review loops → appearance. The workflow illustration is reused at reading-column width. The table compares task autonomy OFF and ON; it does not show the retired global plan-only / PR / full slider.

Explain dependencies as waiting for an earlier result to be accepted. Explain OFF as needing plan and finished-work approval, and ON as allowing the assigned agent to approve its own future plan and result. Holds and stops still apply; a person finishes the workflow. The screenshot/example's human decision is specifically OFF. The release contains feedback loops; do not present a free-form task protocol as the current workflow editor.

Legacy video walkthroughs are not reused automatically. Keep the new guide readable without any video. If optional video is added later, it must match the release/UI described, start only after user action, expose native playback controls, pause on navigation, have a text equivalent and captions when speech exists. Avoid autoplay even when muted. The preferred initial design is static and readable.

Preserve old inbound anchors where meaning remains: `#getting-started` / `#dashboard` → Workflows, `#autonomy` → approval settings, `#requests` / `#conversation` / `#building-blocks` → communication, `#verification` → result review, `#pr-review-loop` → review loops, `#theme` → appearance. Older model/worker-run content may link to the relevant current source documentation rather than retaining misleading clips.

### Open source

Keep the existing `/attribution` URL. Lead with the source and MIT license, then project/font credits, then the published citation. Do not rebrand the citation's registered title or DOI. The license list is explicitly not a complete dependency inventory. Plain-citation copy follows the command-copy feedback model. Retain the existing BibTeX content in an optional disclosure if desired, using the same unchanged registered title and DOI; do not invent authors or legal terms.

### Existing Stats route

Apply the common logo, colors, type, focus treatment, metadata and footer. Keep it out of public navigation. It is not private merely because it is unlisted. Exported markup must not include private analytics tokens, operator-specific account navigation or personal setup instructions. Existing genuinely public download counts can remain, with their source and loading/error/empty states; do not turn them into unverified user or install counts. No new analytics feature or authentication system is requested.

## Brand and metadata handoff

Use the existing logo artwork without redrawing, stretching, recoloring individual strokes or changing the outer halo opacity. Header mark is 34×34; the home link name carries its meaning, so the SVG is decorative. Light mode uses dark ink; dark mode uses the original near-white ink. Maintain at least half a mark width of clear space around standalone usage. Do not use the full launcher plate as the tiny header mark.

| Page | Title | Description |
| --- | --- | --- |
| Home | Embodent — Your AI team, with you in charge | Bring Claude Code and Codex agents together around a shared objective. Follow their work, answer questions, and review results in one place. |
| Installation | Install Embodent | Get Embodent for Mac with Apple Silicon and set up your first agent project. |
| Usage | Using Embodent | Organize workflows, set task approval requirements, and follow your agents' work. |
| Open source | Open source — Embodent | Explore the Embodent source project, licenses and published Orcha citation. |

Canonical URLs use `https://openorcha.io` and the existing route. Theme-color follows the resolved page background. Use the provided Halo E favicon/app-touch exports and the 1200×630 social preview; `og:image` must be an absolute public URL and have an informative alternative. Use `summary_large_image` for the social card. The rebrand notice is visible text, not metadata-only. No domain change or redirect to a new brand domain is proposed.

## Delivery boundary

Use latest `main` of `Quantal-Labs-AI/orcha-website` in a fresh worktree for implementation; the old local website checkout has unrelated/stale edits and stays untouched. Keep release values centralized. Merging that repository's main branch auto-deploys, so WebsiteAgent supplies a local preview for Kedar's approval before the publication task. This design handoff does not change workflow dependencies or authorize a merge. The implementation and publication tasks remain separate from Dana's design task.

Before final acceptance, inspect the checked screens and `review-notes.md`, address both reviewers' findings, and request Kedar's task verification. Until then this package remains a draft.
