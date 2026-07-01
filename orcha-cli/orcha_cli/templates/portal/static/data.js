/* ============================================================================
   Orcha portal — D1 live data adapter.
   Replaces the mock data.js: fetches the real FastAPI snapshot, maps it to the
   component shape the design pages read (container, agents+byAlias, tasks,
   requests), mutates window.ORCHA IN PLACE (via Orcha.applySnapshot), and
   re-renders on the 3s cadence. The pages stay thin — they read window.ORCHA and
   render with the shared helpers; only the data SOURCE lives here.
   Missing/not-yet-available fields fall back to null/[] so pages show "—", never
   `undefined`. plan (D7), runs (separate /runs fetch / D6) degrade gracefully.
   ========================================================================== */
window.OrchaData = (function () {
  const Q = (typeof location !== "undefined") ? new URLSearchParams(location.search) : new URLSearchParams("");

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " → " + r.status);
    return r.json();
  }

  function aliasFor(agents, id) {
    if (id == null) return null;
    const a = (agents || []).find((x) => String(x.id) === String(id));
    return a ? a.alias : null;
  }

  // map a raw task_messages[] array (snapshot legacy OR the GET /tasks/{tid}/messages endpoint)
  // to the page thread shape. Shared by mapSnapshot and the lazy threadOf() fetch.
  function mapThread(messages, agents) {
    return (messages || []).map((m) => ({
      id: m.message_id, is_human: !!m.is_human,
      // #271: a NULL-author row (a legacy post, or a 'system' post) is NOT a human and has no
      // resolvable author — surface it through the neutral 'system' render path (msgRow treats a
      // falsy/'system' `from` as a system message: › avatar, "system" label, never a named agent).
      // Only a real attributed AI author keeps its alias.
      from: m.is_human ? "human" : (m.author_id ? (m.author_alias || aliasFor(agents, m.author_id) || "—") : "system"),
      body: m.body, at: m.created_at,
      // #301: per-message file attachments (path/metadata refs; never bytes). The adapter DROPS
      // un-mapped fields, so whitelist it explicitly. Each: {id,name,size,content_type,kind,url}.
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
    }));
  }

  // ISS-68: lazy-fetch a task's FULL thread on detail-expand (the snapshot only carries a
  // message_summary now). Returns the mapped thread; pages cache it on the task object.
  async function threadOf(tid) {
    const d = await getJSON("/api/tasks/" + encodeURIComponent(tid) + "/messages");
    const agents = (window.ORCHA && window.ORCHA.agents) || [];
    return mapThread(d.messages, agents);
  }

  // Approval–diff binding: the task's reviewable diff + its binding digest
  // ({task_id, diff_digest, runs:[{run_id, agent_id, started_at, diff}]}). The verify
  // gate renders exactly this and echoes diff_digest back on approve, so the approval
  // is bound to the diff the human actually saw.
  async function diffOf(tid) {
    return getJSON("/api/tasks/" + encodeURIComponent(tid) + "/diff");
  }

  // pure: raw FastAPI snapshot ({container, agents, tasks, requests}) -> component shape.
  function mapSnapshot(raw) {
    raw = raw || {};
    const agents = (raw.agents || []).map((a) => ({
      id: a.id, alias: a.alias, kind: a.kind, role: a.role || "—",
      model: a.model != null ? a.model : null,
      status: a.status,
      // §3b/E1 (#141): the agent's single-flight EMBODIMENT — idle|ephemeral|resident|live.
      // Drives the S3 terminal guard + the conversation live-lock (Orcha.leaseOf).
      embodiment: a.embodiment != null ? a.embodiment : null,
      wake_enabled: a.wake_enabled != null ? a.wake_enabled : null,
      // #300: clock-driven AUTO-WAKE cadence in seconds (null = off). Surfaced by the
      // snapshot (main.py: a.auto_wake_interval_secs) so the agent Controls card can render
      // and edit it; whitelisted here or the adapter would drop it (control reads undefined→Off).
      auto_wake_interval_secs: a.auto_wake_interval_secs != null ? a.auto_wake_interval_secs : null,
      // #81: LEFT(system_prompt,160) — an inline persona preview on the agent view;
      // the FULL system_prompt is lazy-fetched from GET /api/agents/{id}/persona on expand.
      prompt_preview: a.prompt_preview != null ? a.prompt_preview : null,
      last_active: a.last_active || a.updated_at || null,
      // D7 ships current_task as {task_id, title}; passed through here, else derived below.
      current_task: a.current_task != null ? a.current_task : null,
      // #340: the agent's LIVE worker run (gated on a live lease server-side). The activity
      // label is DRIVEN off this (task title when it's a task, else a plain-language wake-event
      // label); current_task is only the fallback when no run is live. Carries task_title so a
      // task run labels directly without depending on current_task matching.
      // Shape: {run_id, wake_event, wake_kind, runtime, task_id, task_title, has_conversation, started_at}|null.
      active_run: a.active_run != null ? a.active_run : null,
    }));
    const byAlias = Object.fromEntries(agents.map((a) => [a.alias, a]));

    const tasks = (raw.tasks || []).map((t) => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority,
      assignees: t.assignees || [],
      assignee: (t.assignees || [])[0] || null,
      description: t.description || "",
      definition_of_done: t.definition_of_done || "",
      // SPEC-4: per-task hand-off protocol (Ledger: tasks.protocol JSONB, surfaced via the shared
      // _task_list_sql). null when unset. Whitelisted here so the adapter doesn't drop it.
      protocol: t.protocol != null ? t.protocol : null,
      result: t.result != null ? t.result : null,
      // D7: latest plan_approval decision {decision, reason, actor, at}; null pre-D7. The
      // plan TEXT itself is the agent's opening thread message — this is the durable
      // "already decided" signal so the approval card stops re-asking (ISS-41 / B10 P2).
      plan_decision: t.plan_decision != null ? t.plan_decision : null,
      // D7 ships `runs` as a SUMMARY object {count, latest{...}} — not the per-run array.
      // Keep `runs` for the full feed (D6 /runs fetch) and surface the summary separately
      // so a summary object is never mistaken for the array.
      runs: Array.isArray(t.runs) ? t.runs : [],
      runs_summary: (t.runs && typeof t.runs === "object" && !Array.isArray(t.runs)) ? t.runs : null,
      is_root: !!t.is_root,
      created_by: aliasFor(agents, t.created_by_agent_id) || "human",
      created_at: t.created_at, started_at: t.started_at || null, completed_at: t.completed_at || null,
      // ISS-68: the snapshot no longer ships the full thread (~277KB/poll). It carries a compact
      // `message_summary` {count, last} for cards/feeds + `plan_message` (latest agent note) so the
      // approval card renders thread-free. The FULL thread is lazy-fetched on detail-expand via
      // OrchaData.threadOf(tid). `thread` stays defined (empty) so existing readers never see undefined.
      message_summary: t.message_summary || { count: 0, last: null },
      plan_message: t.plan_message || null,
      thread: mapThread(t.messages, agents),   // [] under the trimmed snapshot; populated by threadOf()
    }));

    const requests = (raw.requests || []).map((r) => ({
      id: r.id, type: r.type, status: r.status, priority: r.priority,
      // keep the raw ids alongside the resolved aliases — shell helpers + deep-links
      // still classify/look up by id (dropping them made every open request look
      // human-targeted; D1 review).
      requester_id: r.requester_id, target_id: r.target_id,
      from: aliasFor(agents, r.requester_id) || "human",
      to: aliasFor(agents, r.target_id) || "human",     // null target -> the human authority
      payload: r.payload,
      response: r.response != null ? r.response : null,
      rejection_reason: r.rejection_reason != null ? r.rejection_reason : null,
      in_service_of: r.parent_request_id || null,       // chain parent
      chain_depth: r.chain_depth || 0,
      // D7 resolves task_link to {task_id, title, status}; pre-D7 a minimal {task_id}.
      task_link: r.task_link || (r.spawned_task_id ? { task_id: r.spawned_task_id } : null),
      escalated: r.status === "escalated",
      created_at: r.created_at, responded_at: r.responded_at || null, expires_at: r.expires_at || null,
    }));

    // derive each agent's current task only when D7 didn't supply one — same shape
    // ({task_id, title} | null) either way so pages read it uniformly.
    agents.forEach((a) => {
      if (a.current_task != null) return;               // D7 provided it
      const cur = tasks.find((t) => t.status === "in_progress" && (t.assignees || []).indexOf(a.alias) >= 0);
      a.current_task = cur ? { task_id: cur.id, title: cur.title } : null;
    });

    return { container: raw.container || null, agents, byAlias, tasks, requests };
  }

  // 1:1:1 auto-resolve: ?cid= wins, else the sole/active container.
  async function resolveCid() {
    const q = Q.get("cid");
    if (q) return q;
    const list = await getJSON("/api/containers");
    const arr = Array.isArray(list) ? list : (list.containers || []);
    const active = arr.find((c) => c.status === "active") || arr[0];
    return active ? active.id : null;
  }

  let _cid = null;
  async function refresh() {
    if (!_cid) _cid = await resolveCid();
    if (!_cid) throw new Error("no container found");
    const raw = await getJSON("/api/containers/" + encodeURIComponent(_cid));
    if (window.Orcha) window.Orcha.applySnapshot(mapSnapshot(raw));
    else window.ORCHA = mapSnapshot(raw);
    return window.ORCHA;
  }

  // initial load + 3s poll; render() repaints the page (use Orcha.patch so the
  // re-render never jumps scroll or clobbers a text selection — ISS-46).
  function start(render, ms) {
    const tick = () => refresh()
      .then(() => { if (render) render(); })
      .catch((e) => { if (window.Orcha) window.Orcha.toast("Load error: " + e.message, "danger"); });
    tick();
    if (typeof setInterval !== "undefined") setInterval(tick, ms || 3000);
    // D6: live-push. Subscribe to the container event stream so escalations / decisions /
    // suggestions surface SUB-SECOND instead of waiting up to `ms`. The 3s poll stays as the
    // fallback (and covers changes the stream doesn't emit — e.g. a brand-new plan turn,
    // which still appears within one poll, ISS-52). The browser auto-reconnects the
    // EventSource; a burst of events coalesces into one refresh.
    startEventStream(render);
  }

  let _es = null, _pending = false, _evCursor = null;
  function startEventStream(render) {
    if (typeof EventSource === "undefined") return;
    const connect = () => {
      if (!_cid) { if (typeof setTimeout !== "undefined") setTimeout(connect, 1000); return; }  // await cid from the first tick
      // Seed at the latest event we've consumed, else "now" — so we react ONLY to NEW events
      // and NEVER replay the durable container history on connect/reconnect (review P1). The
      // 3s poll covers any gap from clock skew. We manage reconnect ourselves so since_ts
      // always advances (a raw EventSource auto-retries the SAME stale url).
      if (_evCursor == null) _evCursor = (typeof Date !== "undefined" ? Date.now() / 1000 : 0);
      let es;
      try { es = new EventSource("/api/containers/" + encodeURIComponent(_cid) + "/events?since_ts=" + _evCursor); }
      catch (e) { return; }
      _es = es;
      es.onmessage = (ev) => {
        let ts = null; try { ts = JSON.parse(ev.data).ts; } catch (e) {}
        if (ts != null) _evCursor = ts;    // advance so a reconnect resumes, never replays
        if (_pending) return;              // coalesce a burst into one refresh
        _pending = true;
        setTimeout(() => { _pending = false; refresh().then(() => { if (render) render(); }).catch(() => {}); }, 150);
      };
      es.onerror = () => {                  // close + reopen from the cursor (not the stale url)
        try { es.close(); } catch (e) {}
        if (typeof setTimeout !== "undefined") setTimeout(connect, 3000);
      };
    };
    connect();
  }

  return { mapSnapshot, resolveCid, refresh, start, startEventStream, aliasFor, mapThread, threadOf, diffOf, _cidOf: () => _cid };
})();
