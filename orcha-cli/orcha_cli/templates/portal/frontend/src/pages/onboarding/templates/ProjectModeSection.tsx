/**
 * Settings › General › "Work type" — the project's mode (Code | General) and
 * "Apply a template…" for an EXISTING project. The integrator mounts
 * `<ProjectModeSection cid={cid} />` in SettingsPage's General tab (this file
 * never edits the Settings page itself).
 *
 * Writes: PUT /api/containers/{cid}/project-profile {mode, actor_agent_id} —
 * owner or `manage_autonomy` (the same grant as the project's other execution
 * settings); without it the control is disabled and says why. Switching is
 * reversible and destroys nothing: General only hides the Code/GitHub tabs.
 */
import { useState } from "react";
import { Button, Segmented, Tooltip } from "../../../components/primitives";
import { useToast } from "../../../components/ui";
import { MODE_DESC, MODE_LABEL, saveProjectMode, useProjectMode, type ProjectMode } from "../../../lib/projectMode";
import { useGrantAuthority } from "../../settings/grantAuthority";
import { SettingRow, SettingRows, SettingsGroup, settingsErrText } from "../../settings/settingsUi";
import { ApplyTemplateDialog } from "./ApplyTemplateDialog";
import "./templates.css";

export function ProjectModeSection({ cid }: { cid: string | null }) {
  const pm = useProjectMode(cid);
  const auth = useGrantAuthority("manage_autonomy");
  const tplAuth = useGrantAuthority("manage_agents");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (!cid) return null;

  const locked = !auth.can;
  const reason = !auth.pending && locked ? auth.reason : null;
  const change = async (next: string) => {
    const mode = next as ProjectMode;
    if (locked || busy || mode === pm.mode || !pm.known) return;
    setBusy(true);
    try {
      await saveProjectMode(cid, mode, auth.human?.id ?? null);
      toast(mode === "general" ? "Switched to General — Code and GitHub tabs are hidden." : "Switched to Code — Code and GitHub tabs are back.", "ok");
    } catch (e) {
      toast("Couldn't change the work type — " + settingsErrText(e) + ".", "danger");
    }
    setBusy(false);
  };

  const seg = (
    <Segmented
      label="Work type"
      size="sm"
      value={pm.mode}
      onChange={change}
      items={(["code", "general"] as ProjectMode[]).map((m) => ({
        key: m, label: MODE_LABEL[m], disabled: locked || busy || !pm.known, title: MODE_DESC[m],
      }))}
    />
  );
  const tplDenied = !tplAuth.pending && !tplAuth.can ? tplAuth.reason : null;
  const tplBtn = (
    <Button size="sm" variant="secondary" id="setApplyTemplate" disabled={!!tplDenied} onClick={() => setOpen(true)}>
      Apply a template…
    </Button>
  );

  return (
    <SettingsGroup settab="general" title="Work type" lead="What kind of work this project does." flush id="setWorkType">
      <SettingRows>
        <SettingRow label="Mode" desc={pm.known ? MODE_DESC[pm.mode] : pm.error ? "Couldn't read the mode — showing Code." : "Loading…"} id="setModeL">
          <div className="pm-mode" data-mode={pm.mode}>
            <Tooltip label={reason || ""} disabled={!reason} placement="left">{seg}</Tooltip>
          </div>
        </SettingRow>
        <SettingRow label="Template" desc={pm.profile?.template_name ? `Last applied: ${pm.profile.template_name}.` : "Starter team, routines and done-criteria for your kind of work."}>
          <Tooltip label={tplDenied || ""} disabled={!tplDenied} placement="left">{tplBtn}</Tooltip>
        </SettingRow>
      </SettingRows>
      {open && <ApplyTemplateDialog cid={cid} onClose={() => setOpen(false)} />}
    </SettingsGroup>
  );
}
