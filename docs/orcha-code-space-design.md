# Orcha Code Space — design (Fable, 2026-08-05)

> The codebase becomes the collaboration surface. Humans and agents meet ON the
> code: line-anchored threads with agent tagging and one-click question
> templates ("How does this work?", "Why this decision?", "Teach me this
> concept"), a live view of code as agents write it with checkpoint-honest
> raise-hand interruptions, language intelligence via a plugin framework, and a
> learning library distilled from the threads. Read + annotate + watch —
> **humans never edit here** (agents edit; humans direct). That constraint is
> what keeps this an orchestration surface instead of a doomed IDE project.

## Where it lives

Cloud-first: the code source is the GitHub App integration (cloud-only), so
Code Space ships in orcha-cloud. The anchor/thread data model and the viewer
components carry no GitHub-specific assumptions beyond "content addressed by
(repo, sha, path)" — the documented upstream path is: when open Orcha grows a
code source (local git read-only), the thread model and UI lift as-is.

## Surface

Full-page route `/code` with its own sidebar nav entry (**Code Space**), three
panes: directory tree | code viewer | thread rail. The GitHub page's embedded
browser stays for PR-context browsing; Code Space is the standalone home.
Deep links: `/code?ref=&path=&line=&thread=`.

## Phase 1 — line-anchored threads (the foundation)

- **Anchor** = `(repo, sha, path, start_line, end_line)`. Threads pin to the
  sha resolved at creation. Honesty over magic: viewing the file at a ref
  whose blob differs marks the thread **outdated — pinned to <sha7>** with a
  jump-to-pinned-sha link. (Cross-sha hunk remapping is future work; a wrong
  silent re-anchor is worse than an honest "outdated".)
- **One conversation, two views**: tagging @agent creates a directed request
  through the existing request/wake rails; the anchor + question + reply
  instructions render into the wake prompt (auto-routing precedent). The
  agent's reply lands in the thread AND rides the normal request lifecycle —
  no second conversation system.
- Question templates set `kind`: `question | why | teach | note`; `teach`
  threads feed Phase 4.

### Data (migration 045)
```sql
code_threads(id, container_id, repo, ref, sha, path, start_line, end_line,
             kind, status open|answered|resolved, created_by_agent_id,
             tagged_agent_id NULL, request_id NULL, created_at, updated_at)
code_thread_messages(id, thread_id, author_agent_id NULL, is_human,
                     body, created_at)
```

### API (portal_backend/code_space_routes.py)
- `POST /api/containers/{cid}/code/threads` `{ref,path,start_line,end_line,
  kind,body,tagged_agent_id?,actor_agent_id}` → resolves sha, creates thread +
  first message; if tagged → directed request (payload embeds anchor + body +
  "reply via POST /api/code/threads/{id}/messages") + wake nudge.
- `GET /api/containers/{cid}/code/threads?ref=&path=&status=` → threads (+
  per-file counts when no path; `blob_match` computed against the requested
  ref via the browse blob-sha cache).
- `GET /api/code/threads/{tid}` → thread + messages.
- `POST /api/code/threads/{tid}/messages` `{body,actor_agent_id,resolve?}` →
  append; the tagged agent's first reply flips status→answered; humans may
  resolve. Membership-gated like every code route.

## Phase 2 — live code + raise-hand

No new agent-side instrumentation: the run stream ALREADY carries Edit/Write/
MultiEdit tool calls with file paths and patches. Code Space's **Live** panel
parses them out of the existing classified stream — pick an active run, watch
its file edits paint as patch cards in real time, click through to the file.
**Raise-hand** = a line-anchored thread tagged at the running agent; the UX
says honestly: *"queued — the agent addresses this at its next checkpoint"*
(turn-based engine; no fake debugger-pause).

## Phase 3 — language intelligence (plugin framework)

Plugin = manifest `{id, languages, capabilities}` + a provider. Ships with
**built-in symbol provider**: server-side regex/definition indexer (Kotlin,
Swift, TS/JS, Python, Go) over the cached recursive tree + on-demand file
fetches — `GET .../code/symbols?ref=&q=` (workspace symbol search) and
`GET .../code/outline?ref=&path=` (file outline); frontend: outline rail,
go-to-symbol, identifier click → definition candidates. **LSP adapters** are
the documented second provider type (kotlin-language-server/sourcekit-lsp/
tsserver as sandbox sidecars) — deliberately NOT run on the 4GB dogfood box;
the adapter interface lands now, the fleet lands with real resource planning.

## Phase 4 — learning library

`teach`/`why` threads are durable, anchored knowledge. A **Learn** tab in Code
Space aggregates them: filter by path/kind/agent, grouped by file, full thread
reading view. This is the classroom identity; digest/tour integrations come
after real usage shapes them.

## Non-goals (v1)

Human editing, CRDT/co-editing, cross-sha hunk remapping, LSP server fleet,
review-request workflows (PRs already own that).

## Build process

Designed by Fable; built by cheaper models against these frozen contracts in
parallel waves; Fable reviews every diff, integrates, tests, deploys.
