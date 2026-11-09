# Mobile comments: Show more / Show less (GH #378)

Picture: `renders/gallery-full.png` (from `comments.html`; open the HTML in a browser to inspect).
Status: approved by Kedar on the Orcha task (2026-11-09) and built in PR #424, with one change noted below
(the Verify sheet).

## Where it applies (iOS and Android)

| Surface | Today | After |
|---|---|---|
| Task page, Activity feed, each comment | cut at 5 lines | shared component |
| Task page, "Awaiting your verification" card, Result | cut at 6 lines | shared component |
| Verify sheet, Result | iOS cut at 12 lines; Android full | full result on both, no control (see below) |

Change from the approved picture: the Verify sheet shows the whole result on both platforms instead of a
collapsible one. The sheet is where you read the result before accepting or rejecting it, and Android already
showed it in full, so there is nothing to expand.

Unchanged: the full thread screen, GitHub issue comments and chat bubbles (never cut), and the
"Plan waiting for approval" card (a 4-line preview with its own Review plan button).

## The six states

1. **Short comment**: fits in 6 lines, so there is no control.
2. **Long comment, collapsed**: 6 lines ending in an ellipsis; **Show more** with a down chevron on its own line below,
   full-width touch target (44 pt iOS, 48 dp Android). Pressed: dimmed on iOS, ripple on Android.
3. **Long comment, expanded**: the full stored comment, expanded in place with a short height animation
   (no animation with Reduce Motion / animations off). **Show less** with an up chevron at the end. The header does not move.
4. **Formatted content and attachments**: the thread's renderer (bold, inline code, links, @mentions, task chips,
   list lines, line breaks). Links and chips are tappable in both states. Attachment chips, once mobile shows them
   (follow-up issue #423), sit outside the collapse.
5. **Very large comment** (up to the 4,000-character comment cap, or a long task result): collapsing a comment whose
   header has scrolled above the screen scrolls just enough to put that header at the top.
6. **Dynamic Type and narrow screens**: still 6 lines, so fewer words. The control scales, wraps instead of
   truncating, and stays on screen. Long unbroken URLs and hashes break at any character. Keyboard / switch-access focus ring.

## Behaviour rules

- Show the control only when the text really overflows 6 lines at the current width and text size (measured layout,
  never a character count). Re-measure when the width or text size changes.
- Expanded state is keyed by comment id and lives as long as the task page (a trip to the Runs tab and back keeps it),
  so recycled rows never inherit it.
- Screen readers: the comment (author, time, text) is one element; the control is its own button,
  labelled "Show more" / "Show less", with state "Collapsed" / "Expanded".
