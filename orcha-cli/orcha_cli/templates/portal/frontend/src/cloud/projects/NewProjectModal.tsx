/**
 * The shared New-project house modal (vanilla app-shell.js openNewProjectModal/
 * postNewProject parity) — POST /api/containers {additional:true}. On success
 * it flags the one-time portal-only dashboard notice for the NEW cid, persists
 * orcha:cid, and lands INSIDE the new project (/?cid=<id>, full navigation).
 * Used by both the /projects hub (ProjectsPage) and the topbar ProjectSwitcher.
 */
import { useState } from "react";
import { Modal, useToast } from "../../components/ui";

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const create = () => {
    const nm = name.trim();
    const ds = desc.trim();
    if (!nm) { toast("A project name is required.", "danger"); return; }
    fetch("/api/containers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nm, description: ds || null, additional: true }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d: d as { detail?: string; container_id?: string } })).catch(() => ({ ok: r.ok, status: r.status, d: {} as { detail?: string; container_id?: string } })))
      .then(({ ok, status, d }) => {
        if (!ok) {
          toast("Create failed" + (d && d.detail ? ": " + d.detail : " (" + status + ")"), "danger");
          return;
        }
        onClose();
        try { localStorage.setItem("orcha:projNotice:" + d.container_id, "1"); } catch { /* private mode */ }
        try { localStorage.setItem("orcha:cid", String(d.container_id)); } catch { /* private mode */ }
        location.assign("/?cid=" + encodeURIComponent(d.container_id || ""));
      })
      .catch((e) => toast("Create failed: " + (e instanceof Error ? e.message : e), "danger"));
  };
  return (
    <Modal
      title="New project"
      desc="Adds another project to this stack. Portal-only until a host workspace is bound to it — agents and tasks work, but nothing wakes agents yet."
      primary="Create project"
      onPrimary={create}
      onClose={onClose}
    >
      <label className="np-f"><span>Name</span>
        <input id="npName" maxLength={200} placeholder="e.g. api-gateway" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="np-f"><span>Description</span>
        <textarea id="npDesc" className="ta" placeholder="What is this project about? (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
      </label>
    </Modal>
  );
}
