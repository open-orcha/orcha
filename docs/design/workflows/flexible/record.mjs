// Records the eight use-case walkthroughs (A–H) of flexible.html as short videos.
//   node record.mjs [--only A,C] [--theme dark|light] [--chrome /path/to/chrome] [--no-gif]
// For each walkthrough: a title card, then the cursor glides to every spec callout of the frame while a
// caption bar explains it; multi-frame walkthroughs crossfade between frames. Output per walkthrough:
// walkthroughs/wt-<id>.webm (raw screencast), wt-<id>.mp4 (1440x900, h264) and wt-<id>.gif (960 wide, 10 fps).
// Needs puppeteer-core (PUPPETEER_DIR=/path/with/node_modules) and ffmpeg on PATH. Same chrome resolution as render.mjs.
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : null).filter(Boolean));
const req = createRequire(process.env.PUPPETEER_DIR ? path.join(process.env.PUPPETEER_DIR, "x.js") : import.meta.url);
const puppeteer = req("puppeteer-core");
const chrome = args.chrome ?? process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const theme = args.theme === "light" ? "light" : "dark";
const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
const outDir = path.join(here, "walkthroughs");
fs.mkdirSync(outDir, { recursive: true });

// A step is either { frame, note } (glide to spec callout N of that frame) or { frame, text } (glide to the
// first .wf-card-h whose text contains `find`). `say` is the caption.
const WALKTHROUGHS = [
  { id: "A", title: "Set up a two-step loop", summary: "Create workflow: outcomes per step, what happens next, a Repeat group and an approval gate; then the Start review.", steps: [
    { frame: "x01", note: 1, say: "Steps replace Tasks only as a label. Each step is still a task with an assignee and an autonomy setting." },
    { frame: "x01", note: 2, say: "Each step lists the outcomes it can report. Only the Reviewer may report Passed or Changes requested." },
    { frame: "x01", note: 3, say: "The second step, Review the post, is assigned to the Reviewer." },
    { frame: "x01", note: 4, say: "What happens next: every outcome has one destination or asks the owner. The ↺ mark means a return inside the loop." },
    { frame: "x01b", find: "Repeat group", say: "The Repeat group names its steps, the review point, the exit outcome and most rounds (5). At the limit it asks Kedar." },
    { frame: "x01b", find: "Approval gate", say: "Step 3 is an approval gate with a named policy: Kedar or Priya, one is enough, no self-review. Each of its three decisions has a destination." },
    { frame: "x02", note: 1, say: "The Start review shows the expected route, with Loop, Gate and Stops-and-asks badges." },
    { frame: "x02", note: 2, say: "Limits: rounds, the agent-turn allowance for this run (set here, default 40) and an estimated cost, labelled as an estimate." },
    { frame: "x02", note: 3, say: "Incomplete settings are listed with links. Start stays disabled until none remain. Priya is starting the run, so Kedar is the approver." },
  ] },
  { id: "B", title: "Watch the loop run", summary: "Round 1 returned Changes requested; round 2 is running with the exact draft and findings it received.", steps: [
    { frame: "x03", note: 1, say: "The group bracket: Round 2 of 5, round dots, the exit rule and who gets asked at the limit." },
    { frame: "x03", note: 2, say: "The running step says which round it is in and what it received: draft v1 and three findings from round 1." },
    { frame: "x03", note: 3, say: "The approval gate sits outside the bracket. It is reached only when the review reports Passed." },
    { frame: "x03", note: 4, say: "The inspector shows round, attempt, why the step runs (the rule that fired) and what it waits on." },
    { frame: "x03", note: 5, say: "Received this round: the exact draft version and the reviewer's findings, in the reviewer's own words." },
  ] },
  { id: "C", title: "Loop limit and stalled loop", summary: "Round 5 still asks for changes, so the owner decides; a loop that repeats itself pauses with the rounds side by side.", steps: [
    { frame: "x04", note: 1, say: "Round 5 still asks for changes. There is no round 6; the owner bar says so in words." },
    { frame: "x04", note: 2, say: "What is still open after the last round, so the owner decides with the facts in view." },
    { frame: "x04", note: 3, say: "More rounds shows the new maximum and the used count. Accept as-is records an override beside the original outcome." },
    { frame: "x04", note: 4, say: "Stop keeps everything. Nothing already produced is thrown away." },
    { frame: "x05", note: 1, say: "A stalled loop pauses and names the two rounds that look alike." },
    { frame: "x05", note: 2, say: "Rounds 2 and 3 side by side, compared on finding ids and file versions. Similar wording is only a warning." },
    { frame: "x05", note: 3, say: "The options show the rounds remaining; the owner can resume with guidance, reassign, accept as-is or stop." },
  ] },
  { id: "D", title: "Feedback across several steps", summary: "A test step reports a requirements defect; the preview shows what repeats and what goes stale before the report is sent.", steps: [
    { frame: "x06", note: 1, say: "Test reports Requirements defect. The outcome picks its route; the reporter cannot change the success criteria." },
    { frame: "x06", note: 2, say: "Findings go in as a list, kept in the reporter's words." },
    { frame: "x06", note: 3, say: "The preview shows what repeats, what becomes stale (a running worker is held), which acceptance needs renewing and what is kept." },
    { frame: "x06", note: 4, say: "Rounds remaining are shown before the report is sent." },
  ] },
  { id: "E", title: "Branch on outcome", summary: "Only the selected path runs; the other path is Not selected, and a missing outcome asks the owner.", steps: [
    { frame: "x07", note: 1, say: "The deciding step and the outcome it reported." },
    { frame: "x07", note: 2, say: "The path not taken is Not selected: dotted route, struck title, not a failure." },
    { frame: "x07", note: 3, say: "Only the selected path runs, drawn with a solid route." },
    { frame: "x07", note: 4, say: "A missing outcome asks the owner instead of guessing a path." },
    { frame: "x07", note: 5, say: "Why this path explains the rule that chose it." },
  ] },
  { id: "F", title: "Reusable approval policy", summary: "An approval gate opens for an exact version under a named policy; policies are set up once and reused.", steps: [
    { frame: "x08", note: 1, say: "The gate header names the policy version, the eligible approvers and what the decision permits. The reviewer's Passed is a result, not an approval." },
    { frame: "x08", note: 2, say: "The exact version being approved, with its review." },
    { frame: "x08", note: 3, say: "A changed draft (v4) needs a fresh decision. Saying approved in chat does not open the gate." },
    { frame: "x08", note: 4, say: "Three decisions with their consequences. Request changes sends the work back for a new round and reopens the gate; Decline takes its declared path." },
    { frame: "x08", note: 5, say: "The edits field and the sentence that says where the work goes next." },
    { frame: "x09", note: 1, say: "Gate approvals join the Needs-your-input strip." },
    { frame: "x09", note: 2, say: "Policies are named and versioned, with where each one is used." },
    { frame: "x09", note: 3, say: "A policy: people only, one-of or all, no self-review, a deadline that never approves by itself, and what approval permits." },
    { frame: "x09", note: 4, say: "Where used shows the version each run holds. Saving creates version 3 for new runs only." },
  ] },
  { id: "G", title: "Recovery", summary: "After a restart Orcha picks up the history, keeps the live worker and asks before retrying a publish with no receipt.", steps: [
    { frame: "x10", note: 1, say: "After a restart the bar says, in words, that history was picked up and nothing was retried automatically." },
    { frame: "x10", note: 2, say: "Activity shows the route saved before the step started, and the publisher's live worker kept rather than duplicated, with no receipt yet." },
    { frame: "x10", note: 3, say: "What Orcha checked: the action id, the worker and the approved version." },
    { frame: "x10", note: 4, say: "Options: check again, confirm published with a link, retry with the same action id, or stop. Never a duplicate publish." },
  ] },
  { id: "H", title: "Status and finish", summary: "Every step says who, which round, which version and why it waits; Finish is blocked with a plain reason.", steps: [
    { frame: "x11", note: 1, say: "The group bracket with round and exit rule; the header shows agent turns used of the allowance." },
    { frame: "x11", note: 2, say: "Every step says round, who, version, what it waits for, the attempt and any failure reason." },
    { frame: "x11", note: 3, say: "Finish is blocked by an unresolved loop and a live worker, each with a plain reason. The button stays disabled." },
    { frame: "x11", note: 4, say: "Not selected steps never appear in the checklist; scope changes need owner review." },
  ] },
];

const T = { title: 2500, glide: 800, settle: 400, read: 3000, fade: 320, tail: 1300 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OVERLAY_CSS = `
#__cur { position: fixed; left: 0; top: 0; width: 26px; height: 32px; z-index: 1000; pointer-events: none; transform: translate(-6px,-4px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
#__rip { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 2px solid var(--v2-accent, #6f8cff); z-index: 999; pointer-events: none; opacity: 0; transform: scale(.3); }
#__rip.go { animation: __rip .7s ease-out forwards; }
@keyframes __rip { 0% { opacity: .9; transform: scale(.3); } 100% { opacity: 0; transform: scale(1.25); } }
#__cap { position: fixed; left: 0; right: 0; bottom: 0; z-index: 998; display: flex; gap: 18px; align-items: center; min-height: 66px; padding: 12px 24px 14px 24px; background: var(--__capbg); color: var(--__capfg); font: 400 17px/1.35 var(--v2-font-sans, -apple-system, system-ui, sans-serif); border-top: 1px solid var(--v2-border, rgba(255,255,255,.1)); transition: opacity ${T.fade}ms ease; backdrop-filter: blur(6px); }
#__cap b { flex: 0 0 auto; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--v2-accent, #6f8cff); white-space: nowrap; }
#__cap span { flex: 1 1 auto; }
#__cap.hide { opacity: 0; }
#__title { position: fixed; inset: 0; z-index: 1001; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 14px; padding: 0 160px; text-align: center; background: var(--__titlebg); color: var(--__capfg); transition: opacity ${T.fade}ms ease; font-family: var(--v2-font-sans, -apple-system, system-ui, sans-serif); }
#__title .k { font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--v2-accent, #6f8cff); }
#__title .t { font: 600 34px/1.15 var(--v2-font-display, inherit); letter-spacing: -0.012em; }
#__title .s { font-size: 18px; line-height: 1.4; color: var(--v2-text-2, inherit); max-width: 900px; }
#__title.hide { opacity: 0; pointer-events: none; }
#__fade { position: fixed; inset: 0; z-index: 997; background: var(--__titlebg); opacity: 0; pointer-events: none; transition: opacity ${T.fade}ms ease; }
#__fade.on { opacity: 1; }
.note { transition: transform .25s ease, opacity .25s ease; opacity: .38; }
.note.__on { opacity: 1; transform: scale(1.5); box-shadow: 0 0 0 3px var(--v2-window), 0 0 0 7px color-mix(in srgb, var(--v2-accent, #6f8cff) 45%, transparent); }
`;

function installOverlay(theme) {
  const root = document.documentElement;
  root.style.setProperty("--__capbg", theme === "light" ? "rgba(255,255,255,.93)" : "rgba(16,17,20,.90)");
  root.style.setProperty("--__capfg", theme === "light" ? "#1C1D1F" : "#ECEDEF");
  root.style.setProperty("--__titlebg", theme === "light" ? "rgba(244,244,245,.97)" : "rgba(12,13,15,.96)");
  const st = document.createElement("style"); st.id = "__ovcss"; st.textContent = window.__OVERLAY_CSS; document.head.appendChild(st);
  document.body.classList.add("solo");
  document.querySelectorAll(".frame[data-scroll]").forEach((f) => { const c = f.querySelector(".wf-create, .wf-page"); if (c) c.style.marginTop = `-${Number(f.dataset.scroll)}px`; });
  const cur = document.createElement("div"); cur.id = "__cur";
  cur.innerHTML = `<svg viewBox="0 0 26 32" width="26" height="32"><path d="M3 2 L3 25 L9 19.5 L13.5 29 L17.5 27 L13 18 L21 18 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  const rip = document.createElement("div"); rip.id = "__rip";
  const cap = document.createElement("div"); cap.id = "__cap"; cap.className = "hide"; cap.innerHTML = "<b></b><span></span>";
  const title = document.createElement("div"); title.id = "__title"; title.className = "hide"; title.innerHTML = `<div class="k"></div><div class="t"></div><div class="s"></div>`;
  const fade = document.createElement("div"); fade.id = "__fade";
  document.body.append(fade, cap, rip, cur, title);
  window.__cur = { x: 720, y: 450 }; cur.style.transform = `translate(${720 - 6}px, ${450 - 4}px)`;
  window.__glide = (x, y, ms) => new Promise((done) => {
    const from = { ...window.__cur }; const t0 = performance.now();
    const ease = (p) => p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const tick = (now) => { const p = Math.min(1, (now - t0) / ms); const e = ease(p);
      const cx = from.x + (x - from.x) * e, cy = from.y + (y - from.y) * e; window.__cur = { x: cx, y: cy };
      cur.style.transform = `translate(${cx - 6}px, ${cy - 4}px)`; if (p < 1) requestAnimationFrame(tick); else done(); };
    requestAnimationFrame(tick);
  });
  window.__ripple = (x, y) => { rip.classList.remove("go"); void rip.offsetWidth; rip.style.left = x + "px"; rip.style.top = y + "px"; rip.classList.add("go"); };
  window.__caption = (k, text) => { cap.querySelector("b").textContent = k; cap.querySelector("span").textContent = text; cap.classList.toggle("hide", !text); };
  window.__title = (k, t, s) => { title.querySelector(".k").textContent = k; title.querySelector(".t").textContent = t; title.querySelector(".s").textContent = s; title.classList.toggle("hide", !t); };
  window.__fade = (on) => fade.classList.toggle("on", on);
  window.__show = (id) => { document.querySelectorAll(".frame-wrap").forEach((w) => { w.hidden = w.querySelector(".frame").id !== id; }); window.scrollTo(0, 0); document.querySelectorAll(".note.__on").forEach((n) => n.classList.remove("__on")); };
  window.__target = (id, note, find) => {
    const frame = document.getElementById(id); let el = null;
    if (note) el = [...frame.querySelectorAll(":scope > .note, .note")].find((n) => n.textContent.trim() === String(note));
    else if (find) el = [...frame.querySelectorAll(".wf-card-h")].find((h) => h.textContent.includes(find));
    if (!el) return null;
    document.querySelectorAll(".note.__on").forEach((n) => n.classList.remove("__on"));
    const r = el.getBoundingClientRect();
    if (note) { el.classList.add("__on"); return { x: r.left + r.width + 14, y: r.top + r.height / 2 }; }
    return { x: r.left + 10, y: r.top + r.height / 2 };
  };
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--allow-file-access-from-files", "--hide-scrollbars"] });
const url = pathToFileURL(path.join(here, "flexible.html")).href;
for (const wt of WALKTHROUGHS) {
  if (only && !only.has(wt.id)) continue;
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${url}?theme=${theme}`, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((css, th, fn) => { window.__OVERLAY_CSS = css; (new Function("theme", `(${fn})(theme)`))(th); }, OVERLAY_CSS, theme, installOverlay.toString());
  await page.evaluate((id) => window.__show(id), wt.steps[0].frame);
  await sleep(200);
  const webm = path.join(outDir, `wt-${wt.id}.webm`);
  const rec = await page.screencast({ path: webm, ffmpegPath: process.env.FFMPEG || "ffmpeg" });
  // title card
  await page.evaluate((k, t, s) => window.__title(k, t, s), `Walkthrough ${wt.id} · ${theme}`, wt.title, wt.summary);
  await sleep(T.title);
  await page.evaluate(() => window.__title("", "", ""));
  await sleep(T.fade + 200);
  let current = wt.steps[0].frame;
  for (let i = 0; i < wt.steps.length; i++) {
    const s = wt.steps[i];
    if (s.frame !== current) {
      await page.evaluate(() => { window.__caption("", ""); window.__fade(true); });
      await sleep(T.fade + 80);
      await page.evaluate((id) => window.__show(id), s.frame);
      await sleep(120);
      await page.evaluate(() => window.__fade(false));
      await sleep(T.fade + 200);
      current = s.frame;
    }
    const pt = await page.evaluate((id, note, find) => window.__target(id, note, find), s.frame, s.note ?? null, s.find ?? null);
    if (!pt) throw new Error(`walkthrough ${wt.id}: target not found for ${JSON.stringify(s)}`);
    await page.evaluate((x, y, ms) => window.__glide(x, y, ms), pt.x, pt.y, T.glide);
    await page.evaluate((x, y) => window.__ripple(x, y), pt.x, pt.y);
    await sleep(T.settle);
    await page.evaluate((k, t) => window.__caption(k, t), `${wt.id} · ${i + 1} of ${wt.steps.length}`, s.say);
    await sleep(T.read);
  }
  await sleep(T.tail);
  await rec.stop();
  await page.close();
  const mp4 = path.join(outDir, `wt-${wt.id}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-an", "-vf", "scale=1440:-2", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  if (!args["no-gif"]) {
    const gif = path.join(outDir, `wt-${wt.id}.gif`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", "fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=160[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0", gif]);
  }
  const size = (p) => fs.existsSync(p) ? `${(fs.statSync(p).size / 1048576).toFixed(1)} MB` : "-";
  console.log(`recorded ${wt.id}: mp4 ${size(mp4)}, gif ${size(path.join(outDir, `wt-${wt.id}.gif`))}`);
}
await browser.close();
