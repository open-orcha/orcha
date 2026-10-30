# Component inventory and interaction states

Design revision 2 · Shared website components · Values in `tokens.json` / `tokens.css`

This inventory is for the public website. It does not replace Dana's separate mobile design charter or add product actions to the website. All website actions are links, disclosure, appearance choice or copying text.

| Component | Structure / sizing | States and behavior |
| --- | --- | --- |
| Brand home link | 34 px Halo E; 12 px gap; 23 px wordmark (22 px phone); minimum 44 px target | Original 50% halo; near-white dark mode, dark ink light mode. Accessible name `Embodent home`; mark itself decorative. Hover does not animate logo. Focus ring surrounds link. |
| Primary link button | Indigo fill, white label, 6 px corners, minimum 48 px height, 20 px horizontal padding; 15/22 px label | Default `#5E6AD2`; hover from mapped theme token; pressed 1 px shift; 3 px focus outline + 4 px offset. Destination remains an anchor. Never indicate install completion after a download click. |
| Secondary link button | Transparent surface; readable outline; same height/radius as primary | Surface hover; focus ring; underlines reserved for ordinary text links. Unavailable destination replaced by explanation and a useful alternative, not a dead control. |
| Text link | Accent text; underline and minimum 44 px height for standalone links | Default / hover / focus. Inline prose links preserve underline; don't stretch paragraph line-height just to fake separate targets. External navigation stays in the current tab unless explicitly labeled otherwise. |
| Desktop navigation | 88 px header; 14 px links; 28 px gaps | Current page uses `aria-current=page` plus text/underline. Menu button absent. Links stay real URLs with browser Back/Forward support. |
| Phone navigation | 76 px header; Menu/Close button; full-width inline disclosure | Closed removes links from tab order. Open pushes content down, preserves page scroll and normal focus order. Escape closes and returns focus. No modal trap/backdrop. Resize to desktop restores links. |
| Appearance | Visible label + native select, at least 44 px tall | Dark / Light / System; stored site preference; dark first visit. System follows live OS change. Pre-paint resolution; storage unavailable keeps working for this page. Native keyboard interaction and selected-state semantics. |
| Section index | Desktop sticky list at 28 px offset; phone `details` disclosure | Links point to actual headings. Expand/collapse uses native keyboard behavior. Section anchor scroll has sufficient top clearance. It does not steal focus on scrolling. |
| Product example frame | 10 px corners; panel surface; thin decorative border; 24 px desktop padding / 16 px phone | Static illustration, labeled as an example. No product mutation controls or loading skeleton. Real text remains accessible, including names, status and decision. Never imply a live connection. |
| Illustrated task row | Status glyph, title, owner, status label; 14/22 px title | Needs approval = amber ring with dot + words; Waiting = dashed neutral ring + words. Status wraps below title on phone. Noninteractive: no button role, focus target or hover highlight. |
| Illustrated agent | 24 px initial circle + role label | Invented role names; initial decorative to avoid duplicate announcement. No real avatars or private project data. |
| Decision notice | 2 px semantic edge; soft amber background; 16 px padding | Human-decision example says Autonomy OFF. Neutral explanation, visible label and title. No approve button on the public page. Status never depends on color alone. |
| Download panel | 10 px corners; 28 px padding / 20 px phone; platform and version above action | Available: exact platform + current release. Unavailable: text explanation + View releases. Static build-time determination; no fake busy spinner or client-side release polling. |
| Command / citation block | 6 px corners; panel fill; 16 px padding; 14/23 px monospace | Copy button has specific accessible name. Success announces “Command copied.” or “Citation copied.” in a persistent polite status area. Failure says select and copy manually. Keep focus on Copy; no intrusive toast or execution. Copy area reserves 20 px feedback space to reduce layout shift. |
| Guide disclosure | Native `details` / `summary`; summary at least 44 px tall | Standard keyboard interaction and expanded state; content readable if JS fails. Reset/recovery explanation precedes any external reference. No destructive command in this version. |
| Inline information | 2 px accent edge, soft surface and textual title | Guidance, not a warning unless information is actually consequential. Data-loss guidance precedes recovery actions. Semantic label plus content; do not use a color-only icon. |
| Media placeholder / recovery | If optional video is later included, reserve the frame's aspect ratio and keep the text explanation | Loading: poster visible, “Loading product tour…” announced once if playback requested. Ready: native Play controls, no autoplay. Error: “The product tour couldn’t load” + Read the usage guide. No-video state: static illustration and text, as delivered. Reduced motion always leaves the static view usable. |
| Footer | 32–40 px vertical padding; source/legal links; rebrand sentence | Wrap links on phone, maintain target sizes and focus order. Preserve project credit. Does not add Stats to public navigation. |

## Accessibility and resilience contract

- All body text targets at least 4.5:1 contrast; large text 3:1. UI boundary/focus indicators carrying meaning target 3:1. Decorative dividers may be quieter. Supplied token validation reports exact measured pairs.
- One H1 per page; heading order remains meaningful. The illustration's heading is an H2 on Home; on Usage it must be subordinate to the Workflows H2 (use H3 and subordinate decision heading in implementation). The visual sizes remain unchanged.
- Accessible names are visible where practical. Use native select, button, link and details rather than custom roles. Status feedback uses polite live announcements; no announcements on initial static render.
- At narrow widths and text zoom, allow content to grow. A 320 CSS-pixel viewport is a reflow check, not proof of every browser's 400% zoom behavior. Validate actual browser zoom and a screen reader in implementation.
- With script disabled, a production Astro page still renders its page content and links, uses the dark theme, and leaves navigation visible. The design prototype uses script-selected templates for compact offline review and is not the production rendering strategy.
- Font loading uses `swap` and a system sans fallback. Avoid layouts measured to a single font width. Keep a fixed-size logo box to avoid header shift if an image is delayed.
- Missing product media must never hide the explanation or Get started action. No login, API access or laptop connectivity is required to read the public site. An unreachable laptop is a product-client state, not a public marketing-site error.
- The existing Stats route's loading state reserves the statistic area and labels what is loading; empty data reads “No release downloads reported”; failure reads “Download counts couldn’t load” with a release-page link. Never show a failed lookup as zero downloads. Private analytics details are omitted from public markup.

## Export and imagery rules

The assets are existing project artwork copied without alteration. `logo-mark.svg` is for dark backgrounds; `logo-mark-mono.svg` uses currentColor when embedded inline. For `<img>` usage in light mode, generate a fixed-ink derivative or use the provided inline path with the theme's ink; CSS on an `<img>` cannot set currentColor inside an external SVG.

| Asset | Size / use |
| --- | --- |
| `favicon.svg` | Existing scalable app favicon |
| `favicon-16.png`, `favicon-32.png` | Browser raster fallbacks, 16×16 and 32×32 |
| `apple-touch-icon.png` | 180×180 Apple touch icon |
| `icon-192.png`, `icon-512.png` | Existing 192×192 and 512×512 exports; retain only where the site needs them |
| `icon.svg`, `icon.png` | Existing launcher source/export; 1024×1024 PNG, not a new mobile launcher design |
| `logo-mark.svg`, `logo-mark-mono.svg` | Existing Halo E vectors; preserve aspect ratio and 50% outer halo |
| `social-preview.png` | 1200×630; static announcement and homepage headline, readable at thumbnail size |
| `inter-var-opsz-latin.woff2`, `inter-var-opsz-latin-ext.woff2` | Existing licensed Inter Variable; ship matching OFL notice |

`OFL-inter.txt` and `LICENSE-project.txt` accompany the assets. The header/product drawing is native HTML/SVG using the existing mark; no AI-generated replacement logo or stock imagery is required.
