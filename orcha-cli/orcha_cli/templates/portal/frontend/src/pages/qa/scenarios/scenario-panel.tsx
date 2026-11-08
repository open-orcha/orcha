import { useEffect, useId, useState, type MutableRefObject } from "react";
import { ChevronDown, ChevronUp, Copy, FileCode2, History, Layers, Maximize2, Minimize2, Play, Plus, Trash2, X } from "../map/kit/icons";
import { Button, Dialog, Input, Link, PLATFORM_LABELS, PlatformIcon, Select, StatusGlyph, cn, fmtRelative, useToast, type TargetKind } from "../map/kit";
import { tagSuggestions, withPendingTag } from "../map/kit/tags";
import { TagInput } from "../map/kit";
import { TaskLink, errText, qaHref, useAgentAlias, useLoad } from "../parts";
import { ProvenanceLinks, useProvenance } from "../requests/RequestSource";
import { getScenario, type Platform, type QaScenario } from "../qaApi";
import { scenarioSourceWord } from "../qaWords";
import { adaptScenario, fromChecks, type Scenario, type ScenarioChecks } from "./adapt";
import { deleteScenario, listCheckFixes, patchScenario, proposeScenario, scenarioHealthAction, type ScenarioEdit } from "./api";
import { CheckFixCard } from "./check-fix-card";
import { pendingCheckFixes, replaceCheckLine, replaceInText, type PendingCheckFix } from "./check-fixes";
import { ConfirmDialog } from "./confirm-dialog";
import { ExamplesField } from "./examples-field";
import { examplesError, parseExamples, referencedNames, secretColumns, type ExamplesTable } from "./examples";
import { FreshStateRow } from "./fresh-state-row";
import { seedFlags, useStoredFlags } from "./health/health-store";
import { HistoryDrawer } from "./history-drawer";
import { PermissionsRow } from "./permissions-row";
import { PlatformFitNote } from "./platform-fit-note";
import { cleanRunsLabel } from "./quarantine-badge";
import { ReleaseQuarantineButton } from "./release-quarantine-button";
import { ReplayTraceSection } from "./replay-trace-section";
import { inPlatformFilter, platformFitByKind, platformFitWarning, splitDraftName } from "./scenario-platform";
import { ScenarioFilesList } from "./scenario-files-list";
import { SeedDataField } from "./seed-data-field";
import { cleanupError, seedNames, seedsError, seedsFromText, seedsToText } from "./seeds";
import { eventsFromText, eventsToText } from "./tracking-events";
import { TrackingEventsField, trackingEventsError } from "./tracking-events-field";
import { parseCheck } from "./checks";
import { HumanGate, useScenarios } from "./context";
import { NeedsRow } from "./needs-row";
import { needsError, needsFromText, needsToText } from "./needs";
import { PanelSection, PropRow, textareaClass } from "./panel-ui";
import { PlatformStatusStrip, type PlatformStatus } from "./platform-status-strip";
import { ReviewCard } from "./review-card";
import { readbackHint } from "./saved-checks";
import { checkNewDependency, dependencyRefusalMessage } from "./scenario-dependency-graph";
import { scenarioToMarkdown } from "./scenario-markdown";
import { ScenarioStatusControl } from "./scenario-status-control";
import { TextDialog } from "./text-dialog";
import { ConditionsField } from "../conditions/ConditionsField";
import { cleanConditions, type Conditions } from "../conditions/conditions";

export interface ScenarioPanelProps {
  scenario: Scenario;
  allScenarios: (Pick<Scenario, "id" | "name" | "category" | "depends_on"> & Partial<Pick<Scenario, "status" | "tags" | "target_kind">>)[];
  categories: string[];
  /** Bumps when the page re-reads its data. */
  nonce: number;
  onClose: () => void;
  /** Filled with the panel's guard for leaving it: the caller routes its own ways of closing or
   * switching the panel (Escape, picking another scenario) through it, so unsaved edits ask
   * Save / Discard / Keep editing first. It runs `leave` at once when nothing is unsaved. */
  leaveGuardRef?: MutableRefObject<((leave: () => void) => void) | null>;
  onSaved: (scenario: Scenario) => void;
  onDeleted: (id: string) => void;
  /** Called after "Duplicate" creates a copy, so the caller can add it and select it. */
  onDuplicated?: (created: Scenario) => void;
  /** The project's platforms: the scope control offers "All platforms" and one per platform. */
  kinds?: TargetKind[];
  /** Something changed on the server (a status, a suggestion): read the list again. */
  onRefresh: () => void;
  /** The scenario's result on its platform. */
  platformStatus?: PlatformStatus[];
  /** List view: the panel takes the width the list leaves instead of a fixed side column. */
  wide?: boolean;
  /** Map view: the panel fills the map (`full`) or sits beside it; the header's button toggles. */
  full?: boolean;
  onToggleFull?: () => void;
}

type Draft = Pick<Scenario, "name" | "category" | "persona" | "session" | "description" | "criteria" | "status" | "depends_on" | "tags" | "target_kind">;

function toDraft(s: Scenario): Draft {
  return {
    name: s.name,
    category: s.category,
    persona: s.persona,
    session: s.session,
    description: s.description,
    criteria: [...s.criteria],
    status: s.status,
    depends_on: [...s.depends_on],
    tags: [...s.tags],
    target_kind: s.target_kind,
  };
}

function equalDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The draft after a successful save of `sent`: each field still as it was sent takes the saved
 * value, which the server may have normalised (the name is trimmed), so the panel turns clean; a
 * field edited while the request was in flight keeps the newer edit. */
export function reconcileSavedDraft<T extends object>(current: T, sent: T, saved: T): T {
  const next = { ...current };
  for (const key of Object.keys(saved) as (keyof T)[]) {
    if (JSON.stringify(current[key]) === JSON.stringify(sent[key])) next[key] = saved[key];
  }
  return next;
}

const dataRowsOf = (data: Record<string, unknown>) => Object.entries(data).map(([key, value]) => ({ key, value: String(value ?? "") }));
const checkRowsOf = (s: Pick<Scenario, "criteria" | "checks">) => s.criteria.map((_, i) => (s.checks.criteria[String(i)] ?? []).join("\n"));
/** What the editor would make of the saved values: the base "unsaved changes" compares with, so
 * a line an agent wrote its own way never reads as an edit. */
const baseChecks = (s: Pick<Scenario, "criteria" | "checks">) => buildChecks(checkRowsOf(s), s.checks.scenario);
const baseNeeds = (s: Pick<Scenario, "needs">) => needsFromText(needsToText(s.needs)) ?? [];

/** Only what differs from what is saved: the server is left to keep the rest as it is, so a
 * scenario with one old criterion can still have its name changed. */
export function editOf(saved: Draft, next: Draft, data: { saved: Record<string, unknown>; next: Record<string, unknown> }, needs: { saved: string[]; next: string[] }, checks: { saved: ScenarioChecks; next: ScenarioChecks }): ScenarioEdit {
  const edit: ScenarioEdit = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (next.name !== saved.name) edit.name = next.name;
  if (next.category !== saved.category) edit.category = next.category;
  if (next.persona !== saved.persona) edit.persona = next.persona;
  if (next.session !== saved.session) edit.session = next.session;
  if (next.description !== saved.description) edit.description = next.description;
  if (!same(next.criteria, saved.criteria)) edit.criteria = next.criteria;
  if (!same(next.tags, saved.tags)) edit.tags = next.tags;
  if (!same(next.depends_on, saved.depends_on)) edit.depends_on = next.depends_on;
  if (!same(dataRowsOf(data.next), dataRowsOf(data.saved))) edit.data = data.next;
  if (!same(needs.next, needs.saved)) edit.needs = needs.next;
  if (!same(checks.next.criteria, checks.saved.criteria)) edit.checks = fromChecks(checks.next);
  return edit;
}

/** Right panel for the selected scenario: review, editable fields, Save, Run. */
export function ScenarioPanel({
  scenario,
  allScenarios,
  categories,
  nonce,
  onClose,
  leaveGuardRef,
  onSaved,
  onDeleted,
  onDuplicated,
  kinds = [],
  onRefresh,
  platformStatus = [],
  wide = false,
  full = false,
  onToggleFull,
}: ScenarioPanelProps) {
  const id = useId();
  const { toast } = useToast();
  const { cid, auth, runQa } = useScenarios();
  const source = useProvenance(cid, { sessionId: scenario.session_id, taskId: scenario.task_id });
  const readOnly = !auth.can;
  const locked = readOnly;
  const detail = useLoad((s) => getScenario(scenario.id, s), [scenario.id], nonce);
  const validatedBy = useAgentAlias(scenario.validated_by_agent_id);
  const [draft, setDraft] = useState<Draft>(() => toDraft(scenario));
  const [saved, setSaved] = useState<Draft>(() => toDraft(scenario));
  const [saving, setSaving] = useState(false);
  // A tag typed in the Tags field but not entered yet: it counts as an edit and every save adds it.
  const [tagText, setTagText] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // `?history=<version>`: History opens on that version. A deep link is read once, on arrival.
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  useEffect(() => {
    const v = Number(new URLSearchParams(window.location.search).get("history"));
    if (Number.isInteger(v) && v > 0) {
      setHistoryAt(v);
      setHistoryOpen(true);
    }
  }, [scenario.id]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [fitBusy, setFitBusy] = useState(false);
  // Flags load after the panel: a scenario a person kept must not flash the note first.
  const storedFlags = useStoredFlags(cid, scenario.id, kinds.length > 1 && !scenario.target_kind);
  const fitWarning = storedFlags ? platformFitWarning(scenario, kinds, platformFitByKind(resultRows(scenario)), storedFlags) : null;
  // A leave (Close panel, Escape, another scenario) waiting on Save / Discard / Keep editing.
  const [pendingLeave, setPendingLeave] = useState<{ leave: () => void } | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [dataRows, setDataRows] = useState<{ key: string; value: string }[]>(() => dataRowsOf(scenario.data));
  const [savedData, setSavedData] = useState(scenario.data);
  // The Needs: line, raw input text like the tags; a list once saved.
  const [needsText, setNeedsText] = useState(() => needsToText(scenario.needs));
  const [savedNeeds, setSavedNeeds] = useState<string[]>(() => baseNeeds(scenario));
  const needsInvalid = needsError(needsText) !== null;
  // Kept as the raw textarea text (blank lines and all); a list only when saved.
  const [eventsText, setEventsText] = useState(() => eventsToText(scenario.events));
  const [savedEvents, setSavedEvents] = useState<string[]>(() => scenario.events);
  const eventsInvalid = trackingEventsError(eventsText) !== null;
  const [seedText, setSeedText] = useState(() => seedsToText(scenario.seed));
  const [savedSeed, setSavedSeed] = useState<string[]>(() => scenario.seed);
  const seedInvalid = seedsError(seedText) !== null;
  const [cleanupText, setCleanupText] = useState(() => seedsToText(scenario.cleanup));
  const [savedCleanup, setSavedCleanup] = useState<string[]>(() => scenario.cleanup);
  const cleanupInvalid = cleanupError(cleanupText) !== null;
  // The examples table: one run per row.
  const [examples, setExamples] = useState<ExamplesTable | null>(() => parseExamples(scenario.examples));
  const [savedExamples, setSavedExamples] = useState<ExamplesTable | null>(() => parseExamples(scenario.examples));
  const examplesInvalid = examplesError(examples) !== null;
  // Mobile fresh state: null default, false keep, true always clear.
  const [fresh, setFresh] = useState<boolean | null>(() => scenario.fresh);
  const [savedFresh, setSavedFresh] = useState<boolean | null>(() => scenario.fresh);
  // `Permissions: ask`: the scenario tests a permission prompt; null = granted.
  const [permissions, setPermissions] = useState<"ask" | null>(() => scenario.permissions);
  const [savedPermissions, setSavedPermissions] = useState<"ask" | null>(() => scenario.permissions);
  // Run conditions: what every run of it needs (an OS version, a language, an account...).
  const [conditions, setConditions] = useState<Conditions | null>(() => scenario.conditions);
  const [savedConditions, setSavedConditions] = useState<Conditions | null>(() => scenario.conditions);
  // Deterministic `Check:` lines, one textarea per criterion (kept parallel to `draft.criteria`:
  // moving or removing a criterion moves or removes its checks).
  const [checkRows, setCheckRows] = useState<string[]>(() => checkRowsOf(scenario));
  const [savedChecks, setSavedChecks] = useState<ScenarioChecks>(() => baseChecks(scenario));
  const builtChecks = buildChecks(checkRows, savedChecks.scenario);
  const checksChanged = JSON.stringify(builtChecks.criteria) !== JSON.stringify(savedChecks.criteria);
  // Only what a person changed here is held to the grammar: an agent's line never blocks a rename.
  const checksError = checksChanged ? firstCheckError(checkRows) : null;
  // "Check needs fixing": corrections the latest runs proposed for this scenario's checks.
  const [checkFixes, setCheckFixes] = useState<PendingCheckFix[]>([]);
  useEffect(() => {
    let live = true;
    listCheckFixes(scenario.id)
      .then(({ rows, dismissed }) => {
        if (live) setCheckFixes(pendingCheckFixes(rows, scenario.checks, dismissed));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id, nonce]);

  /** An accepted correction is a save of the scenario's checks (a new version). */
  async function acceptFix(fix: PendingCheckFix, proposed: string) {
    const next = replaceCheckLine(savedChecks, fix.criterion_index, fix.expression, proposed);
    if (!next.ok) throw new Error(next.error);
    onSaved(adaptRow(await patchScenario(scenario.id, auth.human?.id ?? null, { checks: fromChecks(next.checks) })));
    setCheckRows((rows) => rows.map((r, idx) => (idx === fix.criterion_index ? replaceInText(r, fix.expression, proposed) : r)));
    setSavedChecks(next.checks);
  }

  function dropFix(fix: PendingCheckFix) {
    setCheckFixes((list) => list.filter((f) => f !== fix));
  }

  /** A row the server returned, as this page reads it. */
  function adaptRow(row: QaScenario): Scenario {
    return adaptScenario(row, allScenarios.map((s) => ({ id: s.id, name: s.name })), {
      positions: scenario.position ? { [scenario.id]: scenario.position } : {},
      pending: new Map([[scenario.id, scenario.pending]]),
    });
  }

  // `ScenarioPanel` is mounted with `key={scenario.id}` by its caller, so a change of scenario
  // remounts this component with fresh initial state.

  const currentData = () => {
    const data: Record<string, unknown> = {};
    for (const row of dataRows) if (row.key.trim()) data[row.key.trim()] = row.value;
    return data;
  };
  const currentNeeds = () => needsFromText(needsText) ?? [];

  const dirty =
    !equalDraft(draft, saved) ||
    withPendingTag(draft.tags, tagText).length !== draft.tags.length ||
    JSON.stringify(dataRows) !== JSON.stringify(dataRowsOf(savedData)) ||
    JSON.stringify(currentNeeds()) !== JSON.stringify(savedNeeds) ||
    JSON.stringify(eventsFromText(eventsText)) !== JSON.stringify(savedEvents) ||
    JSON.stringify(seedsFromText(seedText)) !== JSON.stringify(savedSeed) ||
    JSON.stringify(seedsFromText(cleanupText)) !== JSON.stringify(savedCleanup) ||
    JSON.stringify(examples) !== JSON.stringify(savedExamples) ||
    fresh !== savedFresh ||
    permissions !== savedPermissions ||
    JSON.stringify(cleanConditions(conditions)) !== JSON.stringify(cleanConditions(savedConditions)) ||
    checksChanged;

  /** Make `s` (the saved scenario) the editor's base and show it. */
  function adopt(s: Scenario) {
    setSaved(toDraft(s));
    setDraft(toDraft(s));
    setSavedData(s.data);
    setDataRows(dataRowsOf(s.data));
    setSavedNeeds(baseNeeds(s));
    setNeedsText(needsToText(s.needs));
    setSavedChecks(baseChecks(s));
    setCheckRows(checkRowsOf(s));
    setTagText("");
    setSavedEvents(s.events);
    setEventsText(eventsToText(s.events));
    setSavedSeed(s.seed);
    setSeedText(seedsToText(s.seed));
    setSavedCleanup(s.cleanup);
    setCleanupText(seedsToText(s.cleanup));
    setSavedExamples(parseExamples(s.examples));
    setExamples(parseExamples(s.examples));
    setSavedFresh(s.fresh);
    setFresh(s.fresh);
    setSavedPermissions(s.permissions);
    setPermissions(s.permissions);
    setSavedConditions(s.conditions);
    setConditions(s.conditions);
  }

  // Changed elsewhere while nothing here is unsaved (an agent, a suggestion accepted, another
  // tab): the editor shows the new saved version (derived state, while rendering). With unsaved
  // edits it keeps them. `ownUpdate` is the version this editor saved itself.
  const [seenVersion, setSeenVersion] = useState<string | null>(scenario.updated_at);
  const [ownUpdate, setOwnUpdate] = useState<string | null>(null);
  if (scenario.updated_at !== seenVersion) {
    setSeenVersion(scenario.updated_at);
    if (scenario.updated_at !== ownUpdate && !dirty && !saving) adopt(scenario);
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  /** Saves the editor; true once the server has the edits. */
  async function save(): Promise<boolean> {
    if (saving || readOnly) return false;
    if (eventsInvalid) {
      toast({ title: "Fix the tracking events first", description: trackingEventsError(eventsText) ?? undefined, variant: "error" });
      return false;
    }
    if (seedInvalid) {
      toast({ title: "Fix the seed data first", description: seedsError(seedText) ?? undefined, variant: "error" });
      return false;
    }
    if (cleanupInvalid) {
      toast({ title: "Fix the cleanup lines first", description: cleanupError(cleanupText) ?? undefined, variant: "error" });
      return false;
    }
    if (examplesInvalid) {
      toast({ title: "Fix the examples table first", description: examplesError(examples) ?? undefined, variant: "error" });
      return false;
    }
    if (needsInvalid) {
      toast({ title: "Fix the Needs line first", description: needsError(needsText) ?? undefined, variant: "error" });
      return false;
    }
    if (checksError) {
      toast({ title: "Fix the checks first", description: checksError, variant: "error" });
      return false;
    }
    setSaving(true);
    // ⌘S fires while the Tags field still holds a half-typed tag: save it as a pill too.
    const tags = withPendingTag(draft.tags, tagText);
    if (tags.length !== draft.tags.length) {
      setDraft((d) => ({ ...d, tags: withPendingTag(d.tags, tagText) }));
      setTagText("");
    }
    const sent = { ...draft, tags };
    try {
      const edit = editOf(saved, sent, { saved: savedData, next: currentData() }, { saved: savedNeeds, next: currentNeeds() }, { saved: savedChecks, next: builtChecks });
      const events = eventsFromText(eventsText);
      const seed = seedsFromText(seedText);
      const cleanup = seedsFromText(cleanupText);
      if (JSON.stringify(events) !== JSON.stringify(savedEvents)) edit.events = events;
      if (JSON.stringify(seed) !== JSON.stringify(savedSeed)) edit.seed = seed;
      if (JSON.stringify(cleanup) !== JSON.stringify(savedCleanup)) edit.cleanup = cleanup;
      if (fresh !== savedFresh) edit.fresh = fresh;
      if (permissions !== savedPermissions) edit.permissions = permissions;
      if (JSON.stringify(cleanConditions(conditions)) !== JSON.stringify(cleanConditions(savedConditions))) edit.conditions = cleanConditions(conditions);
      if (JSON.stringify(examples) !== JSON.stringify(savedExamples)) {
        edit.examples = examples && examples.columns.length ? { columns: examples.columns.map((c) => c.trim()), rows: examples.rows, secret: secretColumns(examples).map((c) => c.trim()) } : null;
      }
      const updated = adaptRow(await patchScenario(scenario.id, auth.human?.id ?? null, edit));
      setOwnUpdate(updated.updated_at);
      onSaved(updated);
      const savedDraft = toDraft(updated);
      setSaved(savedDraft);
      setDraft((d) => reconcileSavedDraft(d, sent, savedDraft));
      setSavedData(updated.data);
      setDataRows(dataRowsOf(updated.data));
      setSavedNeeds(baseNeeds(updated));
      setNeedsText(needsToText(updated.needs));
      setSavedChecks(baseChecks(updated));
      setCheckRows(checkRowsOf(updated));
      setSavedEvents(updated.events);
      setEventsText(eventsToText(updated.events));
      setSavedSeed(updated.seed);
      setSeedText(seedsToText(updated.seed));
      setSavedCleanup(updated.cleanup);
      setCleanupText(seedsToText(updated.cleanup));
      setSavedExamples(parseExamples(updated.examples));
      setExamples(parseExamples(updated.examples));
      setSavedFresh(updated.fresh);
      setFresh(updated.fresh);
      setSavedPermissions(updated.permissions);
      setSavedConditions(updated.conditions);
      setConditions(updated.conditions);
      setPermissions(updated.permissions);
      toast({ title: "Saved", variant: "success" });
      return true;
    } catch (err) {
      toast({ title: "Could not save", description: errText(err), variant: "error" });
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** Leaves the panel (`leave` closes or switches it): at once when nothing is unsaved, else
   * after the person picks Save or Discard. */
  function requestLeave(leave: () => void) {
    if (dirty) setPendingLeave({ leave });
    else leave();
  }

  async function saveAndLeave() {
    const pending = pendingLeave;
    if (!pending) return;
    if (await save()) {
      setPendingLeave(null);
      pending.leave();
    }
  }

  // Re-pointed after every render: the guard reads this render's `dirty`.
  useEffect(() => {
    if (!leaveGuardRef) return;
    leaveGuardRef.current = requestLeave;
    return () => {
      leaveGuardRef.current = null;
    };
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty) void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draft, tagText, dataRows, needsText, checkRows, eventsText, seedText, cleanupText, examples, fresh, permissions]);

  /** "This platform only" and "All platforms", saved at once: the pin is one click, not an edit
   * that waits for Save (the rest of the draft stays as it is). */
  async function setScope(kind: TargetKind | null) {
    if (readOnly || scopeSaving || kind === (saved.target_kind ?? null)) return;
    const previous = draft.target_kind ?? null;
    set("target_kind", kind);
    setScopeSaving(true);
    try {
      const row = await patchScenario(scenario.id, auth.human?.id ?? null, kind ? { shared: false, platform: kind as Platform } : { shared: true });
      const updated = adaptRow(row);
      onSaved(updated);
      setSaved((s) => ({ ...s, target_kind: updated.target_kind }));
    } catch (err) {
      set("target_kind", previous);
      toast({ title: "Could not change the platform", description: errText(err), variant: "error" });
    } finally {
      setScopeSaving(false);
    }
  }

  async function del() {
    setDeleting(true);
    try {
      await deleteScenario(scenario.id, auth.human?.id ?? null);
      onDeleted(scenario.id);
      toast({ title: "Scenario deleted" });
    } catch (err) {
      toast({ title: "Could not delete", description: errText(err), variant: "error" });
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }

  /** A new draft copy of the saved scenario: same fields, its position nudged by `offset`. */
  async function copyAsDraft(name: string, kind: TargetKind | null, offset: number): Promise<Scenario> {
    const row = await proposeScenario(cid, auth.human?.id ?? null, (kind ?? scenario.platform) as Platform, {
      name,
      category: scenario.category,
      persona: scenario.persona,
      description: scenario.description,
      criteria: scenario.criteria,
      tags: scenario.tags,
      data: scenario.data,
      needs: scenario.needs,
      checks: fromChecks(scenario.checks),
      depends_on: scenario.depends_on,
      session: scenario.session,
      shared: !kind,
      ...(scenario.fresh === null ? {} : { fresh: scenario.fresh }),
      ...(scenario.permissions ? { permissions: scenario.permissions } : {}),
      seed: scenario.seed,
      cleanup: scenario.cleanup,
      events: scenario.events,
      ...(scenario.examples ? { examples: scenario.examples } : {}),
    });
    const position = scenario.position ? { x: scenario.position.x + offset, y: scenario.position.y + offset } : null;
    return { ...adaptScenario(row, allScenarios.map((s) => ({ id: s.id, name: s.name }))), position };
  }

  /** One draft per platform, for a person to reword and confirm. This scenario is left exactly
   * as it is and keeps running until they retire it; a draft runs nowhere by itself. The draft
   * for a platform the checks do not fit comes last, so it is the one the panel opens. */
  async function splitPerPlatform(misfit: readonly TargetKind[]) {
    if (fitBusy || readOnly) return;
    setFitBusy(true);
    try {
      const taken = new Set(allScenarios.map((s) => s.name));
      const plan = kinds.filter((k) => !taken.has(splitDraftName(scenario.name, k))).sort((a, b) => Number(misfit.includes(a)) - Number(misfit.includes(b)));
      const made: Scenario[] = [];
      for (const [i, kind] of plan.entries()) made.push(await copyAsDraft(splitDraftName(scenario.name, kind), kind, 40 * (i + 1)));
      if (made.length > 0) {
        toast({ title: made.length === 1 ? "1 draft made" : `${made.length} drafts made`, description: "Reword each one to what its platform shows, then validate it. This scenario keeps running until you retire it.", variant: "success" });
      }
      for (const created of made) onDuplicated?.(created);
    } catch (err) {
      toast({ title: "Could not split", description: errText(err), variant: "error" });
    } finally {
      setFitBusy(false);
    }
  }

  /** "Keep on all platforms": a person decided the checks are fine. Stored as a dismissed
   * `platform_wording` flag, the same as Dismiss on the Health board. */
  async function keepOnAllPlatforms() {
    if (fitBusy || readOnly) return;
    setFitBusy(true);
    try {
      await scenarioHealthAction(cid, auth.human?.id ?? null, { action: "dismiss", ids: [scenario.id], kind: "platform_wording" });
      seedFlags([[scenario.id, [...(storedFlags ?? []).filter((f) => f.kind !== "platform_wording"), { scenario_id: scenario.id, kind: "platform_wording", reason: "Kept by a person.", action: "dismiss", dismissed_at: new Date().toISOString() }]]]);
    } catch (err) {
      toast({ title: "Could not save that", description: errText(err), variant: "error" });
    } finally {
      setFitBusy(false);
    }
  }

  /** Copies the saved scenario: a new draft with " (copy)" appended (a second duplicate becomes
   * "(copy 2)", etc.), its position nudged so it does not sit exactly on top of the original. */
  async function duplicate() {
    if (duplicating || readOnly) return;
    setDuplicating(true);
    try {
      const siblingNames = new Set(allScenarios.map((s) => s.name));
      let copyName = `${scenario.name} (copy)`;
      for (let n = 2; siblingNames.has(copyName); n++) copyName = `${scenario.name} (copy ${n})`;
      onDuplicated?.(await copyAsDraft(copyName, scenario.target_kind, 40));
      toast({ title: "Duplicated", variant: "success" });
    } catch (err) {
      toast({ title: "Could not duplicate", description: errText(err), variant: "error" });
    } finally {
      setDuplicating(false);
    }
  }

  function updateCriterion(i: number, value: string) {
    set("criteria", draft.criteria.map((c, idx) => (idx === i ? value : c)));
  }
  function removeCriterion(i: number) {
    setCheckRows((rows) => rows.filter((_, idx) => idx !== i));
    set("criteria", draft.criteria.filter((_, idx) => idx !== i));
  }
  function addCriterion() {
    setCheckRows((rows) => [...rows, ""]);
    set("criteria", [...draft.criteria, ""]);
  }
  function moveCriterion(i: number, dir: -1 | 1) {
    const to = i + dir;
    if (to < 0 || to >= draft.criteria.length) return;
    setCheckRows((rows) => {
      const r = [...rows];
      const [moved] = r.splice(i, 1);
      r.splice(to, 0, moved ?? "");
      return r;
    });
    const next = [...draft.criteria];
    const [item] = next.splice(i, 1);
    next.splice(to, 0, item);
    set("criteria", next);
  }

  function toggleDependency(depId: string) {
    set("depends_on", draft.depends_on.includes(depId) ? draft.depends_on.filter((d) => d !== depId) : [...draft.depends_on, depId]);
  }

  function updateDataRow(i: number, field: "key" | "value", value: string) {
    setDataRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }
  function removeDataRow(i: number) {
    setDataRows((rows) => rows.filter((_, idx) => idx !== i));
  }

  // A scenario can only wait on one that runs where it runs; one already set stays visible to be removed.
  const dependencyOptions = allScenarios.filter((s) => s.id !== scenario.id && (draft.depends_on.includes(s.id) || !scenario.target_kind || inPlatformFilter(s.target_kind, scenario.target_kind)));
  // What an examples row fills: for the "not used" hints and a new table's columns.
  const rowTexts = [draft.description, ...draft.criteria, ...checkRows, seedText, cleanupText, ...dataRows.map((r) => r.value)];
  const knownNames = new Set(["tag", "tag4", ...dataRows.map((r) => r.key.trim().toLowerCase()), ...seedNames(seedsFromText(seedText)).map((n) => n.toLowerCase())]);
  const suggestedColumns = [...referencedNames(rowTexts)].filter((n) => !knownNames.has(n) && !knownNames.has(n.split(".")[0]) && !n.startsWith("qa.") && /^[a-z_][a-z0-9_ -]*$/.test(n));
  const mobileRelevant = draft.target_kind === "ios" || draft.target_kind === "android" || (!draft.target_kind && (kinds.length === 0 || kinds.some((k) => k === "ios" || k === "android")));
  // The project's tags, most used first, offered as the Tags field's suggestions.
  const tagOptions = tagSuggestions(allScenarios);
  const markdown = () => scenarioToMarkdown(scenario, new Map(allScenarios.map((s) => [s.id, { name: s.name }])));

  return (
    <aside
      data-scenario-panel={scenario.id}
      aria-label="Scenario"
      data-scenario-panel-wide={wide ? "" : undefined}
      className={cn("flex shrink-0 flex-col border-l border-border bg-panel max-md:absolute max-md:inset-0 max-md:z-30 max-md:w-full max-md:border-l-0", wide ? "min-w-0 flex-1 border-l-0" : "w-[400px]")}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
        <h2 className="text-sm font-semibold text-fg">Scenario</h2>
        {dirty ? <span className="ml-1 size-1.5 rounded-full bg-primary" aria-label="unsaved changes" /> : null}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" icon aria-label="History" title="History" onClick={() => setHistoryOpen(true)}>
          <History />
        </Button>
        <Button variant="ghost" size="sm" icon aria-label="Markdown" title="View as Markdown" onClick={() => setTextOpen(true)} data-view-markdown>
          <FileCode2 />
        </Button>
        <HumanGate placement="bottom">
          <Button variant="ghost" size="sm" icon aria-label="Duplicate" title="Duplicate" disabled={readOnly} loading={duplicating} onClick={duplicate} data-duplicate-scenario>
            {duplicating ? null : <Copy />}
          </Button>
        </HumanGate>
        <HumanGate placement="bottom">
          <Button variant="ghost" size="sm" icon aria-label="Delete" title="Delete" className="hover:text-danger" disabled={readOnly} onClick={() => setConfirmOpen(true)} data-delete-scenario>
            <Trash2 />
          </Button>
        </HumanGate>
        {onToggleFull ? (
          <Button variant="ghost" size="sm" icon aria-label={full ? "Back to the map" : "Full view"} title={full ? "Back to the map" : "Full view"} aria-pressed={full} onClick={onToggleFull} data-scenario-panel-full={full ? "on" : "off"}>
            {full ? <Minimize2 /> : <Maximize2 />}
          </Button>
        ) : null}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <Button variant="ghost" size="sm" icon aria-label="Close panel" onClick={() => requestLeave(onClose)}>
          <X />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* List view: a readable document column, centred in the width the list leaves. */}
        <div className={cn("flex flex-col", wide && "mx-auto w-full max-w-[880px]")}>
          <div className="flex flex-col gap-1 px-4 pb-3 pt-3.5">
            <input
              id={`${id}-name`}
              aria-label="Name"
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Scenario name"
              disabled={locked}
              className="-mx-1.5 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-lg font-semibold leading-7 tracking-[-0.01em] text-fg transition-colors placeholder:text-muted hover:border-border focus-visible:border-accent disabled:hover:border-transparent"
              data-scenario-name-input
            />
            <textarea
              id={`${id}-description`}
              aria-label="Description"
              value={draft.description ?? ""}
              onChange={(e) => set("description", e.target.value || null)}
              rows={2}
              disabled={locked}
              className="-mx-1.5 resize-y rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm text-fg-2 transition-colors placeholder:text-muted hover:border-border focus-visible:border-accent disabled:hover:border-transparent"
              placeholder="What is this scenario verifying?"
            />
          </div>

          {scenario.quarantined_at ? (
            <div className="mx-4 mb-3.5 flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5" data-scenario-quarantine>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-medium text-fg">
                  <StatusGlyph status="flaky" decorative />
                  Quarantined
                </span>
                <ReleaseQuarantineButton scenarioId={scenario.id} onReleased={(row) => onSaved(adaptRow(row))} />
              </div>
              <p className="text-xs text-muted">
                {scenario.quarantine_reason || "Flaky"}. Still runs; a failure does not fail the check until it passes cleanly ({cleanRunsLabel(scenario.quarantine_clean_runs, 5)} so far).
              </p>
            </div>
          ) : null}

          {fitWarning ? (
            <PlatformFitNote
              warning={fitWarning}
              drafts={allScenarios.filter((s) => kinds.some((k) => splitDraftName(scenario.name, k) === s.name))}
              splitDone={kinds.every((k) => allScenarios.some((s) => s.name === splitDraftName(scenario.name, k)))}
              busy={fitBusy || scopeSaving || readOnly}
              onLimit={(kind) => void setScope(kind)}
              onSplit={() => void splitPerPlatform(fitWarning.misfit)}
              onKeep={() => void keepOnAllPlatforms()}
            />
          ) : null}

          {detail.data ? (
            <ReviewCard detail={detail.data} onChanged={onRefresh} />
          ) : detail.error ? (
            <p className="border-t border-border px-4 py-3.5 text-xs text-danger" role="alert">
              {detail.error}
            </p>
          ) : null}

          <PanelSection title="Properties">
            <div className="flex flex-col gap-1">
              <PropRow label="Status" help="Draft waits for a person; Validated runs on every check; Quarantined runs but never fails a check; Paused is skipped until a date or a task finishes; Retired never runs and leaves the default lists. Saved as soon as you pick.">
                <ScenarioStatusControl
                  scenario={scenario}
                  others={allScenarios}
                  onChanged={(row) => {
                    onSaved(adaptRow(row));
                    setDraft((d) => ({ ...d, status: row.status }));
                    setSaved((s) => ({ ...s, status: row.status }));
                    onRefresh();
                  }}
                />
              </PropRow>
              <PropRow label="Category" htmlFor={`${id}-category`}>
                <Input id={`${id}-category`} list={`${id}-categories`} value={draft.category ?? ""} disabled={readOnly} onChange={(e) => set("category", e.target.value || null)} />
                <datalist id={`${id}-categories`}>
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </PropRow>
              <PropRow label="Platform" help="All platforms: one scenario, run on every platform of the project. Pin it to one platform when the journey only exists there, or its navigation differs enough to need its own criteria; a check skips scenarios pinned elsewhere. Saved as soon as you pick.">
                <div className="flex flex-col gap-1.5">
                  {/* A dropdown, not a segmented control: with every platform the choices no longer
                      fit the panel, and the wrapped row overlapped the status strip below. */}
                  <HumanGate>
                    <Select
                      aria-label="Platform"
                      value={draft.target_kind ?? "all"}
                      disabled={scopeSaving || readOnly}
                      onChange={(e) => void setScope(e.target.value === "all" ? null : (e.target.value as TargetKind))}
                      data-scenario-target-kind={draft.target_kind ?? ""}
                      className="max-w-[260px]"
                      options={scopeOptions(kinds, draft.target_kind ?? null).map((kind) => ({
                        value: kind ?? "all",
                        label: kind ? `${PLATFORM_LABELS[kind]} only` : "All platforms",
                        icon: kind ? <PlatformIcon kind={kind} className="size-3.5" /> : <Layers aria-hidden className="size-3.5" />,
                        description: kind ? undefined : "run on every platform",
                      }))}
                    />
                  </HumanGate>
                  <PlatformStatusStrip statuses={platformStatus} showLabels className="flex-wrap" />
                </div>
              </PropRow>
              <PropRow label="Persona" htmlFor={`${id}-persona`}>
                <Input id={`${id}-persona`} value={draft.persona ?? ""} placeholder="None" disabled={readOnly} onChange={(e) => set("persona", e.target.value || null)} />
              </PropRow>
              <PropRow label="Session" htmlFor={`${id}-session`} help="A named signed-in session. Scenarios naming the same session start signed in.">
                <Input id={`${id}-session`} value={draft.session ?? ""} placeholder="e.g. admin" disabled={readOnly} onChange={(e) => set("session", e.target.value || null)} data-scenario-session />
                <label className="flex items-center gap-2 py-0.5 text-xs text-muted" title="This scenario signs in and saves the session: it runs first, and scenarios naming the same session start signed in.">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={draft.tags.includes("setup")}
                    disabled={readOnly}
                    onChange={(e) => set("tags", e.target.checked ? [...draft.tags.filter((t) => t !== "setup"), "setup"] : draft.tags.filter((t) => t !== "setup"))}
                    data-scenario-setup
                  />
                  Signs in and saves this session (runs first)
                </label>
              </PropRow>
              {mobileRelevant ? <FreshStateRow value={fresh} onChange={setFresh} disabled={readOnly} dependsOn={draft.depends_on.length} restoresSession={Boolean(draft.session) && !draft.tags.includes("setup")} /> : null}
              <PropRow label="Conditions" help="What every run of it needs. A run can ask for more.">
                <ConditionsField label="" hint={false} value={conditions} onChange={setConditions} disabled={readOnly} platform={scenario.target_kind as Platform | null} />
              </PropRow>
              <PermissionsRow value={permissions} onChange={setPermissions} disabled={readOnly} scenario={{ name: draft.name, description: draft.description, criteria: draft.criteria }} />
              <NeedsRow id={id} value={needsText} onChange={setNeedsText} disabled={readOnly} />
              <PropRow label="Tags" htmlFor={`${id}-tags`} help="Enter, comma or Tab adds a tag; Backspace removes the last.">
                <TagInput id={`${id}-tags`} value={draft.tags} onChange={(tags) => set("tags", tags)} text={tagText} onTextChange={setTagText} suggestions={tagOptions} placeholder="smoke, onboarding" disabled={readOnly} max={20} data-scenario-tags />
              </PropRow>
              {scenario.source ? (
                <PropRow label="Source">
                  <span className="flex h-7 items-center text-sm text-fg-2">{scenarioSourceWord(scenario.source)}</span>
                </PropRow>
              ) : null}
              {scenario.validated_at ? (
                <PropRow label="Validated">
                  <span className="flex h-7 items-center text-sm text-fg-2">
                    {validatedBy ? `by ${validatedBy} · ` : ""}
                    {fmtRelative(scenario.validated_at)}
                  </span>
                </PropRow>
              ) : null}
              {scenario.session_id ? (
                <PropRow label="Drafted in">
                  <Link href={qaHref({ view: "sessions", platform: scenario.target_kind === "ios" ? null : scenario.target_kind, session: scenario.session_id })} className="flex h-7 items-center text-sm text-fg-2 underline underline-offset-2 hover:text-fg">
                    Open the session
                  </Link>
                </PropRow>
              ) : null}
              {scenario.task_id ? (
                <PropRow label="Task">
                  <span className="flex h-7 min-w-0 items-center text-sm">
                    <TaskLink id={scenario.task_id} />
                  </span>
                </PropRow>
              ) : null}
              {source ? (
                <PropRow label="Came from">
                  <span className="flex min-h-7 min-w-0 items-center text-sm"><ProvenanceLinks r={source} /></span>
                </PropRow>
              ) : null}
            </div>
          </PanelSection>

          <PanelSection
            title="Acceptance criteria"
            action={
              <Button size="sm" variant="ghost" disabled={readOnly} onClick={addCriterion} data-add-criterion>
                <Plus /> Add
              </Button>
            }
          >
            <div className="flex flex-col gap-2">
              {draft.criteria.map((c, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="group/criterion flex items-center gap-1.5" data-criterion-row={i}>
                    <span className="w-4 shrink-0 text-right text-xs tabular text-muted">{i + 1}.</span>
                    <Input id={`${id}-criterion-${i}`} value={c} disabled={readOnly} onChange={(e) => updateCriterion(i, e.target.value)} className="flex-1" aria-label={`Criterion ${i + 1}`} data-criterion-input />
                    <div className="flex flex-col">
                      <button type="button" aria-label="Move up" disabled={i === 0 || readOnly} onClick={() => moveCriterion(i, -1)} className="flex h-3.5 w-4 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30">
                        <ChevronUp className="size-3" />
                      </button>
                      <button type="button" aria-label="Move down" disabled={i === draft.criteria.length - 1 || readOnly} onClick={() => moveCriterion(i, 1)} className="flex h-3.5 w-4 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30">
                        <ChevronDown className="size-3" />
                      </button>
                    </div>
                    <Button size="sm" variant="ghost" icon aria-label="Remove criterion" disabled={readOnly} onClick={() => removeCriterion(i)}>
                      <Trash2 />
                    </Button>
                  </div>
                  <CriterionChecksEditor
                    index={i}
                    criterion={c}
                    value={checkRows[i] ?? ""}
                    disabled={readOnly}
                    onChange={(v) => setCheckRows((rows) => rows.map((r, idx) => (idx === i ? v : r)).concat(rows.length <= i ? [v] : []))}
                  />
                  {checkFixes
                    .filter((f) => f.criterion_index === i)
                    .map((f) => (
                      <div key={`${f.expression}\u0000${f.proposed ?? ""}`} className="ml-[22px] mr-[60px] flex flex-col gap-1" data-panel-check-fix={i}>
                        <div className="text-xs text-muted">
                          {f.applied ? "Repaired for its runs" : "Check needs fixing"}
                          {f.seen > 1 ? ` (seen in ${f.seen} runs)` : ""}
                        </div>
                        <CheckFixCard
                          compact
                          fix={f}
                          scenarioId={scenario.id}
                          criterionIndex={i}
                          onAccept={(proposed) => acceptFix(f, proposed)}
                          onAccepted={() => {
                            dropFix(f);
                            toast({ title: "Check fixed", description: "Saved to the scenario as a new version.", variant: "success" });
                          }}
                          onDismissed={() => dropFix(f)}
                        />
                      </div>
                    ))}
                </div>
              ))}
              {draft.criteria.length === 0 ? <p className="text-xs text-muted">No criteria yet.</p> : null}
            </div>
          </PanelSection>

          <ExamplesField value={examples} onChange={setExamples} texts={rowTexts} suggestedColumns={suggestedColumns} scenarioId={scenario.id} />

          <PanelSection title="Dependencies" lead="Scenarios that must run before this one.">
            <div className="flex max-h-44 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
              {dependencyOptions.length === 0 ? (
                <p className="px-2.5 py-2 text-xs text-muted">No other scenarios yet.</p>
              ) : (
                dependencyOptions.map((s) => {
                  // The Map's drag-to-connect refuses a cycle; the checkboxes must too, or two
                  // scenarios that wait on each other can never run.
                  const checked = draft.depends_on.includes(s.id);
                  const closesCycle = !checked && checkNewDependency(allScenarios, s.id, scenario.id).ok === false;
                  return (
                    <label
                      key={s.id}
                      title={closesCycle ? dependencyRefusalMessage("cycle") : undefined}
                      className={cn("flex h-8 shrink-0 cursor-pointer items-center gap-2 px-2.5 text-sm text-fg transition-colors hover:bg-hover", checked && "bg-selected", closesCycle && "cursor-not-allowed opacity-50")}
                    >
                      <input type="checkbox" className="size-3.5 accent-primary" checked={checked} disabled={closesCycle || readOnly} onChange={() => toggleDependency(s.id)} data-dependency-checkbox={s.id} />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <span className="shrink-0 text-xs text-muted">{s.category}</span>
                    </label>
                  );
                })
              )}
            </div>
          </PanelSection>

          <ReplayTraceSection scenarioId={scenario.id} />

          <TrackingEventsField value={eventsText} onChange={setEventsText} disabled={readOnly} />

          <SeedDataField value={seedText} onChange={setSeedText} cleanup={cleanupText} onCleanupChange={setCleanupText} disabled={readOnly} />

          <PanelSection
            title="Data variables"
            action={
              <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => setDataRows((r) => [...r, { key: "", value: "" }])}>
                <Plus /> Add row
              </Button>
            }
          >
            <div className="flex flex-col gap-1.5">
              {dataRows.map((row, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input value={row.key} disabled={readOnly} onChange={(e) => updateDataRow(i, "key", e.target.value)} mono placeholder="key" aria-label={`Variable ${i + 1} key`} className="w-[120px] shrink-0 text-xs" />
                  <Input value={row.value} disabled={readOnly} onChange={(e) => updateDataRow(i, "value", e.target.value)} mono placeholder="value" aria-label={`Variable ${i + 1} value`} className="flex-1 text-xs" />
                  <Button size="sm" variant="ghost" icon aria-label="Remove row" disabled={readOnly} onClick={() => removeDataRow(i)}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              {dataRows.length === 0 ? <p className="text-xs text-muted">No data variables.</p> : null}
            </div>
          </PanelSection>

          <ScenarioFilesList scenarioId={scenario.id} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">
        <HumanGate>
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty || eventsInvalid || seedInvalid || cleanupInvalid || examplesInvalid || needsInvalid || checksError !== null || readOnly} onClick={save} data-save-scenario>
            Save
          </Button>
        </HumanGate>
        <HumanGate>
          <Button size="sm" disabled={readOnly} onClick={() => runQa("check", null, { scenarioIds: [scenario.id], platform: scenario.target_kind as Platform | null })} data-run-scenario>
            <Play /> Run this scenario
          </Button>
        </HumanGate>
        <HumanGate>
          <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => runQa("check", null, { scenarioIds: [scenario.id], platform: scenario.target_kind as Platform | null, askConditions: true })} data-run-scenario-conditions>
            Run with conditions
          </Button>
        </HumanGate>
        <span className="ml-auto truncate text-xs text-muted">{dirty ? "Unsaved changes · ⌘S" : null}</span>
      </div>

      <HistoryDrawer
        open={historyOpen}
        highlight={historyAt}
        onClose={() => setHistoryOpen(false)}
        scenarioId={scenario.id}
        onRestore={(row) => {
          const restored = adaptRow(row);
          setOwnUpdate(restored.updated_at);
          onSaved(restored);
          adopt(restored);
        }}
      />
      <ConfirmDialog open={confirmOpen} title="Delete this scenario?" description="This removes it and its version history. This cannot be undone." loading={deleting} onConfirm={del} onClose={() => setConfirmOpen(false)} />
      <TextDialog open={textOpen} onClose={() => setTextOpen(false)} title="Scenario as Markdown" description="The saved scenario as text: outcome and acceptance criteria, no scripted steps." text={textOpen ? markdown() : ""} />
      <Dialog
        open={pendingLeave !== null}
        onClose={() => setPendingLeave(null)}
        title="Save your changes?"
        description="This scenario has edits that are not saved yet."
        className="max-w-sm"
        footer={
          <>
            <Button onClick={() => setPendingLeave(null)} data-leave-stay>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const pending = pendingLeave;
                setPendingLeave(null);
                pending?.leave();
              }}
              data-leave-discard
            >
              Discard
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void saveAndLeave()} data-leave-save>
              Save
            </Button>
          </>
        }
      />
    </aside>
  );
}

/** The scope control's choices: All platforms, then each project platform; a pin to a platform
 * the project does not have still offers that pin and every kind. */
function scopeOptions(kinds: readonly TargetKind[], current: TargetKind | null): (TargetKind | null)[] {
  const base: TargetKind[] = kinds.length > 0 ? [...kinds] : ["ios", "android", "web"];
  if (current && !base.includes(current)) base.push(current);
  return [null, ...base];
}

/** The scenario's newest result per platform, as `platformFitByKind` reads results. */
function resultRows(s: Scenario) {
  return Object.entries(s.by_platform).map(([kind, r]) => ({ scenario_id: s.id, outcome: r?.outcome ?? "inconclusive", kind: kind as TargetKind, at: r?.at ?? null, reason: r?.reason ?? null }));
}

/** `checkRows[i]` (one check per line) as checks of normalised lines; `scenario` stays as it is. */
export function buildChecks(rows: readonly string[], scenario: string[] = []): ScenarioChecks {
  const criteria: Record<string, string[]> = {};
  rows.forEach((text, i) => {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const r = parseCheck(l);
        return r.ok ? r.normalised : l;
      });
    if (lines.length) criteria[String(i)] = lines;
  });
  return { criteria, scenario };
}

function firstCheckError(rows: string[]): string | null {
  for (let i = 0; i < rows.length; i++) {
    for (const line of (rows[i] ?? "").split("\n")) {
      if (!line.trim()) continue;
      const r = parseCheck(line);
      if (!r.ok) return `Criterion ${i + 1}: ${r.error}`;
    }
  }
  return null;
}

/** Deterministic checks for one criterion: collapsed to a link until it has a value. */
function CriterionChecksEditor({ index, criterion, value, disabled, onChange }: { index: number; criterion: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const hint = readbackHint(criterion, value);
  const [open, setOpen] = useState(value.trim() !== "");
  const inputId = `${useId()}-criterion-checks-${index}`;
  const errors = value
    .split("\n")
    .map((l, n) => ({ n, l, r: l.trim() ? parseCheck(l) : null }))
    .filter((x) => x.r && !x.r.ok);
  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="ml-[22px] self-start rounded-sm text-xs text-muted hover:text-fg disabled:pointer-events-none" data-add-checks={index}>
        + Add checks
        {hint ? (
          <span className="ml-2 text-warning" data-readback-hint={index}>
            · no read-back of what it saves
          </span>
        ) : null}
      </button>
    );
  }
  return (
    <div className="ml-[22px] mr-[60px] flex flex-col gap-1" data-criterion-checks-editor={index}>
      <label
        className="text-xs text-muted"
        htmlFor={inputId}
        title={
          "Exact assertions the harness evaluates with no model, one per line. A `Saved:` line reads back " +
          "what the criterion saved (the API, the database, the record's own screen or the device storage) " +
          "and fails a save that stored the wrong values, even when the screen looks right."
        }
      >
        Checks<span className="sr-only"> for criterion {index + 1}</span>, one per line
      </label>
      <textarea
        id={inputId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.max(1, value.split("\n").length)}
        placeholder={'text "Order placed"\nButton "Pay" disabled within 10s\nSaved: POST /api/orders -> total is 12, coupon empty'}
        className={cn(textareaClass, "font-mono text-xs")}
        data-criterion-checks-input
      />
      {errors.length > 0 ? (
        <p className="text-xs text-danger" data-check-error>
          Line {errors[0].n + 1}: {errors[0].r && !errors[0].r.ok ? errors[0].r.error : ""}
        </p>
      ) : hint ? (
        <p className="text-xs text-warning" data-readback-hint={index}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
