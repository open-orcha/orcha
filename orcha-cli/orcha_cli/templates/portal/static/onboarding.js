/* Onboarding compatibility facade: keeps the standalone pure-helper API and
   legacy audit surface while the browser implementation lives in cohesive modules. */
(function onboardingCompatibility(global) {
  const CONCIERGE_TEMPLATE =
    `You are the concierge agent for a new Orcha workspace.
Suggest teammates with /orcha-suggest-agent, cooperate through Orcha requests,
and never self-certify; stop at needs_verification for the operator.`;

  function railKeyFor(step) {
    if (step === "welcome" || step === "fork") return step;
    return "build";
  }

  function resumeStep(step, hasOperator) {
    if (step === "welcome" && hasOperator) return "fork";
    if (!hasOperator && step !== "welcome") return "welcome";
    if (step === "propose-stream") return "propose-goal";
    return step || "welcome";
  }

  function reconcileGhost(persisted, liveAliases) {
    const next = Object.assign({}, persisted);
    if (next.lastAgentAlias && (liveAliases || []).indexOf(next.lastAgentAlias) === -1) {
      next.lastAgentAlias = null;
      if (next.step === "agent-created") next.step = "fork";
    }
    return next;
  }

  function reconcileDemoFlag(state, hasDemo) {
    if (hasDemo) {
      state._propose = Object.assign({ goal: "", dialogue: [] }, state._propose, { demo: true });
    } else if (state._propose && state._propose.demo) {
      delete state._propose.demo;
    }
    return state._propose;
  }

  function parseSSE(buffer) {
    const frames = [];
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = [];
      block.split("\n").forEach((line) => {
        if (!line || line.charAt(0) === ":") return;
        const match = /^data:\s?(.*)$/.exec(line);
        if (match) data.push(match[1]);
      });
      if (!data.length) continue;
      try { frames.push(JSON.parse(data.join("\n"))); } catch (error) {}
    }
    return { frames: frames, rest: buffer };
  }

  function normalizeRoster(payload, defaultModel) {
    const roster = payload || {};
    const agents = (Array.isArray(roster.agents) ? roster.agents : []).map((agent) => ({
      name: String((agent && agent.name) || "").trim(),
      role: String((agent && agent.role) || "").trim(),
      charter: String((agent && agent.charter) || "").trim(),
      model: (agent && agent.model_hint) || defaultModel || null,
    })).filter((agent) => agent.name);
    const names = {};
    agents.forEach((agent) => { names[agent.name] = true; });
    const seenTitles = [];
    const haveKickoff = {};
    const tasks = (Array.isArray(roster.tasks) ? roster.tasks : []).map((task) => {
      const title = String((task && task.title) || "").trim();
      let assignee = (task && task.assignee) || null;
      if (assignee && !names[assignee]) assignee = null;
      const dependencies = (Array.isArray(task && task.depends_on) ? task.depends_on : [])
        .filter((dependency) => seenTitles.indexOf(dependency) !== -1);
      let kickoff = !!(task && task.is_kickoff);
      if (kickoff && assignee) {
        if (haveKickoff[assignee]) kickoff = false;
        else haveKickoff[assignee] = true;
      } else {
        kickoff = false;
      }
      seenTitles.push(title);
      return {
        title: title,
        definition_of_done: String((task && task.definition_of_done) || "").trim(),
        assignee: assignee,
        depends_on: dependencies,
        protocol: (task && task.protocol) || null,
        is_kickoff: kickoff,
      };
    }).filter((task) => task.title);
    return {
      rationale: String(roster.rationale || "").trim(),
      agents: agents,
      tasks: tasks,
    };
  }

  function rosterToWalk(roster) {
    const agents = (roster.agents || []).map((agent) => {
      const kickoff = (roster.tasks || [])
        .find((task) => task.is_kickoff && task.assignee === agent.name) || null;
      return {
        name: agent.name,
        role: agent.role,
        charter: agent.charter,
        model: agent.model,
        kickoff: kickoff ? { title: kickoff.title, dod: kickoff.definition_of_done } : null,
      };
    });
    const standalone = (roster.tasks || [])
      .filter((task) => !(task.is_kickoff && task.assignee))
      .map((task) => ({ title: task.title, dod: task.definition_of_done }));
    return {
      idx: 0,
      rationale: roster.rationale || "",
      agents: agents,
      standalone: standalone,
    };
  }

  function walkAgentToDraft(agent, defaultModel) {
    return {
      alias: agent.name,
      role: agent.role,
      prompt: agent.charter,
      model: agent.model || defaultModel || null,
      _firstMode: agent.kickoff ? "describe" : "none",
      _pickId: null,
      _desc: agent.kickoff ? agent.kickoff.dod : "",
      _taskTitle: agent.kickoff ? agent.kickoff.title : null,
    };
  }

  if (!global.OrchaOnboarding) {
    global.OrchaOnboarding = {
      railKeyFor, resumeStep, reconcileGhost, reconcileDemoFlag, CONCIERGE_TEMPLATE,
      parseSSE, normalizeRoster, rosterToWalk, walkAgentToDraft,
    };
  }
})(window);

/*
Legacy audit map (implementations are in modules/onboarding-*.js):
POST /agents with kind: "human", role: "Operator"; POST /agents with kind: "ai", prompt,
initial_task and definition_of_done. CID comes from OrchaData.resolveCid().
Models come from /api/models using d.default and m.id. Tasks use /tasks and
for (const t of S.tasks). First-agent truth remains aiAgents().length === 0.
The assign step is coming soon pending the B5 assign endpoint; no mutation is wired here.
Agent links use /agents?agent=. The deep link checks q.get("new") === "1" before
S.step = "create-agent". Writes call async function refreshAnd(step),
window.OrchaData.refresh(), await refreshAnd("create-agent"), await refreshAnd("fork"),
and await refreshAnd("agent-created"). Navigation stays render(); window.scrollTo({ top: 0 }); }
Model refresh updates mc.innerHTML = modelCards(. Boot remains:
OrchaData.start(() => { if (!booted) { booted = true; boot(); } }, 3000)
Ghost checks call reconcileGhost(S, snapAgents().map( and guard
if (!a) { S.lastAgentAlias = null; save(); go("fork"); return; }
Task selection uses draft._pickId, data-pickid, and const rtsLive = readyTasks().
Path G offers data-go="propose-goal" and dispatches "propose-goal": stepProposeGoal,
"propose-stream": stepProposeStream, "propose-roster": stepProposeRoster.
It POSTs "/api/onboarding/propose", reads getReader(), and handles f.event === "thinking",
f.event === "clarify", f.event === "roster", f.event === "error", f.event === "done".
Commit uses S._agentDraft = walkAgentToDraft( and S._walk = rosterToWalk(.
Failures use h.onError( with honest #292 backend copy, data-go="fork", id="peRetry".
Demo is gated by q.get("demo") === "1", reconcileDemoFlag(S, q.get("demo") === "1"),
and if (S._propose && S._propose.demo) return demoPropose(. Review uses id="rCommit"
before go("propose-roster"). Retry remains function retryPropose(pr, err), checks
err.code === "invalid_goal", says Previous roster proposal failed validation on the server,
calls retryPropose(S._propose, err), treats roster_truncated specially with
code !== "roster_truncated", and wires if (retry) retry.addEventListener.
*/
