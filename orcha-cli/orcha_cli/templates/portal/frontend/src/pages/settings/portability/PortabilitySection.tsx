/**
 * Settings → General › Template — export this project's setup as a portable JSON
 * template, import one (into this project or a new one) with a reviewed preview, and
 * keep the template library (DoD presets + skills).
 *
 * Authority (server-enforced; mirrored here so nothing offers a write that will 403):
 * export / import-here / library edits need owner or manage_agents. Importing into a
 * NEW project needs neither (you own what you create), so Import stays available.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Tooltip } from "../../../components/primitives";
import { useToast } from "../../../components/ui";
import { useSnapshot } from "../../../state/SnapshotProvider";
import { useGrantAuthority } from "../grantAuthority";
import { SettingRow, SettingRows, SettingsGroup, settingsErrText, StatusLine } from "../settingsUi";
import { ImportTemplateDialog } from "./ImportTemplateDialog";
import {
  bundleSummary, downloadJSON, exportTemplate, importResultText, listLibrary, templateFileName,
  type Bundle, type LibraryKind,
} from "./portabilityApi";
import { TemplateLibraryDialog } from "./TemplateLibraryDialog";
import "./portability.css";

/** "Exported … · 4 fields scrubbed" (pure, tested). */
export function exportedText(b: Bundle, file: string): string {
  const n = b.scrub ? b.scrub.redactions.length : 0;
  return `Exported ${file} — ${bundleSummary(b)}` + (n ? ` · ${n} field${n === 1 ? "" : "s"} scrubbed` : "") + ".";
}

export function PortabilitySection() {
  const { snap, cid, refresh } = useSnapshot();
  const toast = useToast();
  const auth = useGrantAuthority("manage_agents");
  const c = snap?.container ?? null;
  const [withBudgets, setWithBudgets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<{ bundle: Bundle; file: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryKind | null>(null);
  const [libCounts, setLibCounts] = useState<{ presets: number; skills: number } | null>(null);

  const loadCounts = useCallback(() => {
    if (!cid) return;
    Promise.all([listLibrary(cid, "dod-presets"), listLibrary(cid, "skills")]).then(
      ([p, s]) => setLibCounts(Array.isArray(p?.items) && Array.isArray(s?.items) ? { presets: p.items.length, skills: s.items.length } : null),
      () => setLibCounts(null),
    );
  }, [cid]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  if (!c || !cid) return null;
  const locked = !auth.can;
  const reason = !auth.pending ? auth.reason : null;

  const doExport = async () => {
    if (locked || busy) return;
    setBusy(true);
    try {
      const b = await exportTemplate(cid, auth.human ? auth.human.id : null, withBudgets);
      const file = templateFileName(c.name);
      downloadJSON(b, file);
      setExported({ bundle: b, file });
    } catch (e) {
      toast("Couldn't export — " + settingsErrText(e) + ".", "danger");
    }
    setBusy(false);
  };

  const exportBtn = (
    <Button size="sm" variant="secondary" id="ptExport" busy={busy} disabled={locked} onClick={() => void doExport()}>Export…</Button>
  );
  const libDesc = libCounts
    ? `${libCounts.presets} DoD preset${libCounts.presets === 1 ? "" : "s"} · ${libCounts.skills} skill${libCounts.skills === 1 ? "" : "s"}`
    : "DoD presets and skills carried in templates";

  return (
    <SettingsGroup
      settab="general"
      title="Share this setup"
      id="setTemplate"
      lead="Reuse this project's setup elsewhere, or bring one in."
      help="A template carries the AI roster (roles, prompts, models, autonomy overrides, reporting lines), routines, DoD presets, skills and — if you choose — budget limits. Keys, tokens, people and history are never included."
      flush
    >
      <SettingRows label="Template">
        <SettingRow
          label="Export template"
          desc={<>A JSON file. Keys, tokens and member identities are removed.{locked && reason ? <> · <span data-testid="pt-export-reason">{reason}</span></> : null}</>}
        >
          <span className="pt-ctl">
            <label className="pt-check">
              <input type="checkbox" checked={withBudgets} disabled={locked} onChange={(e) => setWithBudgets(e.target.checked)} />
              Include budgets
            </label>
            {locked && reason ? <Tooltip label={reason} placement="left">{exportBtn}</Tooltip> : exportBtn}
          </span>
        </SettingRow>
        <SettingRow label="Import template" desc="Preview every change before it's applied.">
          <Button size="sm" variant="secondary" id="ptImport" onClick={() => setImportOpen(true)}>Import…</Button>
        </SettingRow>
        <SettingRow label="Template library" desc={libDesc}>
          <Button size="sm" variant="ghost" id="ptLibrary" onClick={() => setLibrary("dod-presets")}>Manage…</Button>
        </SettingRow>
      </SettingRows>
      {exported ? (
        <div className="set-pad pt-status">
          <StatusLine tone="ok">{exportedText(exported.bundle, exported.file)}</StatusLine>
        </div>
      ) : null}
      {importOpen ? (
        <ImportTemplateDialog
          cid={cid}
          projectName={c.name || "This project"}
          actor={auth.can && auth.human ? auth.human.id : null}
          hereReason={reason}
          onClose={() => setImportOpen(false)}
          onImported={(r) => {
            toast(importResultText(r), "ok");
            void refresh();
            loadCounts();
          }}
        />
      ) : null}
      {library ? (
        <TemplateLibraryDialog
          cid={cid}
          actor={auth.human ? auth.human.id : null}
          readOnlyReason={locked ? reason || "You can't change this project's library" : null}
          initialKind={library}
          onClose={() => setLibrary(null)}
          onChanged={loadCounts}
        />
      ) : null}
    </SettingsGroup>
  );
}
