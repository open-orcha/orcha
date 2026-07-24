/* Settings page module: skin picker, shell mount, loading, and helper exports. */
/* ---- appearance: portal design (skin) picker --------------------------- *
 * Browser-local (localStorage "orcha:skin"), no API — mirrors the theme
 * toggle's contract. "classic" = the shipped teal look (no attribute);
 * "swiss" = the sharp indigo direction, applied as data-skin on <html>.
 * Every page's pre-paint <head> script reads the same key, so the pick
 * sticks across the whole portal with no flash. */
const SKINS = [
  { id: "classic", name: "Classic", desc: "Teal accent, rounded corners, soft shadows — the original Orcha look.",
    sw: ["#111620", "#1fc7cd", "#f2a83c", "#e8edf6"] },
  { id: "swiss", name: "Swiss", desc: "Electric indigo, sharp corners, mono status chips — dense engineering grid.",
    sw: ["#151517", "#5a72ff", "#ff7a52", "#f2f2ee"] },
];
function currentSkin() {
  try { const s = localStorage.getItem("orcha:skin"); return SKINS.some((k) => k.id === s) ? s : "classic"; }
  catch (e) { return "classic"; }
}
function applySkin(id) {
  const d = document.documentElement;
  if (id === "classic") d.removeAttribute("data-skin"); else d.setAttribute("data-skin", id);
  try { localStorage.setItem("orcha:skin", id); } catch (e) {}
}
function renderSkins() {
  const host = document.getElementById("skinGrid");
  if (!host) return;
  const cur = currentSkin();
  host.innerHTML = SKINS.map((k) => `
    <button type="button" class="skin-tile${k.id === cur ? " on" : ""}" data-skin="${k.id}">
      <div class="sw">${k.sw.map((c) => `<i style="background:${c}"></i>`).join("")}</div>
      <div class="nm">${SetEsc(k.name)}${k.id === cur ? SetIcon("check", "") : ""}</div>
      <div class="ds">${SetEsc(k.desc)}</div>
    </button>`).join("");
  host.querySelectorAll(".skin-tile").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-skin");
      if (id === currentSkin()) return;
      applySkin(id);
      renderSkins();
      O.toast("Design · " + (SKINS.find((k) => k.id === id) || {}).name, "ok");
    });
  });
}

/* ---- boot: live shell off the snapshot; key status fetched once ------ */
let booted = false;
function render() {
  if (!window.ORCHA || !window.ORCHA.container) return;
  O.mountShell("settings", { title: "Settings", ctx: window.ORCHA.container.name });
}
window.OrchaData.start(() => {
  render();
  if (!booted) { booted = true; renderPairingCard(); renderSkins(); renderKey(); renderProviderKeys(); renderModels(); }   // paint loading cards once the shell exists
}, 3000);

(async function init() {
  try { CID = await window.OrchaData.resolveCid(); } catch (e) {}
  loadKey();
  loadProviderKeys();
  loadModels();
})();

// expose the pure view-model helpers for node tests
window.OrchaSettings = {
  keyState, looksLikeKey, maskOptimistic,
  modelsForProvider, currentSel, isOverride, rowDirty, buildOverrides,
};
