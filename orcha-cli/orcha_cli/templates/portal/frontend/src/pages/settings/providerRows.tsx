/**
 * Models & providers — the Orca "Agents" row style (image 33) for Settings.
 *
 *  - ProviderRow: one provider / runtime per row — brand logo tile, name, a
 *    mono detail line (masked key, launch command), an optional "Default"
 *    badge, a docs link and an expand chevron that reveals the row's existing
 *    controls. The panel stays MOUNTED while collapsed (`hidden`), so a typed
 *    draft is never lost by collapsing.
 *  - RuntimesGroup: the agent runtimes the worker actually launches
 *    (GET /api/models `runtime` + `reasoning_efforts`, GET /api/reasoning-efforts).
 *    Read-only here: an agent's model and effort are chosen per agent.
 *
 * No Enabled|Disabled control and no "Set default" button: the backend has no
 * per-provider enable flag and no settable default provider/runtime — the
 * "Default" badge only reports the shipped default (DEFAULT_MODEL /
 * use-case default_provider), never an invented state.
 *
 * Vendor facts (binary, install command, docs URL) were verified 2026-09-29:
 *  - Claude Code: binary `claude` (npm view @anthropic-ai/claude-code bin →
 *    {claude}); install `curl -fsSL https://claude.ai/install.sh | bash`
 *    ("Native Install (Recommended)") and docs URL from
 *    https://code.claude.com/docs/en/overview.
 *  - Codex CLI: binary `codex` (npm view @openai/codex bin → {codex});
 *    install `npm install -g @openai/codex` from github.com/openai/codex
 *    README; docs https://learn.chatgpt.com/docs/codex/cli (the 308 target of
 *    developers.openai.com/codex/cli).
 *  - Anthropic API: https://platform.claude.com/docs/en/api/overview (301
 *    target of docs.anthropic.com/en/api/overview; keys at
 *    platform.claude.com/settings/keys).
 *  - xAI API: https://docs.x.ai/overview (308 target of docs.x.ai/docs/overview,
 *    "Grok API Documentation").
 *  - OpenAI API: https://developers.openai.com/api/docs (301 target of
 *    platform.openai.com/docs).
 *  - Gemini API: https://ai.google.dev/gemini-api/docs (200).
 * The launch commands mirror notifier_headless.py (the headless worker argv):
 * `claude … --dangerously-skip-permissions` / `codex exec
 * --dangerously-bypass-approvals-and-sandbox`.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { getJSON } from "../../api/client";
import { Icon } from "../../components/ui";
import { Button, Chip, Tooltip } from "../../components/primitives";
import { BrandLogo } from "../../components/primitives/BrandLogo";
import { SettingsGroup, StatusLine } from "./settingsUi";

/* ---- vendor facts (verified — see header) --------------------------------- */
export const PROVIDER_DOCS: Record<string, string> = {
  anthropic: "https://platform.claude.com/docs/en/api/overview",
  xai: "https://docs.x.ai/overview",
  openai: "https://developers.openai.com/api/docs",
  gemini: "https://ai.google.dev/gemini-api/docs",
};

export interface RuntimeInfo {
  name: string;
  /** the command Orcha's headless worker launches (notifier_headless.py) */
  command: string;
  install: string;
  docs: string;
}
export const RUNTIME_INFO: Record<string, RuntimeInfo> = {
  claude: {
    name: "Claude Code",
    command: "claude --dangerously-skip-permissions",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    docs: "https://code.claude.com/docs/en/overview",
  },
  codex: {
    name: "Codex",
    command: "codex exec --dangerously-bypass-approvals-and-sandbox",
    install: "npm install -g @openai/codex",
    docs: "https://learn.chatgpt.com/docs/codex/cli",
  },
};

/* ---- the row --------------------------------------------------------------- */
export function DefaultBadge({ tip }: { tip: string }) {
  return (
    <Tooltip label={tip}>
      <span className="mp-default" tabIndex={0} aria-label={"Default — " + tip}>
        <Icon name="check" cls="" />
        Default
      </span>
    </Tooltip>
  );
}

export function ProviderRow({
  id, brand, name, detail, detailTitle, detailTone, badge, docsHref, children, dimmed, defaultOpen = false,
}: {
  /** data-provider hook (provider / runtime id) */
  id: string;
  brand: string;
  name: string;
  detail: ReactNode;
  /** full text of the detail line (it ellipsizes on narrow widths) */
  detailTitle?: string;
  detailTone?: "warn" | "muted";
  badge?: ReactNode;
  docsHref?: string | null;
  /** the expandable panel; none = no chevron */
  children?: ReactNode;
  dimmed?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const expandable = children != null && children !== false;
  return (
    <div className={"mp-row" + (open ? " is-open" : "") + (dimmed ? " is-dim" : "")} data-provider={id}>
      <div className="mp-row-head">
        <span className="mp-tile"><BrandLogo brand={brand} name={name} size={18} /></span>
        <div
          className={"mp-row-main" + (expandable ? " is-toggle" : "")}
          onClick={expandable ? () => setOpen((o) => !o) : undefined}
        >
          <div className="mp-row-name">{name}</div>
          <div className={"mp-row-detail" + (detailTone ? " is-" + detailTone : "")} title={detailTitle}>{detail}</div>
        </div>
        <div className="mp-row-acts">
          {badge}
          {docsHref ? (
            <Tooltip label={name + " docs"}>
              <a className="mp-icon-btn" href={docsHref} target="_blank" rel="noreferrer noopener" aria-label={"Open " + name + " docs"}>
                <Icon name="ext" cls="" />
              </a>
            </Tooltip>
          ) : null}
          {expandable ? (
            <button
              type="button"
              className="mp-icon-btn mp-chev"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={(open ? "Hide " : "Show ") + name + " settings"}
              onClick={() => setOpen((o) => !o)}
            >
              <Icon name="chev" cls="" />
            </button>
          ) : null}
        </div>
      </div>
      {expandable ? (
        <div className="mp-row-panel" id={panelId} hidden={!open} role="region" aria-label={name + " settings"}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Mono detail line for a key status: "sk-…abcd · Stored encrypted". */
export function KeyDetail({ mode, masked }: { mode: "db" | "env" | "none"; masked: string | null }) {
  if (mode === "none") return <span className="mp-detail-t">No API key</span>;
  return (
    <>
      <code className="mp-mono">{masked || "sk-…"}</code>
      <span className="mp-detail-t">
        {" · "}
        {mode === "env" ? <>set via <code className="mp-mono">ORCHA_LLM_API_KEY</code></> : "stored encrypted"}
      </span>
    </>
  );
}

/* ---- agent runtimes --------------------------------------------------------- */
export interface RuntimeModel {
  id: string;
  name?: string;
  runtime?: string;
  reasoning_efforts?: string[];
}
export interface EffortInfo {
  id: string;
  name: string;
}
export interface RuntimeGroupVM {
  runtime: string;
  models: RuntimeModel[];
  isDefault: boolean;
}

/** Group /api/models rows by runtime, server order; the default model marks its runtime. */
export function groupRuntimes(models: RuntimeModel[], defaultId: string | null): RuntimeGroupVM[] {
  const out: RuntimeGroupVM[] = [];
  for (const m of models) {
    const rt = m.runtime || "claude";
    let g = out.find((x) => x.runtime === rt);
    if (!g) {
      g = { runtime: rt, models: [], isDefault: false };
      out.push(g);
    }
    g.models.push(m);
    if (defaultId && m.id === defaultId) g.isDefault = true;
  }
  return out;
}

export function RuntimesGroup() {
  const [models, setModels] = useState<RuntimeModel[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [efforts, setEfforts] = useState<EffortInfo[]>([]);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    setErr(false);
    try {
      const d = await getJSON<{ models?: RuntimeModel[]; default?: string }>("/api/models");
      if (!d || !Array.isArray(d.models)) throw new Error("bad catalog");
      setModels(d.models.filter((m) => m && typeof m.id === "string"));
      setDefaultId(typeof d.default === "string" ? d.default : null);
    } catch {
      setModels(null);
      setErr(true);
      return;
    }
    try {
      const e = await getJSON<{ efforts?: EffortInfo[] }>("/api/reasoning-efforts");
      setEfforts(Array.isArray(e?.efforts) ? e!.efforts! : []);
    } catch {
      setEfforts([]); // labels fall back to the raw ids
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = models ? groupRuntimes(models, defaultId) : [];
  const effortName = (id: string) => efforts.find((e) => e.id === id)?.name || id;

  return (
    <SettingsGroup
      settab="provider-keys"
      title="Agent runtimes"
      lead="The coding-agent CLIs Embodent launches for your agents."
      help="Each agent's model and effort are chosen on the agent's Configuration tab; this list is what the worker supports."
      action={models ? <Chip size="sm">{groups.length + (groups.length === 1 ? " runtime" : " runtimes")}</Chip> : undefined}
      flush
      className="mp-group"
    >
      <div id="runtimeRows" className="mp-list">
        {err ? (
          <div className="mp-pad">
            <StatusLine
              tone="err"
              action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void load()}>Retry</Button>}
            >
              Couldn&#39;t load the agent runtimes.
            </StatusLine>
          </div>
        ) : !models ? (
          <div className="mp-pad"><StatusLine tone="muted">Loading runtimes…</StatusLine></div>
        ) : (
          groups.map((g) => {
            const info = RUNTIME_INFO[g.runtime];
            const name = info ? info.name : g.runtime;
            return (
              <ProviderRow
                key={g.runtime}
                id={g.runtime}
                brand={g.runtime}
                name={name}
                detailTitle={info ? info.command : undefined}
                detail={info ? <code className="mp-mono">{info.command}</code> : <span className="mp-detail-t">{g.models.length} models</span>}
                badge={g.isDefault ? <DefaultBadge tip="New agents start on this runtime's default model" /> : null}
                docsHref={info ? info.docs : null}
              >
                <ul className="mp-models" aria-label={name + " models"}>
                  {g.models.map((m) => (
                    <li key={m.id} className="mp-model">
                      <span className="mp-model-n">{m.name || m.id}</span>
                      <code className="mp-mono mp-model-id">{m.id}</code>
                      {m.id === defaultId ? <span className="mp-tag">Default</span> : null}
                      <span className="mp-model-eff">
                        {m.reasoning_efforts && m.reasoning_efforts.length
                          ? "Effort: " + m.reasoning_efforts.map(effortName).join(" · ")
                          : "No effort levels"}
                      </span>
                    </li>
                  ))}
                </ul>
                {info ? (
                  <div className="mp-install">
                    <span className="mp-install-l">Install</span>
                    <code className="mp-mono">{info.install}</code>
                  </div>
                ) : null}
              </ProviderRow>
            );
          })
        )}
      </div>
    </SettingsGroup>
  );
}
