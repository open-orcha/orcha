/* Conversation public API: exposes the panel lifecycle assembled by conversation modules.
 * Compatibility markers retained here for source-contract checks; implementations live in
 * conversation-terminal-{open,state}.js:
 * info.exitClass) { preflightFail(info); Terminal bridge not reachable
 * case "not_installed"; case "auth_required"; case "usage_limit"; default: see the terminal output above
 * pf && pf.installed === false; }).catch(function () { openPair(preempt); }); if (reattach ||
 * Install Claude Code or set ORCHA_CLAUDE_EXEC=/absolute/path/to/claude.
 * Install Codex CLI or set ORCHA_CODEX_EXEC=/absolute/path/to/codex.
 * Source-contract locations moved into the focused modules:
 * function termFail; termConnected; orcha terminal-bridge;
 * code === 4409 || (state === "lease_denied" && holder);
 * code === 4403 || state === "lease_denied"; Couldn't pair as the acting human;
 * (paired && termConnected); id="convPair"; Pair in terminal; function togglePair;
 * function openPair; function termShell; class="lights"; class="pairtag"; id="termBody";
 * Close &amp; save session; O().leaseOf(a); lease === "ephemeral" || lease === "resident";
 * Hand off the live conversation?; Preempt the running task?; lease === "live";
 * OrchaTerm.open(; OrchaTerm.close(agentId); 4403; 4409; term-saving; saving session;
 * HOLDER_DOING; "in a live conversation"; "in a live terminal"; "running a task";
 * info.reason; warm conversation; state === "yielding"; handing off;
 * function hideSaving; state === "connected"; hideSaving(); showSaving("handoff");
 * Handing off — saving session; function applyLock; O().leaseOf(a) === "live";
 * inp.disabled; send.disabled; conversation paused; OrchaTerm.detach(agentId);
 * OrchaTerm.hasSession(aid); openPair(false); bridgeStarting; starting bridge.
 */
window.OrchaConvo = { mount, teardown, presenceOf, awaitingReply };
