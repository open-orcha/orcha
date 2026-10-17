/**
 * Cmd/Ctrl+K command palette (arch §6). Real, read-only, current-project
 * results with a visible scope chip; inline per-provider error rows; ↑/↓,
 * Enter, Cmd/Ctrl+Enter (new tab for URL destinations), Escape (closes and
 * restores focus to the opener). Never executes an action the acting identity
 * cannot perform — such rows show the reason instead.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/ui";
import { StatusDot } from "../../components/primitives/Badge";
import { IconButton } from "../../components/primitives/Button";
import { trapTab, useFocusReturn } from "../../components/primitives/focus";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { useProjects } from "../../state/projects";
import { withCid } from "../../lib/scope";
import {
  GROUP_ORDER,
  recentResults,
  rememberRecent,
  runProviders,
  type SearchGroup,
  type SearchResult,
} from "./providers";
import { installBuiltinProviders } from "./builtin";
import { ProjectFace, useProjectPalette } from "../projectPalette";

installBuiltinProviders();

export function CommandPalette({ onClose, embedded, openExecutionControls, openCompose }: {
  onClose: () => void;
  embedded: boolean;
  openExecutionControls: () => void;
  openCompose?: () => void;
}) {
  const { snap, cid, multi } = useSnapshot();
  const { list: projects, refresh: refreshProjects } = useProjects();
  const projectPalette = useProjectPalette(); // D13: the sidebar's slots
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<{ group: SearchGroup; message: string }[]>([]);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  useFocusReturn(boxRef, inputRef);

  const projectName = snap?.container?.name || null;
  const authority = useActingAuthority();
  const actingHuman = authority.human;
  const actingReason = authority.reason;

  useEffect(() => { void refreshProjects(); }, [refreshProjects]);

  useEffect(() => {
    const ctrl = new AbortController();
    const ctx = {
      snap, cid, multi, projectName, projects, actingHuman, actingReason, embedded,
      openExecutionControls: () => { onClose(); openExecutionControls(); },
      openCompose: openCompose ? () => { onClose(); openCompose(); } : undefined,
      signal: ctrl.signal,
    };
    const t = setTimeout(() => {
      void runProviders(q, ctx).then(({ results: r, errors: e }) => {
        if (ctrl.signal.aborted) return;
        const recent = q.trim() ? [] : recentResults(cid);
        setResults([...recent, ...r]);
        setErrors(e);
        setActive(0);
      });
    }, q.trim() ? 60 : 0);
    return () => { ctrl.abort(); clearTimeout(t); };
    // snapshot bumps intentionally do not reset the list while typing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, cid, projects, embedded, actingHuman?.id, actingReason]);

  const grouped = useMemo(() => {
    const out: { group: SearchGroup; items: { r: SearchResult; index: number }[] }[] = [];
    results.forEach((r, index) => {
      let g = out.find((x) => x.group === r.group);
      if (!g) { g = { group: r.group, items: [] }; out.push(g); }
      g.items.push({ r, index });
    });
    return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }, [results]);

  const flat = useMemo(() => grouped.flatMap((g) => g.items.map((i) => i.r)), [grouped]);

  const execute = (r: SearchResult, newTab: boolean) => {
    if (r.disabledReason) { setNotice(r.disabledReason); return; }
    if (r.run) { r.run(); if (r.closeOnRun) onClose(); return; }
    if (r.hardHref) {
      if (newTab) window.open(r.hardHref, "_blank", "noopener");
      else window.location.assign(r.hardHref);
      return;
    }
    if (r.href) {
      rememberRecent(cid, r);
      const scoped = multi && cid ? withCid(r.href, cid) : r.href;
      if (newTab) { window.open(scoped, "_blank", "noopener"); return; }
      onClose();
      // settings sections are hash-addressed: SettingsPage follows the router
      // location's hash (useLocation), so a same-path navigate switches tab.
      navigate(scoped);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === "Tab") { trapTab(e, boxRef.current); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (flat.length ? (a + 1) % flat.length : 0)); setNotice(null); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0)); setNotice(null); return; }
    if (e.key === "Enter") {
      const r = flat[active];
      if (!r) return;
      e.preventDefault();
      execute(r, e.metaKey || e.ctrlKey);
    }
  };

  useEffect(() => {
    const el = boxRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const scope = projectName ? "in " + projectName : "in current project";
  let n = -1;

  return createPortal(
    <div className="v2-overlay v2-palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={boxRef}
        className="v2-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        onKeyDown={onKeyDown}
      >
        <div className="v2-palette-input">
          <Icon name="search" cls="v2-ico" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat[active] ? `${listId}-o-${active}` : undefined}
            placeholder="Search tasks, agents, requests, projects…"
            value={q}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setQ(e.target.value); setNotice(null); }}
          />
          <span className="v2-scope-chip" title="Results are limited to the current project (except Projects)">{scope}</span>
          <IconButton icon="x" label="Close search" size="sm" className="v2-palette-close" onClick={onClose} />
        </div>
        {notice ? <div className="v2-palette-notice" role="alert">{notice}</div> : null}
        <div id={listId} role="listbox" aria-label="Results" className="v2-palette-list">
          {grouped.map((g) => (
            <div key={g.group} role="group" aria-label={g.group} className="v2-palette-group">
              <div className="v2-palette-gh" aria-hidden="true">{g.group}</div>
              {g.items.map(({ r }) => {
                n += 1;
                const i = n;
                return (
                  <div
                    key={g.group + ":" + r.id}
                    id={`${listId}-o-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={r.disabledReason ? true : undefined}
                    className={"v2-palette-row" + (i === active ? " is-active" : "") + (r.disabledReason ? " is-disabled" : "")}
                    onMouseMove={() => setActive(i)}
                    onClick={(e) => execute(r, e.metaKey || e.ctrlKey)}
                  >
                    {r.avatar ? <ProjectFace name={r.avatar} id={r.avatarSeed} palette={r.avatarSeed ? projectPalette.get(r.avatarSeed) : undefined} className="v2-palette-pav" /> : r.status ? <StatusDot status={r.status} showLabel={false} /> : r.icon ? <Icon name={r.icon} cls="v2-ico" /> : <span className="v2-ico-spacer" />}
                    <span className="v2-palette-label">{r.label}</span>
                    {r.detail ? <span className="v2-palette-detail">{r.detail}</span> : null}
                    {r.shortcut ? <kbd className="v2-palette-kbd" aria-label={"Shortcut " + r.shortcut}>{r.shortcut}</kbd> : null}
                  </div>
                );
              })}
            </div>
          ))}
          {errors.map((e) => (
            <div key={"err-" + e.group} className="v2-palette-error" role="status">
              {e.group} search unavailable: {e.message}
            </div>
          ))}
          {q.trim() && !flat.length ? (
            <div className="v2-palette-empty" role="status">No matches {projectName ? "in " + projectName : "in this project"}</div>
          ) : null}
        </div>
        <div className="v2-palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> new tab</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
