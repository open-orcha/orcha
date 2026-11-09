/**
 * What Start will run, before it runs: the work, the app, the device and its state, who runs it,
 * the scenarios, the time, and the conditions, split into what Orcha sets on the device and what
 * the agent sets up, with a warning where the picked device cannot meet one.
 */
import type { ReactNode } from "react";
import { AppWindow, Bot, Clock, ListChecks, Play, Smartphone, Target, TriangleAlert } from "../map/kit/icons";
import { CONDITION_ICON } from "../conditions/ConditionsField";
import { CONDITION_KEYS, cleanConditions, conditionWord, nativeKeys, unavailableKeys, type ConditionKey, type Conditions } from "../conditions/conditions";
import type { Platform } from "../qaApi";
import { platformWord, plural } from "../qaWords";
import type { QaRunKind } from "../runQa";
import "./run-preview.css";

const VERB: Record<QaRunKind, string> = { map: "Map", explore: "Explore", draft: "Draft scenarios for", check: "Check" };

export interface PreviewDevice {
  title: string;
  /** "Booted", "Boots when the run starts", "Needs setup", or the default's words. */
  state: string;
  physical: boolean;
  /** Its OS when known: "iOS 26.5", "Android 16". */
  os?: string | null;
}

/** "13" asked and "Android 16" running: false; unknown: null. */
export function osMeets(asked: string | null | undefined, have: string | null | undefined): boolean | null {
  const a = /(\d+(?:\.\d+)*)/.exec(asked ?? "")?.[1];
  const h = /(\d+(?:\.\d+)*)/.exec(have ?? "")?.[1];
  if (!a || !h) return null;
  const ap = a.split("."), hp = h.split(".");
  return ap.every((p, i) => hp[i] === p);
}

function Line({ icon, k, children }: { icon: ReactNode; k: string; children: ReactNode }) {
  return (
    <div className="qa-rp-line">
      <span className="qa-rp-ico" aria-hidden="true">{icon}</span>
      <span className="qa-rp-k">{k}</span>
      <span className="qa-rp-v">{children}</span>
    </div>
  );
}

function CondChip({ k, c, platform }: { k: ConditionKey; c: Conditions; platform: Platform }) {
  const Icon = CONDITION_ICON[k];
  return (
    <li className="qa-rp-chip" data-preview-condition={k}>
      <Icon size={13} />
      <span>{conditionWord(k, c, platform)}</span>
    </li>
  );
}

export function RunPreview({ kind, platform, app, device, agent, scenarios, minutes, focus, conditions, inherited }: {
  kind: QaRunKind;
  platform: Platform;
  app: { name?: string | null; id?: string | null } | null;
  device: PreviewDevice | null;
  agent: string | null;
  /** Check runs: how many and the first names; null for other kinds. */
  scenarios: { count: number | null; names: string[]; picked: boolean } | null;
  minutes: number | null;
  focus: string;
  conditions: Conditions | null;
  /** Each scenario's own conditions are added at its start: said, not listed. */
  inherited?: boolean;
}) {
  const c = cleanConditions(conditions) ?? {};
  const asked = CONDITION_KEYS.filter((k) => c[k] && !(k === "os" && platform === "web"));
  const native = nativeKeys(platform, device?.physical ?? false);
  const off = unavailableKeys(platform, device?.physical ?? false);
  const orcha = asked.filter((k) => native.has(k));
  const agentKeys = asked.filter((k) => !native.has(k) && !off.has(k));
  const offKeys = asked.filter((k) => off.has(k));
  const os = c.os ? osMeets(c.os, device?.os) : null;
  const what = kind === "check"
    ? `${VERB.check} ${scenarios?.picked ? plural(scenarios.count ?? 0, "picked scenario") : scenarios?.count != null ? plural(scenarios.count, "approved scenario") : "the approved scenarios"}`
    : `${VERB[kind]} the ${platformWord(platform)} app`;
  const more = scenarios && scenarios.count != null ? scenarios.count - scenarios.names.length : 0;
  return (
    <section className="qa-rp" aria-label="What will run" data-run-preview>
      <header className="qa-rp-head">
        <span className="qa-rp-play" aria-hidden="true"><Play size={14} /></span>
        <div className="qa-rp-title">
          <span className="qa-rp-what">{what}</span>
          <span className="qa-rp-sub">{[platformWord(platform), device?.title, agent ? `run by ${agent}` : null].filter(Boolean).join(" · ")}</span>
        </div>
      </header>
      <div className="qa-rp-body">
        {app?.id ? <Line icon={<AppWindow size={14} />} k="App">{app.name ? <>{app.name} <code>{app.id}</code></> : <code>{app.id}</code>}</Line> : null}
        {device ? <Line icon={<Smartphone size={14} />} k="Device">{device.title}<span className="qa-rp-muted"> · {device.state}{device.os ? ` · ${device.os}` : ""}</span></Line> : null}
        {agent ? <Line icon={<Bot size={14} />} k="Agent">{agent}</Line> : null}
        {scenarios && scenarios.names.length ? (
          <Line icon={<ListChecks size={14} />} k="Scenarios">
            <ul className="qa-plain qa-rp-names">
              {scenarios.names.map((n) => <li key={n}>{n}</li>)}
              {more > 0 ? <li className="qa-rp-muted">and {more} more</li> : null}
            </ul>
          </Line>
        ) : null}
        {minutes ? <Line icon={<Clock size={14} />} k="Time">About {minutes} min</Line> : null}
        {focus.trim() ? <Line icon={<Target size={14} />} k="Focus">{focus.trim()}</Line> : null}
      </div>
      <div className="qa-rp-conds">
        <span className="qa-rp-k">Conditions</span>
        {asked.length ? (
          <div className="qa-rp-groups">
            {orcha.length ? (
              <div className="qa-rp-group"><span className="qa-rp-gk">Orcha sets on the device</span><ul className="qa-plain qa-rp-chips">{orcha.map((k) => <CondChip key={k} k={k} c={c} platform={platform} />)}</ul></div>
            ) : null}
            {offKeys.length ? (
              <div className="qa-rp-group"><span className="qa-rp-gk">Can't be set on this phone</span><ul className="qa-plain qa-rp-chips is-off">{offKeys.map((k) => <CondChip key={k} k={k} c={c} platform={platform} />)}</ul></div>
            ) : null}
            {agentKeys.length ? (
              <div className="qa-rp-group"><span className="qa-rp-gk">The agent sets up</span><ul className="qa-plain qa-rp-chips is-agent">{agentKeys.map((k) => <CondChip key={k} k={k} c={c} platform={platform} />)}</ul></div>
            ) : null}
          </div>
        ) : <span className="qa-rp-muted">None: the device as it is.{inherited ? " Each scenario's own conditions still apply." : ""}</span>}
        {os === false ? (
          <p className="qa-rp-warn" role="status" data-preview-os-warning><TriangleAlert size={14} /> {device?.title} runs {device?.os}, not {conditionWord("os", c, platform)}. Pick a device that does on the Device tab, or the checks it touches are blocked.</p>
        ) : null}
        {asked.length && inherited ? <p className="qa-rp-muted qa-rp-foot">Each scenario's own conditions are added when it starts. Everything is put back when the run ends.</p> : asked.length ? <p className="qa-rp-muted qa-rp-foot">Everything is put back when the run ends.</p> : null}
      </div>
    </section>
  );
}
