/**
 * Cloud topbar PROJECT SWITCHER — React port of the vanilla shell's project
 * switcher (static/modules/app-shell.js @3046062: projSwitchHtml / projMenuHtml
 * / openProjectMenu), relocated from the sidebar brand area to the topbar as a
 * Cloud topbarAction. It replaces the "Projects" sidebar nav entry; the
 * /projects hub stays routed and is reachable from this menu's "All projects"
 * row.
 *
 * Vanilla parity:
 *  - trigger: .proj-switch — status dot + CURRENT project name (em-dash before
 *    the first snapshot) + chevron; aria-haspopup; renders on single-project
 *    stacks too (the vanilla shell had no multi-project gate on it).
 *  - open → menu rows come FRESH from GET /api/containers (membership-filtered
 *    server-side); an instant "Loading…" row while in flight; a failed fetch
 *    closes the menu and toasts danger.
 *  - row: status dot, name, "status · N agents" sub-label (agents omitted when
 *    the field is absent), the current cid highlighted with the check — plus a
 *    Needs-you badge when the list reports needs_you > 0 (the hub card field).
 *  - picking a project is a FULL href navigation to /?cid=<id> — the hub's
 *    Open idiom: that IS project switching. The current row is a no-op close.
 *  - "All projects" links the /projects landing; "New project" opens the shared
 *    house modal (NewProjectModal — POST /api/containers additional:true).
 *  - outside-click + Escape close (menu markup portals to <body> like the
 *    GitHub page's .pmenu dropdowns).
 * Class names are shell.css's, which still ships via /assets/styles.css:
 * .proj-switch/.pdot/.pname/.chev + .pmenu.float/.pm-head/.pm-row/.b/.t1/.t2/
 * .chk/.all/.new/.muted. switcher.css only adapts sizing to the topbar.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getJSON } from "../../api/client";
import { Icon, useToast } from "../../components/ui";
import { useSnapshot } from "../../state/SnapshotProvider";
import { NewProjectModal } from "./NewProjectModal";
import "./switcher.css";

interface SwitchRow {
  id: string;
  name?: string | null;
  status?: string | null;
  agents?: number | null;
  needs_you?: number | null;
}

export function ProjectSwitcher() {
  const { snap, cid } = useSnapshot();
  const toast = useToast();
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const [list, setList] = useState<SwitchRow[] | null>(null); // null = loading
  const [creating, setCreating] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(false);
  openRef.current = open != null;

  const cur = snap?.container ?? null;
  const curId = cur?.id != null ? String(cur.id) : cid != null ? String(cid) : null;
  const curName = (cur && cur.name) || "—";

  const close = () => setOpen(null);

  const toggle = () => {
    if (open) { close(); return; }
    const r = btnRef.current?.getBoundingClientRect();
    // vanilla openMenu placement: below the anchor, left-aligned (clamped)
    setOpen({
      top: Math.round((r?.bottom ?? 0) + 8),
      left: Math.round(Math.max(8, r?.left ?? 8)),
    });
    setList(null);
    getJSON<{ containers?: SwitchRow[] }>("/api/containers")
      .then((d) => {
        if (!openRef.current) return; // closed while loading (vanilla guard)
        setList((d && d.containers) || []);
      })
      .catch((e) => {
        setOpen(null);
        toast("Could not load projects: " + (e instanceof Error ? e.message : e), "danger");
      });
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(t) && !(t instanceof Element && t.closest("#projSwitch"))) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        className="proj-switch"
        id="projSwitch"
        type="button"
        aria-haspopup="true"
        aria-expanded={open != null}
        title={`Project: ${curName} — switch project`}
        onClick={toggle}
      >
        <span className={"pdot" + (cur && cur.status === "active" ? " on" : "")} />
        <span className="pname">{curName}</span>
        <Icon name="chev" cls="chev" />
      </button>
      {open != null &&
        createPortal(
          <div ref={menuRef} id="psFloat" className="pmenu float show" style={{ top: open.top, left: open.left, right: "auto" }}>
            <div className="pm-head plain">Projects</div>
            {list == null ? (
              <div className="pm-row muted">Loading…</div>
            ) : (
              <>
                {list.map((c) => {
                  const isCur = curId != null && String(c.id) === curId;
                  const agentsN = c.agents != null ? ` · ${c.agents} agent${Number(c.agents) === 1 ? "" : "s"}` : "";
                  const needs = Number(c.needs_you || 0);
                  return (
                    <a
                      key={c.id}
                      className={"pm-row proj" + (isCur ? " on" : "")}
                      data-proj={c.id}
                      href={"/?cid=" + encodeURIComponent(c.id)}
                      onClick={(e) => { if (isCur) e.preventDefault(); close(); }}
                    >
                      <span className={"pdot" + (c.status === "active" ? " on" : "")} />
                      <span className="b">
                        <span className="t1">{c.name}</span>
                        <span className="t2">{c.status}{agentsN}</span>
                      </span>
                      {needs > 0 && (
                        <span className="needs" title="Verifications + requests waiting on a human">{needs}</span>
                      )}
                      {isCur ? <Icon name="check" cls="chk" /> : null}
                    </a>
                  );
                })}
                <a className="pm-row all" href="/projects" onClick={close}>
                  <Icon name="home" cls="" /><span>All projects</span>
                </a>
                <button
                  className="pm-row new"
                  type="button"
                  onClick={() => { close(); setCreating(true); }}
                >
                  <Icon name="plus" cls="" /><span>New project</span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </>
  );
}
