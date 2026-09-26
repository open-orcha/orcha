import { describe, expect, it } from "vitest";
import {
  initialSaveState,
  onEdit,
  onOverwrite,
  onReload,
  onSaveDrift,
  onSaveError,
  onSaveOk,
  onSaveStart,
} from "./editorSave";

describe("editorSave state machine", () => {
  it("starts clean with the given baseHash", () => {
    const s = initialSaveState("h0");
    expect(s).toEqual({ status: "clean", baseHash: "h0", driftHash: null, errorReason: null });
  });

  it("edit: clean -> dirty", () => {
    const s = onEdit(initialSaveState("h0"));
    expect(s.status).toBe("dirty");
    expect(s.baseHash).toBe("h0");
  });

  it("edit: dirty -> dirty (idempotent)", () => {
    const s = onEdit(onEdit(initialSaveState("h0")));
    expect(s.status).toBe("dirty");
  });

  it("edit during saving is a no-op (in-flight save keeps going)", () => {
    const saving = onSaveStart(onEdit(initialSaveState("h0")));
    expect(saving.status).toBe("saving");
    const stillSaving = onEdit(saving);
    expect(stillSaving.status).toBe("saving");
  });

  it("edit clears a prior error/drift banner and goes dirty", () => {
    const errored = onSaveError(onSaveStart(onEdit(initialSaveState("h0"))), "too_large");
    const edited = onEdit(errored);
    expect(edited.status).toBe("dirty");
    expect(edited.errorReason).toBeNull();

    const drifted = onSaveDrift(onSaveStart(onEdit(initialSaveState("h0"))), "h-drift");
    const editedAfterDrift = onEdit(drifted);
    expect(editedAfterDrift.status).toBe("dirty");
    expect(editedAfterDrift.driftHash).toBeNull();
  });

  it("saveStart: dirty -> saving; no-ops from clean", () => {
    const dirty = onEdit(initialSaveState("h0"));
    const saving = onSaveStart(dirty);
    expect(saving.status).toBe("saving");

    const clean = initialSaveState("h0");
    expect(onSaveStart(clean).status).toBe("clean");
  });

  it("saveOk: saving -> clean, baseHash advances to the returned hash", () => {
    const saving = onSaveStart(onEdit(initialSaveState("h0")));
    const ok = onSaveOk(saving, "h1");
    expect(ok).toEqual({ status: "clean", baseHash: "h1", driftHash: null, errorReason: null });
  });

  it("saveDrift: saving -> drift, remembers current_hash", () => {
    const saving = onSaveStart(onEdit(initialSaveState("h0")));
    const drift = onSaveDrift(saving, "h-current");
    expect(drift.status).toBe("drift");
    expect(drift.driftHash).toBe("h-current");
    expect(drift.baseHash).toBe("h0"); // unchanged until reload/overwrite resolves it
  });

  it("saveError: saving -> error, keeps a reason, buffer untouched (no hash change)", () => {
    const saving = onSaveStart(onEdit(initialSaveState("h0")));
    const err = onSaveError(saving, "too_large");
    expect(err.status).toBe("error");
    expect(err.errorReason).toBe("too_large");
    expect(err.baseHash).toBe("h0");
  });

  it("saveError for 'exists' reason behaves the same shape", () => {
    const saving = onSaveStart(onEdit(initialSaveState("h0")));
    const err = onSaveError(saving, "exists");
    expect(err.status).toBe("error");
    expect(err.errorReason).toBe("exists");
  });

  it("reload: drift -> clean, adopts the current hash", () => {
    const saving = onSaveStart(onEdit(initialSaveState("h0")));
    const drift = onSaveDrift(saving, "h-current");
    const reloaded = onReload(drift, "h-current");
    expect(reloaded).toEqual({ status: "clean", baseHash: "h-current", driftHash: null, errorReason: null });
  });

  it("overwrite: drift -> saving, baseHash advances to driftHash for the retry", () => {
    const saving = onSaveStart(onEdit(initialSaveState("h0")));
    const drift = onSaveDrift(saving, "h-current");
    const overwriting = onOverwrite(drift);
    expect(overwriting.status).toBe("saving");
    expect(overwriting.baseHash).toBe("h-current");
    expect(overwriting.driftHash).toBeNull();
  });

  it("overwrite from a non-drift state is a no-op", () => {
    const clean = initialSaveState("h0");
    expect(onOverwrite(clean)).toBe(clean);
    const dirty = onEdit(clean);
    expect(onOverwrite(dirty)).toBe(dirty);
  });

  it("a saveOk after an overwrite retry lands clean with the newest hash", () => {
    const saving = onSaveStart(onEdit(initialSaveState("h0")));
    const drift = onSaveDrift(saving, "h-current");
    const retrying = onOverwrite(drift);
    const ok = onSaveOk(retrying, "h-final");
    expect(ok).toEqual({ status: "clean", baseHash: "h-final", driftHash: null, errorReason: null });
  });

  it("full lifecycle: clean -> dirty -> saving -> clean -> dirty -> saving -> drift -> reload -> clean", () => {
    let s = initialSaveState("h0");
    s = onEdit(s);
    expect(s.status).toBe("dirty");
    s = onSaveStart(s);
    expect(s.status).toBe("saving");
    s = onSaveOk(s, "h1");
    expect(s).toEqual({ status: "clean", baseHash: "h1", driftHash: null, errorReason: null });
    s = onEdit(s);
    s = onSaveStart(s);
    s = onSaveDrift(s, "h2");
    expect(s.status).toBe("drift");
    s = onReload(s, "h2");
    expect(s).toEqual({ status: "clean", baseHash: "h2", driftHash: null, errorReason: null });
  });
});
