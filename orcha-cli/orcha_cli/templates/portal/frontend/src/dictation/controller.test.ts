/**
 * The dictation state machine with a fake microphone + engine:
 * idle → starting → listening → transcribing → (cleaning) → done, plus
 * cancel (Esc), errors (mic denied, no engine, engine failure), undo and
 * "use original" after the clean-up.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MicError } from "./audio";
import { DictationController, type DictationPhase } from "./controller";
import { EngineError } from "./engines";
import { fakeRig, flush } from "./testFakes";

function field(value = "", tag: "textarea" | "input" = "textarea") {
  const el = document.createElement(tag);
  el.setAttribute("aria-label", "Done when");
  el.value = value;
  document.body.appendChild(el);
  el.focus();
  el.setSelectionRange(value.length, value.length);
  return el;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("DictationController state machine", () => {
  it("idle → starting → listening → transcribing → cleaning → done, inserting at the cursor", async () => {
    const rig = fakeRig();
    const c = new DictationController(rig.deps);
    const phases: DictationPhase[] = [];
    c.subscribe((s) => { if (phases[phases.length - 1] !== s.phase) phases.push(s.phase); });
    const el = field("Tests pass");
    expect(c.getState().phase).toBe("idle");
    await c.start(el);
    expect(c.getState().phase).toBe("starting");
    expect(rig.engine.kind).toBe("cloud");
    rig.engine.ready();
    expect(c.getState().phase).toBe("listening");
    expect(c.getState().targetLabel).toBe("Done when");
    rig.mic.frame();
    rig.mic.level(0.6);
    rig.engine.say("um and the", "docs are");
    expect(c.getState()).toMatchObject({ final: "um and the", interim: "docs are" });
    expect(c.getState().levels.slice(-1)[0]).toBe(0.6);
    expect(rig.engine.pushed).toBe(1);
    rig.engine.result = "um and the docs are updated";
    await c.stop();
    expect(rig.mic.stopped).toBe(true);
    expect(rig.cleanups).toEqual(["um and the docs are updated"]);
    expect(c.getState().phase).toBe("done");
    expect(c.getState().cleaned).toBe(true);
    expect(el.value).toBe("Tests pass And the docs are updated.");
    expect(phases).toEqual(["starting", "listening", "transcribing", "cleaning", "done"]);
  });

  it("frames that arrive before the engine exists are not lost", async () => {
    const rig = fakeRig();
    const orig = rig.deps.startCapture;
    rig.deps.startCapture = async (o) => { const cap = await orig(o); o.onFrame(new Float32Array(10)); return cap; };
    const c = new DictationController(rig.deps);
    await c.start(field());
    expect(rig.engine.pushed).toBe(1);
  });

  it("Esc (cancel) inserts nothing and releases the mic + engine", async () => {
    const rig = fakeRig();
    const c = new DictationController(rig.deps);
    const el = field("keep me");
    await c.start(el);
    rig.engine.ready();
    rig.engine.say("throw this away");
    c.cancel();
    expect(c.getState().phase).toBe("idle");
    expect(rig.engine.cancelled).toBe(true);
    expect(rig.mic.stopped).toBe(true);
    expect(el.value).toBe("keep me");
  });

  it("Undo restores the field exactly; Use original swaps the clean-up back to the raw words", async () => {
    const rig = fakeRig();
    const c = new DictationController(rig.deps);
    const el = field("");
    await c.start(el);
    rig.engine.ready();
    rig.engine.result = "um ship the fix today";
    await c.stop();
    expect(el.value).toBe("Ship the fix today.");
    c.useOriginal();
    expect(el.value).toBe("Um ship the fix today");
    expect(c.getState().cleaned).toBe(false);
    c.undo();
    expect(el.value).toBe("");
    expect(c.getState().phase).toBe("idle");
  });

  it("no clean-up when turned off — the raw words land", async () => {
    const rig = fakeRig({ cleanup: false });
    const c = new DictationController(rig.deps);
    const el = field("");
    await c.start(el);
    rig.engine.result = "um raw words please";
    await c.stop();
    expect(rig.cleanups).toEqual([]);
    expect(el.value).toBe("Um raw words please");
    expect(c.getState()).toMatchObject({ phase: "done", cleaned: false });
  });

  it("microphone denied → error with plain words, nothing inserted", async () => {
    const rig = fakeRig();
    rig.deps.startCapture = async () => { throw new MicError("denied", "Microphone access is blocked. Allow it…"); };
    const c = new DictationController(rig.deps);
    const el = field("x");
    await c.start(el);
    expect(c.getState().phase).toBe("error");
    expect(c.getState().error).toMatch(/Microphone access is blocked/);
    expect(el.value).toBe("x");
  });

  it("no engine available → error that links to Settings › Voice", async () => {
    const rig = fakeRig({}, { providers: [], default_provider: null, cloud_available: false, cleanup_available: false, max_seconds: 600 });
    rig.deps.deviceSupported = () => false;
    const c = new DictationController(rig.deps);
    await c.start(field());
    expect(c.getState()).toMatchObject({ phase: "error", errorSettings: true });
    expect(c.getState().error).toMatch(/Settings › Voice/);
    expect(rig.mic.opts).toBeNull(); // never touched the microphone
  });

  it("falls back to on-device when the project has no speech key (Auto)", async () => {
    const rig = fakeRig({}, { providers: [], default_provider: null, cloud_available: false, cleanup_available: false, max_seconds: 600 });
    const c = new DictationController(rig.deps);
    await c.start(field());
    expect(rig.engine.kind).toBe("device");
    expect(c.getState().phase).toBe("listening");
  });

  it("an engine failure mid-dictation is an error; a failure on stop keeps the field", async () => {
    const rig = fakeRig();
    const c = new DictationController(rig.deps);
    const el = field("a");
    await c.start(el);
    rig.engine.opts!.onError!(new EngineError("unavailable", "No speech provider is set up for this project. Add one in Settings › Voice."));
    expect(c.getState()).toMatchObject({ phase: "error", errorSettings: true });

    const rig2 = fakeRig();
    const c2 = new DictationController(rig2.deps);
    const el2 = field("b");
    await c2.start(el2);
    rig2.engine.fail = new EngineError("closed", "The connection to the speech service dropped.");
    await c2.stop();
    expect(c2.getState()).toMatchObject({ phase: "error", error: "The connection to the speech service dropped." });
    expect(el2.value).toBe("b");
  });

  it("silence → a gentle error, nothing inserted", async () => {
    const rig = fakeRig();
    const c = new DictationController(rig.deps);
    const el = field("");
    await c.start(el);
    rig.engine.result = "   ";
    await c.stop();
    expect(c.getState().phase).toBe("error");
    expect(el.value).toBe("");
  });

  it("stop pressed while the mic is still opening finishes as soon as it opens", async () => {
    const rig = fakeRig();
    let release: () => void = () => undefined;
    const orig = rig.deps.startCapture;
    rig.deps.startCapture = (o) => new Promise((res) => { release = () => res(orig(o)); });
    const c = new DictationController(rig.deps);
    const el = field("");
    const p = c.start(el);
    await flush();
    void c.stop();
    rig.engine.result = "quick note here";
    release();
    await p;
    await flush(); await flush(); await flush();
    expect(rig.engine.stopped).toBe(true);
  });

  it("a second start while active is ignored", async () => {
    const rig = fakeRig();
    const c = new DictationController(rig.deps);
    const a = field("");
    await c.start(a);
    await c.start(field(""));
    expect(c.getTarget()).toBe(a);
  });
});
