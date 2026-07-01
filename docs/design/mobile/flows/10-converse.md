# Flow 10 — Converse with an agent

Mockups: [`../mockups/10-converse.html`](../mockups/10-converse.html)

> **Status: ships against the existing API.** The conversation store is live (the portal's S1 panel
> already builds on it) — every endpoint below is in `/openapi.json` today. The only deliberate gap
> is attachments: the API has them (`POST /api/conversations/{conv_id}/attachments`), **mobile v1
> does not** — the composer is text-only and the paperclip is a v2 line item (doc 13).

## 1. Story

The user opens an agent — Dana, say — and talks to her like a chat thread. Sending a message wakes
the agent: she reads the turn, works (possibly for a minute or more), and replies with her own turn.
It is **turn-based, not token-streamed**: the honest mental model is "message a busy colleague",
not "watch a chatbot type". The UI's job is to make the waiting legible — *is she working on my
message, or busy with a task and my message is queued?* — exactly the distinction the backend's
presence contract draws for the portal.

## 2. Entry points

- **Agent detail (flow 09):** primary **Converse** button — the main path.
- **Home tab agents-glance:** tapping the chat affordance on an agent chip.
- **Deep link:** `orcha://container/{cid}/agents/{aid}/chat`.

Opening the screen resumes the **active** conversation if one exists
(`GET /api/agents/{aid}/conversation` returns the conversation + recent turns); otherwise the screen
opens empty and the conversation is created lazily on first send
(`POST /api/agents/{aid}/conversations {actor_agent_id}` — get-or-create, idempotent). The actor is
always the paired human's agent id from the pairing payload (flow 03).

## 3. Screens & states (mockup frames)

| Frame | State | Notes |
|---|---|---|
| C1 | Conversation — iOS dark | mixed human/agent turns, working indicator (pulsing dots + "Dana is working…" caption) |
| C2 | Conversation — Android light | same anatomy, M3 chrome; agent turn carries a **work log** link → Run detail (flow 06) |
| C3 | Fresh conversation | empty state + hint chips ("What are you working on?") that prefill the composer |
| C4 | Agent busy | banner: "Dana is working on a task — she'll reply when she wraps up her current step"; sent turn shows an honest **queued** notice, never fake typing |
| C5 | Turn send failed | bubble keeps the text, marked "Not sent — tap to retry" |
| C6 | End conversation confirm | iOS `confirmationDialog`; framed as "Dana goes back to her own work" |
| C7 | Transcript loading | skeleton bubbles mirroring the chat layout |
| C8 | Container unreachable | danger banner, cached transcript readable, composer disabled (no offline queue in v1, doc 02 §4) |
| C9 | Conversation ended | dashed system bubble; composer swaps to "Start a new conversation" |

## 4. Behavior

### Transcript

- **Initial load:** `GET /api/agents/{aid}/conversation?limit=50` → conversation meta + the most
  recent turns + `presence`/`presence_reason`. Render newest at the bottom, scrolled to the bottom.
- **Live updates:** while the workspace SSE stream (`GET /api/containers/{cid}/events`) is
  connected, a conversation event triggers a delta fetch
  `GET /api/conversations/{conv_id}/turns?after_seq={lastSeq}` (append, never reload — same contract
  the portal uses). Polling fallback: same delta call every 5s when SSE is down. The long-poll
  `GET /api/agents/{aid}/wait` also exists and may serve a future low-power mode; v1 uses SSE+poll.
- **Older turns (scroll-up):** the server has **no before-cursor** on `/turns` (known portal
  limitation). v1 mirrors the portal: keep the fetched window in memory, reveal older turns from it
  as the user scrolls up; when the top of the window is reached, re-fetch
  `GET /api/agents/{aid}/conversation?limit={2×N}` and splice. A proper `before_seq` cursor is filed
  as an *optional* backend ask in doc 13.
- **Turn metadata:** every bubble shows a time (relative <24h, `HH:MM` otherwise); agent turns show
  the agent name; agent turns carrying a `run_id` render a "work log" link → Run detail (flow 06).

### Sending

- `POST /api/conversations/{conv_id}/turns {role:"human", author_agent_id:<paired human id>,
  content}` — preceded by the get-or-create if the screen opened empty. Optimistic append; the
  bubble confirms on 2xx.
- **Pending indicator (honesty rule, same as portal):** after the human's turn, until the agent's
  reply lands, show an indicator keyed off `presence`:
  - `working` / `waking` (or the optimistic gap right after send) → **pulsing-dots bubble** with
    caption "Dana is working…".
  - `busy` (agent holds a task lease; the message is queued) → **queued notice**, using
    `presence_reason` verbatim when present. Never show fake "typing" while the agent is on a task.
- **Send failure** (non-2xx / network): the bubble stays with its text, marked
  "Not sent — tap to retry" (tap re-POSTs; long-press → Copy text / Delete). Nothing is queued in
  the background.
- **Draft persistence:** the composer draft is kept per-agent across navigation (portal parity,
  ISS-64) and cleared on successful send.

### Lifecycle

- **Resume:** reopening the screen with an active conversation continues it in place — no "new
  chat" concept; one active conversation per agent.
- **Agent busy on entry:** if the agent is mid-task, the transcript still opens and the composer
  works; a persistent banner sets expectations (frame C4). Sending is allowed — the turn queues.
- **End conversation:** overflow menu → "End conversation" → confirm (frame C6, copy: *"She'll go
  back to her own work. The transcript stays here."*) → `POST /api/conversations/{conv_id}/end` →
  dashed system bubble "Conversation ended", composer replaced by **Start a new conversation**
  (which is just the get-or-create again).
- **Attachments — v2:** the API's `attachments` field on turn POST and the conversation-scoped
  upload route exist today; mobile v1 deliberately ships **text-only** (no paperclip, no drop
  targets) to keep the launch surface small. Deferred to v2 in doc 13.

## 5. Platform notes

- **Android:** pushed destination in the Agents (or Home) back stack; M3 top app bar with the
  agent's avatar + presence pill, overflow menu (End conversation). Composer uses an M3 text field
  pinned above the IME (`imePadding`); send is a filled icon button. Queued/busy banner is a
  persistent surface under the app bar, not a snackbar.
- **iOS:** pushed in the tab's `NavigationStack`, inline title bar with avatar + presence; overflow
  is an ellipsis `Menu`. End-conversation confirm is a `confirmationDialog` (action sheet). Keyboard
  avoidance is standard; swipe-down on the transcript dismisses the keyboard.
- **Both:** bubbles per foundations (radius 16 / tail 6): human turns right in accent
  (`.bubble.mine`), agent turns left on surface with the agent name (`.bubble.theirs`), system
  events centered dashed (`.bubble.system`). Day dividers between calendar days. Status is never
  color-only: presence pills carry their word.

## 6. Endpoints used

| Action | Endpoint | Status |
|---|---|---|
| Start (get-or-create) conversation | `POST /api/agents/{aid}/conversations` `{actor_agent_id}` | exists |
| Resume active conversation + recent turns + presence | `GET /api/agents/{aid}/conversation?limit=N` | exists |
| Delta-fetch new turns | `GET /api/conversations/{conv_id}/turns?after_seq=S&limit=N` | exists |
| Send a human turn | `POST /api/conversations/{conv_id}/turns` `{role:"human", author_agent_id, content}` | exists |
| End conversation | `POST /api/conversations/{conv_id}/end` | exists |
| Live turn updates | SSE `GET /api/containers/{cid}/events` (long-poll `GET /api/agents/{aid}/wait` also exists) | exists |
| Attachments upload | `POST /api/conversations/{conv_id}/attachments` | exists — **mobile v2** |
| Older-turns cursor (`before_seq`) | — | optional ask, doc 13 |
