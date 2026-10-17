/**
 * AgentFilter — the Activity "agent" filter as a Linear filter chip (review:
 * the 200 px native <select> read as a form control). A rounded-full 28 px
 * chip ("All agents ⌄" / "◉ lead ⌄") that opens a Popover menu of round
 * avatars; the current choice is a checked `menuitemradio`. ↑/↓/Home/End move
 * through the items, Enter/Space picks, Escape closes (Popover) and returns
 * focus to the chip. An agent named in the URL but missing from this project
 * stays visible as its own "(not in this project)" choice — never silently
 * dropped (truthful data, brief §3).
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Avatar, Popover } from "../../components/primitives";
import { Icon } from "../../components/ui";
import type { Agent } from "../../types";

export interface AgentFilterProps {
  agents: Agent[];
  /** the selected alias (URL value), or null for "All agents" */
  value: string | null;
  /** true when `value` names no agent in this project */
  missing?: boolean;
  onChange: (alias: string | null) => void;
}

function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let j = -1;
  if (e.key === "ArrowDown") j = (i + 1) % items.length;
  else if (e.key === "ArrowUp") j = (i - 1 + items.length) % items.length;
  else if (e.key === "Home") j = 0;
  else if (e.key === "End") j = items.length - 1;
  if (j >= 0) {
    e.preventDefault();
    items[j].focus();
  }
}

export function AgentFilter({ agents, value, missing, onChange }: AgentFilterProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const sel = value ? agents.find((a) => a.alias === value) || null : null;
  const pick = (alias: string | null) => {
    setOpen(false);
    ref.current?.focus();
    if (alias !== value) onChange(alias);
  };
  const choices: { alias: string | null; agent: Agent | null; label: string }[] = [
    { alias: null, agent: null, label: "All agents" },
    ...(missing && value ? [{ alias: value, agent: null, label: value + " (not in this project)" }] : []),
    ...agents.map((a) => ({ alias: a.alias, agent: a, label: a.alias })),
  ];
  const shown = sel ? sel.alias : value ? value : "All agents";
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={"act-agentchip" + (value ? " is-set" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={"Filter by agent: " + (value ? shown + (missing ? " (not in this project)" : "") : "all agents")}
        title={value ? "Agent: " + shown : "Filter by agent"}
        onClick={() => setOpen((o) => !o)}
      >
        {sel ? (
          <Avatar alias={sel.alias} kind={sel.kind} size={16} decorative />
        ) : (
          <Icon name="agents" cls="v2-ico act-agentchip-ico" />
        )}
        <span className="act-agentchip-t">{shown}</span>
        <Icon name="chev" cls="v2-ico act-agentchip-chev" />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} role="menu" label="Filter by agent" placement="bottom-end" className="v2-menu act-agentmenu">
        <div className="v2-menu-inner" onKeyDown={onMenuKey}>
          {choices.map((c, i) => {
            const on = (c.alias ?? null) === (value ?? null);
            return (
              <div
                key={(c.alias ?? "") + ":" + i}
                role="menuitemradio"
                aria-checked={on}
                tabIndex={-1}
                className="v2-menu-item act-agentmenu-item"
                onClick={() => pick(c.alias)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick(c.alias);
                  }
                }}
              >
                {c.agent ? (
                  <Avatar alias={c.agent.alias} kind={c.agent.kind} status={c.agent.status} size={16} decorative />
                ) : (
                  <Icon name={c.alias ? "alert" : "agents"} cls="v2-ico" />
                )}
                <span className="v2-menu-label act-ellip">{c.label}</span>
                {on ? <Icon name="check" cls="v2-ico v2-menu-check" /> : null}
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
