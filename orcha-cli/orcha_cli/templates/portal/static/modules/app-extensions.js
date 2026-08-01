/* Orcha portal extension convention (SEAM B / #212).
 *
 * Core defines `window.OrchaExt` — a tiny append-only registry — BEFORE any page
 * script runs. A downstream distribution ships ONE optional file,
 * `static/extensions/index.js`, that calls the registrars below to add nav items,
 * settings tabs, and task-detail sections. Core render sites read the registry
 * back through `_consume(kind)` and fold the registrations into their own markup.
 *
 * THE ONE RULE — extensions must NEVER patch core files.
 * An extension adds surface ONLY through the registrars on this object. It must not
 * edit, monkey-patch, or reach into any core module, page script, or DOM that core
 * owns. Core ships this registry so downstream can extend WITHOUT forking; the moment
 * an extension mutates a core file it defeats the seam and breaks clean upgrades.
 * If a hook you need is missing, the fix is a new registrar here in core — not a patch
 * from the extension side.
 *
 * ABSENT extensions = byte-identical core render. Core ships an empty stub
 * `extensions/index.js` (comment-only) so the request never 404s; even if that file
 * is missing the loader tolerates the 404 and every `_consume(kind)` returns []. A
 * portal with no registrations renders exactly as it did before this seam existed.
 */
(function () {
  if (window.OrchaExt) return;   // idempotent: first loader on the page wins

  // Registration buckets, keyed by the three consume-site kinds. Append-only.
  var reg = { nav: [], settingsTab: [], taskDetailSection: [] };

  // Order is a stable sort key; unspecified entries sort AFTER numbered ones,
  // then by registration order (which push() preserves) — never throws on a
  // partial/mistyped registration, it just ignores what it can't use.
  function add(bucket, entry, keep) {
    if (!entry || typeof entry !== "object") return;
    var out = { id: entry.id != null ? String(entry.id) : "" };
    for (var i = 0; i < keep.length; i++) {
      var k = keep[i];
      if (entry[k] !== undefined) out[k] = entry[k];
    }
    out.order = typeof entry.order === "number" ? entry.order : null;
    reg[bucket].push(out);
  }

  window.OrchaExt = {
    // Shell nav entry: { id, label, href, order? } — rendered into the sidebar nav.
    registerNavItem: function (item) { add("nav", item, ["label", "href"]); },

    // Settings page extra tab: { id, label, render(el) } — render(el) paints into a host node.
    registerSettingsTab: function (tab) { add("settingsTab", tab, ["label", "render"]); },

    // Task-detail section: { id, order?, render(el, task) } — rendered below Definition of done.
    registerTaskDetailSection: function (section) { add("taskDetailSection", section, ["render"]); },

    // Core render sites call this to fold registrations in. Returns a NEW array
    // (order-sorted) so a consume site can never mutate the registry. Unknown kind → [].
    _consume: function (kind) {
      var map = { nav: "nav", settingsTab: "settingsTab", taskDetailSection: "taskDetailSection" };
      var bucket = map[kind];
      if (!bucket) return [];
      return reg[bucket].slice().sort(function (a, b) {
        var ao = a.order == null ? Infinity : a.order;
        var bo = b.order == null ? Infinity : b.order;
        return ao - bo;   // stable in V8 for equal keys → preserves registration order
      });
    },
  };
})();
