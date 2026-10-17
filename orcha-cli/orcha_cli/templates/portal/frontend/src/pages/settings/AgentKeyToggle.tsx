/**
 * "Use for agent runs" — the per-provider opt-in that bills this project's
 * agent runs to its stored API key instead of a Claude/ChatGPT subscription
 * (migration 071). Rendered inside the Anthropic and OpenAI key rows only:
 *   anthropic → Claude Code runs (ANTHROPIC_API_KEY)
 *   openai    → Codex runs      (CODEX_API_KEY + OPENAI_API_KEY)
 *
 * Wire contract (portal_backend/provider_key_routes.py, in /openapi.json):
 *   GET …/settings/provider-keys  -> {keys:[{provider, stored, use_for_agents, agent_runtime, …}]}
 *   PUT …/settings/provider-keys/{provider}/agent-use {use_for_agents, actor_agent_id}
 * Same gate as storing the key (owner or manage_keys, human actor). Needs a key
 * stored on the project — the env override is never handed to agents.
 *
 * The row hands in the state it already loaded (the Anthropic card from its
 * llm-key GET, every other row from the provider-keys GET) — no extra request.
 */
import { useEffect, useId, useState } from "react";
import { sendJSON } from "../../api/client";
import { Tooltip } from "../../components/primitives";
import { useToast } from "../../components/ui";
import { useGrantAuthority } from "./grantAuthority";
import { settingsErrText } from "./settingsUi";
import "./agentKeyToggle.css";

export const AGENT_KEY_TITLE = "Use for agent runs";
export const AGENT_KEY_CAPTION =
  "Agents on this project bill this API key instead of a Claude/ChatGPT subscription.";

const RUNTIME_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

/** The "no key yet" line for a provider's key row. */
export function providerUnsetCopy(provider: string): string {
  if (provider === "openai") return "Add one to run Codex agents on the OpenAI API instead of a ChatGPT subscription.";
  return "Use-cases on this provider stay off until you add one.";
}

/** Providers whose key can stand in for an agent runtime's subscription. */
export const AGENT_KEY_RUNTIME: Record<string, "claude" | "codex"> = { anthropic: "claude", openai: "codex" };

export interface AgentKeyEntry {
  provider: string;
  stored?: boolean;
  use_for_agents?: boolean;
  agent_runtime?: string | null;
}

/** The agent-run slice of a key GET (llm-key or provider-keys row); null when the portal is too
 *  old to report it (no agent_runtime) — the row then shows no switch. */
export function agentEntryOf(
  provider: string,
  data: { stored?: boolean; use_for_agents?: boolean; agent_runtime?: string | null } | null | undefined,
): AgentKeyEntry | null {
  if (!data || !data.agent_runtime) return null;
  return {
    provider,
    stored: !!data.stored,
    use_for_agents: !!data.use_for_agents,
    agent_runtime: data.agent_runtime,
  };
}

/** Pure view-state (tested): what the row says and whether the switch may move. */
export function agentKeyView(entry: AgentKeyEntry | null, canWrite: boolean): {
  on: boolean;
  runtimeName: string;
  disabledReason: string | null;
  stateText: string;
} {
  const runtime = (entry && entry.agent_runtime) || (entry ? AGENT_KEY_RUNTIME[entry.provider] : undefined) || "";
  const runtimeName = RUNTIME_NAME[runtime] || "Agent";
  const on = !!(entry && entry.use_for_agents);
  const stored = !!(entry && entry.stored);
  const disabledReason = !stored && !on ? "Save a key on this project first." : !canWrite ? "locked" : null;
  const stateText = on
    ? "On — " + runtimeName + " runs on this project bill this API key."
    : "Off — " + runtimeName + " runs use the CLI's own Claude/ChatGPT login.";
  return { on, runtimeName, disabledReason, stateText };
}

export function AgentKeyToggle({
  cid,
  provider,
  entry: entryIn,
}: {
  cid: string | null;
  provider: string;
  /** the row's loaded key state (stored / use_for_agents / agent_runtime); null while loading */
  entry: AgentKeyEntry | null;
}) {
  const toast = useToast();
  const auth = useGrantAuthority("manage_keys");
  const [onLocal, setOnLocal] = useState<boolean | null>(null); // the PUT's answer until the row reloads
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const descId = useId();

  // a fresh server state for the row wins over the local answer
  useEffect(() => { setOnLocal(null); }, [entryIn?.use_for_agents, entryIn?.stored]);

  // Only where the backend says this key can serve an agent runtime (an older portal omits
  // agent_runtime and has no agent-use route — no switch then).
  if (!AGENT_KEY_RUNTIME[provider] || !entryIn || !entryIn.agent_runtime) return null;
  const entry: AgentKeyEntry = { ...entryIn, provider, use_for_agents: onLocal ?? !!entryIn.use_for_agents };

  const view = agentKeyView(entry, auth.can);
  const blocked = view.disabledReason != null;

  const flip = async () => {
    if (busy || !cid) return;
    if (view.disabledReason && view.disabledReason !== "locked") {
      toast(view.disabledReason, "warn");
      return;
    }
    if (!auth.can || !auth.human) {
      toast(auth.reason || "Pick an acting human to change this", "warn");
      return;
    }
    const next = !view.on;
    setBusy(true);
    try {
      const res = await sendJSON<{ use_for_agents?: boolean }>(
        "PUT",
        "/api/containers/" + encodeURIComponent(cid) + "/settings/provider-keys/" +
          encodeURIComponent(provider) + "/agent-use",
        { use_for_agents: next, actor_agent_id: auth.human.id },
      );
      const now = res && typeof res.use_for_agents === "boolean" ? res.use_for_agents : next;
      setOnLocal(now);
      toast(
        now
          ? view.runtimeName + " agent runs now bill this API key."
          : view.runtimeName + " agent runs are back on the CLI's own login.",
        "ok",
      );
    } catch (e) {
      toast("Couldn't change agent billing — " + settingsErrText(e) + ".", "danger");
    }
    setBusy(false);
  };

  const sw = (
    <button
      type="button"
      role="switch"
      id={"ak-switch-" + provider}
      className={"set-switch" + (view.on ? " on" : "") + (blocked ? " is-locked" : "")}
      aria-checked={view.on}
      aria-labelledby={titleId}
      aria-describedby={descId}
      aria-busy={busy || undefined}
      aria-disabled={blocked || undefined}
      disabled={busy}
      onClick={() => void flip()}
    >
      <span className="set-switch-knob" />
    </button>
  );
  const tip = view.disabledReason === "locked" ? auth.reason : view.disabledReason;

  return (
    <div className={"ak-row" + (view.on ? " is-on" : "")} data-provider={provider} data-agent-key={view.on ? "on" : "off"}>
      <div className="ak-main">
        <div className="ak-title" id={titleId}>{AGENT_KEY_TITLE}</div>
        <div className="ak-desc" id={descId}>{AGENT_KEY_CAPTION}</div>
        <div className={"ak-state" + (view.on ? " is-on" : "")} role="status">
          {view.stateText}
        </div>
      </div>
      {tip ? <Tooltip label={tip} placement="left">{sw}</Tooltip> : sw}
    </div>
  );
}
