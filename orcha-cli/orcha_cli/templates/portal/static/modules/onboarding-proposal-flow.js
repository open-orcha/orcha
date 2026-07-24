/* Onboarding flow module: goal capture, streamed proposal, clarification, errors, and demo fallback. */
/* ====================================================================== */
/*  PATH G — AI roster proposal (goal → stream → editable roster → walk)    */
/* ====================================================================== */

/* ---- G1 · describe the goal ------------------------------------------ */
function stepProposeGoal(main) {
  const pr = S._propose || (S._propose = { goal: "", dialogue: [] });
  main.innerHTML = `<div class="ob">
    <div class="form-h">
      <span class="fic">${OnbIcon("spark", "")}</span>
      <div><h2>Tell me what you're building</h2>
      <p>One or two sentences is plenty. I'll propose a starting team — agents with system prompts and their first tasks — for you to review and edit. Nothing is created until you approve it.</p></div>
    </div>
    <div class="card pad">
      <div class="field2" style="margin-bottom:6px">
        <div class="lab">Your project goal <span class="req">*</span></div>
        <textarea class="txa" id="gGoal" rows="4" placeholder="e.g. Improve my app's onboarding — I want fewer drop-offs on first run and a clearer first-task experience.">${OnbEsc(pr.goal)}</textarea>
        <div class="hint">Vague is fine — I may ask 1–3 quick questions to narrow it before proposing.</div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn ghost" data-go="fork">Back</button>
      <span class="grow"></span>
      <span class="note">I propose; you decide. You can edit everything next.</span>
      <button class="btn" id="gGo">${OnbIcon("spark", "")}Propose my roster</button>
    </div>
  </div>`;
  const ta = document.getElementById("gGoal");
  ta.addEventListener("input", (e) => { pr.goal = e.target.value; ta.style.borderColor = ""; save(); });
  document.getElementById("gGo").addEventListener("click", () => {
    const g = (ta.value || "").trim();
    if (!g) { ta.focus(); ta.style.borderColor = "var(--danger-line)"; return; }
    pr.goal = g; pr.dialogue = []; save();
    go("propose-stream");
  });
  wireGo(main);
  setTimeout(() => ta && ta.focus(), 60);
}

/* ---- G2 · stream the proposal (thinking → clarify | roster | error) --- */
function stepProposeStream(main) {
  const pr = S._propose || (S._propose = { goal: "", dialogue: [] });
  if (!pr.goal) { go("propose-goal"); return; }

  main.innerHTML = `<div class="ob propose">
    <div class="form-h">
      <span class="fic">${OnbIcon("spark", "")}</span>
      <div><h2>Designing your roster…</h2>
      <p class="gp-goal">“${OnbEsc(O.trunc(pr.goal, 160))}”</p></div>
    </div>
    <div class="card pad">
      <div class="thinking" id="pThink">
        <div class="th-h">${OnbIcon("live", "")}<span>Thinking</span><span class="dots"><i></i><i></i><i></i></span></div>
        <pre class="th-body" id="pThinkBody"></pre>
      </div>
      <div id="pTurn"></div>
    </div>
    <div class="form-actions">
      <button class="btn ghost" id="pStop">${OnbIcon("stop", "")}Stop</button>
      <span class="grow"></span>
      <span class="note">Streaming from the onboarding model</span>
    </div>
  </div>`;

  const thinkBody = document.getElementById("pThinkBody");
  const turn = document.getElementById("pTurn");
  let acc = "";
  const finishThinking = () => { const t = document.getElementById("pThink"); if (t) t.classList.add("done"); };

  document.getElementById("pStop").addEventListener("click", () => { go("propose-goal"); });

  _proposeAbort = startPropose({ cid: CID, goal: pr.goal, dialogue: pr.dialogue || [] }, {
    onThinking: (d) => { acc += d; if (thinkBody) { thinkBody.textContent = acc; thinkBody.scrollTop = thinkBody.scrollHeight; } },
    onClarify: (questions) => { finishThinking(); renderClarify(turn, pr, questions); },
    onRoster: (payload) => { S._roster = normalizeRoster(payload, DEFAULT_MODEL); save(); go("propose-roster"); },
    onError: (err) => { finishThinking(); renderError(turn, err); },
  });
}

const ERR_COPY = {
  no_api_key: "No model API key is configured for this workspace yet. Add one in Settings, or set the team up by hand.",
  model_error: "The model couldn't be reached just now. Retry, or set the team up by hand.",
  invalid_goal: "I couldn't work with that goal — try describing the project a little more concretely.",
  rate_limited: "The model is rate-limited right now. Give it a moment and retry, or set up by hand.",
  roster_truncated: "The roster was too large to finish. Narrow the first team in your goal, then try again, or set it up by hand.",
};
function renderClarify(turn, pr, questions) {
  const qs = (questions || []).slice(0, 3);
  turn.innerHTML = `<div class="clarify">
    <div class="cl-h">${OnbIcon("requests", "")}<span>A couple of quick questions</span></div>
    ${qs.map((q) => `<div class="field2" style="margin-bottom:13px">
      <div class="lab">${OnbEsc(q.prompt)}</div>
      <input class="ipt" data-qid="${OnbEsc(q.id || "")}" data-qprompt="${OnbEsc(q.prompt || "")}" placeholder="Your answer — or leave blank" autocomplete="off"></div>`).join("")}
    <div class="cl-actions">
      <button class="btn subtle" id="clSkip">Skip — just propose</button>
      <button class="btn" id="clGo">${OnbIcon("arrow", "")}Continue</button>
    </div>
  </div>`;
  const collect = () => {
    turn.querySelectorAll("[data-qid]").forEach((el) => {
      const a = (el.value || "").trim();
      pr.dialogue.push({ role: "assistant", content: el.dataset.qprompt });
      pr.dialogue.push({ role: "user", content: a || "(no preference)" });
    });
    save();
  };
  document.getElementById("clGo").addEventListener("click", () => { collect(); go("propose-stream"); });
  document.getElementById("clSkip").addEventListener("click", () => {
    pr.dialogue.push({ role: "user", content: "(skip clarifying — propose your best roster now)" }); save();
    go("propose-stream");
  });
}
function renderError(turn, err) {
  const code = (err && err.code) || "model_error";
  const msg = (err && err.message) || ERR_COPY[code] || ERR_COPY.model_error;
  const retryable = code !== "roster_truncated";
  turn.innerHTML = `<div class="perror">
    <div class="pe-h">${OnbIcon("shield", "")}<span>Couldn't propose a roster</span></div>
    <p>${OnbEsc(msg)}</p>
    <div class="pe-actions">
      ${retryable ? `<button class="btn subtle" id="peRetry">${OnbIcon("refresh", "")}Retry</button>` : ""}
      <a class="btn ghost" data-go="propose-goal">Edit goal</a>
      <a class="btn ghost" data-go="fork">Set up by hand instead</a>
    </div>
  </div>`;
  const retry = document.getElementById("peRetry");
  if (retry) retry.addEventListener("click", () => retryPropose(S._propose, err));
  wireGo(turn);
}

function retryPropose(pr, err) {
  if (pr && err && err.code === "invalid_goal" && err.message) {
    pr.dialogue = pr.dialogue || [];
    pr.dialogue.push({ role: "user", content: "(Previous roster proposal failed validation on the server: " + err.message + ". Please revise the roster and avoid that issue.)" });
    save();
  }
  go("propose-stream");
}

// Open the SSE stream (fetch + ReadableStream — EventSource is GET-only, the contract is
// POST+SSE). Fails OPEN: any transport/HTTP failure (incl. a 404 because #292 isn't
// deployed) surfaces as an honest `error` turn that keeps the manual lanes usable.
// Returns an abort() the step calls on navigation. ?demo=1 swaps in a client-side stub.
function startPropose(body, h) {
  if (S._propose && S._propose.demo) return demoPropose(body, h);
  const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  let stopped = false;
  (async function pump() {
    let resp;
    try {
      resp = await fetch(PROPOSE_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      if (!stopped) h.onError({ code: "model_error", message: "Couldn't reach the server. Check the workspace is running, then retry." });
      return;
    }
    if (!resp.ok || !resp.body || !resp.body.getReader) {
      if (!stopped) h.onError({ code: "model_error",
        message: "The AI propose endpoint isn't available (" + resp.status + "). The #292 backend may not be deployed yet — you can set up by hand." });
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!stopped) {
      let r;
      try { r = await reader.read(); } catch (e) { break; }
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const parsed = parseSSE(buf); buf = parsed.rest;
      for (let i = 0; i < parsed.frames.length; i++) {
        if (stopped) return;
        const f = parsed.frames[i];
        if (f.event === "thinking") h.onThinking(f.delta || "");
        else if (f.event === "clarify") h.onClarify(f.questions || []);
        else if (f.event === "roster") { h.onRoster(f); return; }
        else if (f.event === "error") { h.onError(f); return; }
        else if (f.event === "done") return;
      }
    }
  })();
  return function abort() { stopped = true; if (ctrl) try { ctrl.abort(); } catch (e) {} };
}

// DEV-ONLY (?demo=1): synthesize a stream so the whole lane is exercisable before the
// #292 backend lands. Never the default path — gated on S._propose.demo.
function demoPropose(body, h) {
  let stopped = false;
  const goal = body.goal || "your project";
  const deltas = ["Reading your goal…\n", "Sketching the smallest team that can own it…\n",
    "A concierge to plan + delegate, plus a builder to execute…\n", "Writing first tasks with clear definitions of done…\n"];
  let i = 0;
  const tick = () => {
    if (stopped) return;
    if (i < deltas.length) { h.onThinking(deltas[i++]); setTimeout(tick, 260); return; }
    h.onRoster({
      event: "roster",
      rationale: "A concierge to plan and delegate, plus one builder to execute the first slice — the smallest team that can move “" + O.trunc(goal, 60) + "” forward.",
      agents: [
        { name: "Atlas", role: "Concierge · planning & orchestration", charter: CONCIERGE_TEMPLATE, model_hint: DEFAULT_MODEL },
        { name: "Forge", role: "Builder · implementation", charter: "You are a builder agent. Take a task with a clear definition of done, implement it, and stop at needs_verification for the operator to verify. Cooperate with teammates via /orcha-ask; never self-certify.", model_hint: DEFAULT_MODEL },
      ],
      tasks: [
        { title: "Map the current onboarding flow", definition_of_done: "A written breakdown of every first-run step and where users drop off, approved by the operator.", assignee: "Atlas", depends_on: [], protocol: null, is_kickoff: true },
        { title: "Ship the highest-impact fix", definition_of_done: "The top drop-off point from the map is fixed and verified in the running app.", assignee: "Forge", depends_on: ["Map the current onboarding flow"], protocol: null, is_kickoff: true },
      ],
    });
  };
  setTimeout(tick, 200);
  return function abort() { stopped = true; };
}
