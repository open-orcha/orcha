/**
 * Import a project template: pick the JSON file → choose this project or a new one →
 * review the server's plan (every agent / routine / preset / skill / budget with New,
 * "As <name>" or Skip and the reason) → resolve alias collisions (Skip or Rename) →
 * confirm. Nothing is written until "Import N changes"; the import echoes the preview's
 * digest, so the server applies exactly what was reviewed (409 → the fresh plan is shown).
 *
 * New project: the plan comes from /api/template/preview-new first; on confirm the
 * project is created, previewed for real, and imported only if that plan matches —
 * otherwise the real plan is shown for one more confirmation.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Chip, Dialog, Segmented, Tooltip } from "../../../components/primitives";
import { Icon } from "../../../components/ui";
import { modelLabel, useModelCatalog } from "../../../lib/models";
import { switchProject } from "../../../lib/scope";
import { settingsErrText, StatusLine } from "../settingsUi";
import {
  actionLabel, applyImport, bundleSummary, createProject, DEFAULT_OPTIONS, importButtonLabel, importResultText,
  parseBundleText, previewImport, readFileText, previewNewProject, sameCounts, SECTION_KEYS, SECTION_LABEL,
  type Bundle, type ImportOptions, type ImportResult, type Preview, type SectionKey,
} from "./portabilityApi";

export interface ImportTemplateDialogProps {
  cid: string;
  projectName: string;
  /** acting human allowed to import HERE (owner / manage_agents), or null with `hereReason` */
  actor: string | null;
  hereReason: string | null;
  onClose: () => void;
  /** after a successful import into THIS project */
  onImported: (r: ImportResult) => void;
}

type Target = "here" | "new";
type Phase = "edit" | "busy" | "done";

function ErrLine({ children }: { children: ReactNode }) {
  return <StatusLine tone="err">{children}</StatusLine>;
}

export function ImportTemplateDialog({ cid, projectName, actor, hereReason, onClose, onImported }: ImportTemplateDialogProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nameId = useId();
  const seatsId = useId();
  const [fileName, setFileName] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>(actor ? "here" : "new");
  const [newName, setNewName] = useState("");
  const [opts, setOpts] = useState<ImportOptions>(DEFAULT_OPTIONS);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>("edit");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // once a new project exists (created by this dialog), everything targets it
  const [created, setCreated] = useState<{ cid: string; actor: string | null; name: string } | null>(null);
  const models = useModelCatalog().models;

  const targetCid = created ? created.cid : target === "here" ? cid : null;
  const targetActor = created ? created.actor : actor;

  const pick = async (f: File | null | undefined) => {
    if (!f) return;
    setFileName(f.name);
    setPreview(null);
    setResult(null);
    const { bundle: b, error } = parseBundleText(await readFileText(f).catch(() => ""));
    setBundle(b);
    setFileError(error);
    setOpts(DEFAULT_OPTIONS);
    if (b) setNewName(((b.source && b.source.project_name) || "Imported project") + " copy");
  };

  // (re)compute the plan whenever the file, target or choices change
  useEffect(() => {
    if (!bundle || phase === "done") return;
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      const p = targetCid ? previewImport(targetCid, targetActor, bundle, opts) : previewNewProject(bundle, opts);
      p.then(
        (res) => { if (live) { setPreview(res); setPreviewError(null); setLoading(false); } },
        (e) => { if (live) { setPreview(null); setPreviewError(settingsErrText(e)); setLoading(false); } },
      );
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [bundle, opts, targetCid, targetActor, phase]);

  const setSection = (k: SectionKey, on: boolean) => setOpts((o) => ({ ...o, sections: { ...o.sections, [k]: on } }));
  const setCollision = (alias: string, action: "skip" | "rename", renameTo?: string) =>
    setOpts((o) => ({ ...o, collisions: { ...o.collisions, [alias]: { action, rename_to: renameTo ?? o.collisions[alias]?.rename_to ?? null } } }));

  const doImport = async () => {
    if (!bundle || !preview) return;
    setPhase("busy");
    setApplyError(null);
    setNotice(null);
    try {
      let dest = created;
      let digest = preview.preview_digest;
      if (!dest && target === "new") {
        const name = newName.trim();
        let c: Awaited<ReturnType<typeof createProject>>;
        try {
          c = await createProject(name);
        } catch (e) {
          // Creating the project failed (e.g. 409: the name is taken). That is not the
          // "project changed while you were reviewing" 409 of the import itself.
          setApplyError("Couldn't create the project — " + settingsErrText(e) + ".");
          setPhase("edit");
          return;
        }
        dest = { cid: c.container_id, actor: c.human_agent_id, name: c.name || name };
        setCreated(dest);
        const real = await previewImport(dest.cid, dest.actor, bundle, opts);
        if (real.errors.length || !sameCounts(real.counts, preview.counts) || !real.preview_digest) {
          setPreview(real);
          setNotice(`"${dest.name}" was created. Its plan differs slightly — review it once more, then import.`);
          setPhase("edit");
          return;
        }
        digest = real.preview_digest;
      }
      const destCid = dest ? dest.cid : cid;
      const destActor = dest ? dest.actor : actor;
      const r = await applyImport(destCid, destActor, bundle, opts, digest || "");
      setResult(r);
      setPhase("done");
      if (!dest) onImported(r);
    } catch (e) {
      const err = e as { status?: number };
      setApplyError(err && err.status === 409
        ? "This project changed while you were reviewing — the plan below is up to date. Review it and import again."
        : "Couldn't import — " + settingsErrText(e) + ".");
      setPhase("edit");
      // refresh the plan (a 409 means it moved)
      setOpts((o) => ({ ...o }));
    }
  };

  const newNameOk = target === "here" || !!created || newName.trim().length > 0;
  const canImport = phase === "edit" && !!preview && !loading && preview.errors.length === 0 && preview.changes > 0 && newNameOk;

  const footer = phase === "done" ? (
    <>
      {created ? <Button variant="secondary" onClick={() => switchProject(created.cid, "/agents")}>Open {created.name}</Button> : null}
      <Button variant="primary" onClick={onClose}>Done</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" id="ptImportGo" busy={phase === "busy"} disabled={!canImport} onClick={() => void doImport()}>
        {preview ? (target === "new" && !created ? (preview.changes > 0 ? `Create project and ${importButtonLabel(preview.changes).toLowerCase()}` : importButtonLabel(0)) : importButtonLabel(preview.changes)) : "Import"}
      </Button>
    </>
  );

  return (
    <Dialog
      title="Import template"
      description="Review every change before anything is applied."
      onClose={onClose}
      size="lg"
      className="pt-dialog"
      closeOnBackdrop={phase !== "busy"}
      footer={footer}
    >
      {phase === "done" && result ? (
        <div className="pt-done" role="status">
          <StatusLine tone="ok">{importResultText(result)}</StatusLine>
          {created ? <p className="pt-hint">Into the new project <b>{created.name}</b>. Agents start idle; routines stay paused until you turn them on.</p> : null}
          {result.agents.length ? (
            <ul className="pt-list" aria-label="Agents created">
              {result.agents.map((a) => (
                <li key={a.agent_id} className="pt-row"><span className="pt-name">{a.alias}</span>
                  {a.alias !== a.from_alias ? <span className="pt-meta">renamed from {a.from_alias}</span> : null}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="pt-body">
          <div className="pt-pick">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="pt-file"
              aria-label="Template file"
              id="ptFile"
              onChange={(e) => void pick(e.target.files && e.target.files[0])}
            />
            <Button size="sm" variant="secondary" icon="folder" onClick={() => fileRef.current?.click()} disabled={phase === "busy"}>
              {fileName ? "Choose another file…" : "Choose file…"}
            </Button>
            <span className="pt-meta pt-filename" title={fileName || undefined}>{fileName || "An .json file exported from Embodent"}</span>
          </div>
          {fileError ? <ErrLine>{fileError}</ErrLine> : null}

          {bundle ? (
            <>
              <div className="pt-target">
                <span className="pt-label">Import into</span>
                {created ? (
                  <Chip size="sm" dot="ok">{created.name} (new)</Chip>
                ) : (
                  <Segmented
                    size="sm"
                    label="Import into"
                    value={target}
                    onChange={(k) => setTarget(k as Target)}
                    items={[
                      { key: "here", label: projectName, disabled: !actor },
                      { key: "new", label: "A new project" },
                    ]}
                  />
                )}
                {!actor && hereReason && !created ? (
                  <Tooltip label={hereReason} placement="top"><span className="pt-help" tabIndex={0} aria-label={hereReason}><Icon name="info" cls="" /></span></Tooltip>
                ) : null}
              </div>
              {target === "new" && !created ? (
                <label className="pt-field" htmlFor={nameId}>
                  <span className="pt-label">Project name</span>
                  <input id={nameId} className="pt-input" value={newName} maxLength={200} onChange={(e) => setNewName(e.target.value)} />
                </label>
              ) : null}
              {notice ? <StatusLine tone="warn">{notice}</StatusLine> : null}
              {applyError ? <ErrLine>{applyError}</ErrLine> : null}
              {previewError ? <ErrLine>{previewError}</ErrLine> : null}
              {preview ? (
                <PlanView preview={preview} opts={opts} loading={loading} models={models} seatsId={seatsId} prompts={promptsOf(bundle)}
                  setSection={setSection} setCollision={setCollision} setOpts={setOpts} />
              ) : loading ? <p className="pt-hint">Working out what would change…</p> : null}
            </>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

/** alias → the prompt text the file carries (shown for review before import). */
function promptsOf(b: Bundle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of (b.roster || []) as { alias?: unknown; system_prompt?: unknown }[]) {
    if (a && typeof a.alias === "string" && typeof a.system_prompt === "string") out[a.alias] = a.system_prompt;
  }
  return out;
}

function PlanView({ preview, opts, loading, models, seatsId, prompts, setSection, setCollision, setOpts }: {
  preview: Preview;
  prompts: Record<string, string>;
  opts: ImportOptions;
  loading: boolean;
  models: { id: string; name?: string }[];
  seatsId: string;
  setSection: (k: SectionKey, on: boolean) => void;
  setCollision: (alias: string, action: "skip" | "rename", renameTo?: string) => void;
  setOpts: (f: (o: ImportOptions) => ImportOptions) => void;
}) {
  const b = preview.bundle;
  const exported = b.exported_at ? new Date(b.exported_at) : null;
  const src = useMemo(() => bundleSummary({
    roster: Array(b.counts.roster).fill(0), routines: Array(b.counts.routines).fill(0),
    dod_presets: Array(b.counts.dod_presets).fill(0), skills: Array(b.counts.skills).fill(0),
    budgets: b.has_budgets ? {} : undefined,
  }), [b]);
  const s = preview.sections;
  const hasSeat = (preview.human_seat_lines || 0) > 0;
  return (
    <div className={"pt-plan" + (loading ? " is-loading" : "")} aria-busy={loading || undefined}>
      <p className="pt-source">
        <Icon name="folder" cls="" />
        <span>From <b>{b.project_name || "an unnamed project"}</b>{exported && !isNaN(exported.getTime())
          ? <span className="pt-meta" title={exported.toISOString()}> · exported {exported.toLocaleDateString()}</span> : null}
          <span className="pt-meta"> · {src}</span></span>
      </p>
      {preview.warnings.map((w) => <StatusLine key={w} tone="warn">{w.charAt(0).toUpperCase() + w.slice(1)}.</StatusLine>)}
      {preview.errors.map((e) => <StatusLine key={e.message + (e.alias || "")} tone="err">{e.alias ? e.alias + ": " : ""}{e.message}.</StatusLine>)}

      <fieldset className="pt-sections">
        <legend className="pt-label">Include</legend>
        {SECTION_KEYS.filter((k) => k !== "budgets" || b.has_budgets).map((k) => (
          <label key={k} className="pt-check">
            <input type="checkbox" checked={preview.included[k]} onChange={(e) => setSection(k, e.target.checked)} />
            {SECTION_LABEL[k]} <span className="pt-meta">{b.counts[k]}</span>
          </label>
        ))}
      </fieldset>

      <div className="pt-opts">
        {preview.included.routines && s.routines.length ? (
          <label className="pt-check">
            <input type="checkbox" checked={opts.enable_routines} onChange={(e) => setOpts((o) => ({ ...o, enable_routines: e.target.checked }))} />
            Turn routines on after import
          </label>
        ) : null}
        {preview.included.roster && hasSeat ? (
          <label className="pt-inline" htmlFor={seatsId}>
            Managers who were people
            <select id={seatsId} className="pt-input pt-select" value={opts.human_seats}
              onChange={(e) => setOpts((o) => ({ ...o, human_seats: e.target.value as ImportOptions["human_seats"] }))}>
              <option value="me">Report to you</option>
              <option value="unassigned">Leave unassigned</option>
            </select>
          </label>
        ) : null}
      </div>

      {preview.included.roster ? (
        <PlanGroup title="Agents" count={preview.counts.roster}>
          {s.roster.map((a) => {
            const lab = actionLabel(a.action, a.final_alias, a.alias);
            const choice = opts.collisions[a.alias];
            const meta = [a.role, a.model ? modelLabel(a.model, models) : null,
              a.autonomy_override ? "autonomy: " + a.autonomy_override : null].filter(Boolean).join(" · ");
            return (
              <li key={a.alias} className="pt-row" data-action={a.action}>
                <div className="pt-row-main">
                  <span className="pt-name">{a.alias}</span>
                  {meta ? <span className="pt-meta" title={a.model || undefined}>{meta}</span> : null}
                  {a.collision ? (
                    <span className="pt-collide">
                      <Segmented
                        size="sm"
                        label={`${a.alias} already exists here`}
                        value={choice?.action === "rename" ? "rename" : "skip"}
                        onChange={(k) => setCollision(a.alias, k as "skip" | "rename", k === "rename" ? (choice?.rename_to || a.suggested_alias || "") : undefined)}
                        items={[{ key: "skip", label: "Keep existing" }, { key: "rename", label: "Import as…" }]}
                      />
                      {choice?.action === "rename" ? (
                        <input
                          className="pt-input pt-rename"
                          aria-label={`New name for ${a.alias}`}
                          value={choice.rename_to ?? a.suggested_alias ?? ""}
                          maxLength={64}
                          onChange={(e) => setCollision(a.alias, "rename", e.target.value)}
                        />
                      ) : null}
                    </span>
                  ) : null}
                  <Chip size="sm" dot={lab.tone}>{lab.text}</Chip>
                </div>
                {a.notes.length ? <div className="pt-notes">{a.notes.join(" · ")}</div> : null}
                {a.action !== "skip" && prompts[a.alias] ? (
                  <details className="pt-prompt">
                    <summary>Prompt</summary>
                    <pre>{prompts[a.alias]}</pre>
                  </details>
                ) : null}
              </li>
            );
          })}
        </PlanGroup>
      ) : null}

      {preview.included.roster && s.reporting_lines.length ? (
        <PlanGroup title="Reporting lines" count={preview.counts.reporting_lines}>
          {s.reporting_lines.map((l) => (
            <li key={l.alias} className="pt-row" data-action={l.action}>
              <div className="pt-row-main">
                <span className="pt-name">{l.alias}</span>
                <span className="pt-meta">{l.manager ? "reports to " + l.manager.label : l.note}</span>
                <Chip size="sm" dot={l.action === "set" ? "ok" : "neutral"}>{l.action === "set" ? "Set" : "Skip"}</Chip>
              </div>
            </li>
          ))}
        </PlanGroup>
      ) : null}

      {preview.included.routines && s.routines.length ? (
        <PlanGroup title="Routines" count={preview.counts.routines}>
          {s.routines.map((r, i) => {
            const lab = actionLabel(r.action);
            return (
              <li key={r.title + i} className="pt-row" data-action={r.action}>
                <div className="pt-row-main">
                  <span className="pt-name">{r.title}</span>
                  <span className="pt-meta"><code className="pt-code">{r.cron}</code> {r.timezone}{r.assignee ? " · " + r.assignee.alias : ""}{r.action === "create" ? (r.enabled ? " · on" : " · paused") : ""}</span>
                  <Chip size="sm" dot={lab.tone}>{lab.text}</Chip>
                </div>
                {r.notes.length ? <div className="pt-notes">{r.notes.join(" · ")}</div> : null}
              </li>
            );
          })}
        </PlanGroup>
      ) : null}

      {(["dod_presets", "skills"] as const).map((k) => (preview.included[k] && s[k].length ? (
        <PlanGroup key={k} title={SECTION_LABEL[k]} count={preview.counts[k]}>
          {s[k].map((p) => {
            const lab = actionLabel(p.action, p.final_name, p.name);
            return (
              <li key={p.name} className="pt-row" data-action={p.action}>
                <div className="pt-row-main">
                  <span className="pt-name">{p.name}</span>
                  <Chip size="sm" dot={lab.tone}>{lab.text}</Chip>
                </div>
                {p.notes.length ? <div className="pt-notes">{p.notes.join(" · ")}</div> : null}
              </li>
            );
          })}
        </PlanGroup>
      ) : null))}

      {preview.included.budgets && s.budgets.length ? (
        <PlanGroup title="Budgets" count={preview.counts.budgets}>
          {s.budgets.map((x, i) => (
            <li key={(x.alias || "project") + i} className="pt-row" data-action={x.action}>
              <div className="pt-row-main">
                <span className="pt-name">{x.scope === "project" ? "Project" : x.alias}</span>
                <span className="pt-meta">{[
                  x.monthly_limit_usd != null ? "$" + x.monthly_limit_usd + " / month" : null,
                  x.monthly_limit_tokens != null ? x.monthly_limit_tokens.toLocaleString() + " tokens / month" : null,
                ].filter(Boolean).join(" · ")}</span>
                <Chip size="sm" dot={x.action === "set" ? "ok" : "neutral"}>{x.action === "set" ? "Set" : "Skip"}</Chip>
              </div>
              {x.note ? <div className="pt-notes">{x.note}</div> : null}
            </li>
          ))}
        </PlanGroup>
      ) : null}
    </div>
  );
}

function PlanGroup({ title, count, children }: { title: string; count: { create: number; skip: number }; children: ReactNode }) {
  return (
    <section className="pt-group" aria-label={title}>
      <h3 className="pt-group-h">
        {title}
        <span className="pt-meta">{count.create ? `${count.create} to add` : "nothing to add"}{count.skip ? ` · ${count.skip} skipped` : ""}</span>
      </h3>
      <ul className="pt-list">{children}</ul>
    </section>
  );
}
