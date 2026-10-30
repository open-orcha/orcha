# Native browser text-zoom check — still outstanding

Prepared by Dana for Kedar · 30 October 2026 · Design revision 3

The design is not cleared for final verification yet. Its navigation click-area correction passed, but the approved 200% native browser text-zoom check needs an observed result. This is a design-stage requirement, not work deferred to WebsiteAgent.

## Why the check remains open

The saved Chromium checks enlarge font styles programmatically. They are useful stress tests, but they do not operate a browser's native zoom control. Safari loaded the current local prototype and exposed View → Make Text Bigger; a screenshot attempt returned “Screenshot unavailable.” No native zoom action was performed. A dedicated Chrome local-file tab then received a browser URL-policy rejection. Dana stopped that browser-check path rather than trying an indirect URL or alternate browser-control method.

This is an evidence gap, not a demonstrated layout failure. The 43 passing checks in `validation.json` do not include a passing native browser zoom check.

## Observation needed before final design clearance

Open `preview.html` with its adjacent CSS and assets in a browser you control. Record the browser/version and the native zoom method and displayed percentage. Increase text to 200% using browser controls; state explicitly whether that is text-only zoom or whole-page browser zoom. Do not inject font-size styles or count device emulation as native zoom.

Check Home, Installation, Usage and Open source in dark and light appearance. At desktop and a narrow browser window, read from header through footer and confirm that:

- Navigation, page titles, body text, controls and status labels stay visible and do not overlap or clip.
- The page does not require horizontal scrolling to read ordinary text.
- The menu, appearance selector, guide section links and command-copy controls remain reachable by keyboard, with a visible focus outline.
- Enlarged command text and the approval-setting table remain readable.

Record any failure with its page, window width, theme and affected element. Return the observations to Dana; any required fixes must be applied and checked before both review results return through CodeCleanupAgent. Kedar's final task verification remains a separate step.
