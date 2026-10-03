-- HUMAN TEXT vs AGENT INSTRUCTIONS on a request (migration 065).
--
-- A code-thread question (Code › Learn / "Ask") opens a directed request to the tagged agent.
-- Until now the request's `payload` WAS the agent's wake text:
--   [code thread — teach] local@8cf5234 deploy/docker-compose.yml:1-1
--   <the question>
--   <LESSON_FORMAT_GUIDE with <lesson title> placeholders>
--   reply via POST /api/code/threads/<id>/messages with your agent id as actor_agent_id
--   view/reply in the portal: /code?path=…&thread=…
-- and every human surface (request detail, Needs you, push, Slack) rendered all of it.
--
--   * requests.agent_payload (nullable TEXT): the full text addressed to the TARGET AGENT when
--     it differs from `payload`. Agent read paths (request_created wake preview, /inbox,
--     /outbox, /rehydrate, nudges) deliver it; people only ever see `payload`. NULL = the agent
--     reads `payload`, i.e. every request that isn't a code-thread question is unchanged.
--   * Backfill: code-thread requests stored with the old combined text keep that text verbatim
--     as agent_payload (the agent's view is byte-identical), `payload` becomes the question (the
--     thread's opening message — the exact words the person typed), and `detail.code_thread`
--     carries the thread id/anchor/link so the portal renders "Open thread in Code". The portal
--     derives the display title for these rows (lib/requestText.ts); new rows also store
--     detail.display_title (code_space_routes.code_thread_request_detail).
--
-- ADD-only column + an idempotent, row-scoped backfill (guarded by agent_payload IS NULL).

ALTER TABLE requests ADD COLUMN IF NOT EXISTS agent_payload TEXT;

UPDATE requests r
   SET agent_payload = r.payload,
       payload = LEFT(
           COALESCE(
               NULLIF(btrim((SELECT m.body FROM code_thread_messages m
                              WHERE m.thread_id = t.id
                              ORDER BY m.created_at ASC, m.id ASC
                              LIMIT 1)), ''),
               r.payload
           ),
           4000
       ),
       detail = COALESCE(r.detail, '{}'::jsonb) || jsonb_build_object(
           'code_thread', jsonb_build_object(
               'thread_id', t.id::text,
               'kind', t.kind,
               'repo', t.repo,
               'sha', t.sha,
               'path', t.path,
               'start_line', t.start_line,
               'end_line', t.end_line,
               'link', COALESCE(
                   substring(r.payload FROM 'view/reply in the portal: (/code\?[^[:space:]]+)'),
                   '/code?path=' || t.path || '&thread=' || t.id::text
               )
           )
       )
  FROM code_threads t
 WHERE t.request_id = r.id
   AND r.agent_payload IS NULL
   AND r.payload LIKE '[code thread — %';
