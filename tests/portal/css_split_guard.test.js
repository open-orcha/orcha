/* ============================================================================
   Split-fragment guard — every shared stylesheet must parse STANDALONE.

   Root cause of "the theme toggle does nothing" with the Swiss skin active:
   the #191 file-split severed styles.css MID-RULE at two seams —
     - conversation.css ended with the swiss-dark rule UNCLOSED (EOF auto-close
       kept its first half working), and responsive.css began with the rule's
       orphaned second half + a stray "}". CSS error recovery consumes
       everything up to the first "{" as an invalid selector prelude, which
       swallowed the ENTIRE html[data-skin="swiss"][data-theme="light"] rule
       that followed. cycleTheme flipped data-theme on <html>, but an explicit
       "light" had no Swiss tokens, so the page stayed dark.
     - overlays.css ended with the .pair-remedy rule UNCLOSED at EOF.

   This suite makes that class of damage impossible to reintroduce silently:
   every shared stylesheet must balance braces, carry no stray top-level "}",
   and have nothing declaration-like before its first rule. (Orcha V2 retired
   the skins, responsive.css included; the entrypoint check below now pins that
   every imported sheet exists and the V2 layers load last.)

   Run:  node tests/portal/css_split_guard.test.js
   (No package.json / npm install needed — uses only Node built-ins.)
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const STYLES = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "styles"
);
const read = (name) => fs.readFileSync(path.join(STYLES, name), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

function cssIntegrityTests() {
  console.log("\nshared stylesheets parse standalone (split-fragment guard)\n");
  const SHEETS = ["tokens.css", "shell.css", "components.css", "overlays.css",
    "conversation.css",
    // Orcha V2 layers (imported last by styles.css)
    "v2-tokens.css", "v2-primitives.css", "v2-shell.css"];
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const name of SHEETS) {
    const css = stripComments(read(name));
    let depth = 0, minDepth = 0;
    for (const ch of css) {
      if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth < minDepth) minDepth = depth; }
    }
    assert(depth === 0, `styles/${name}: braces balance (no rule severed at EOF)`);
    assert(minDepth === 0, `styles/${name}: no stray top-level "}" (no severed head)`);
    // A ";" before the first "{" can only be an orphaned declaration tail —
    // the exact fragment shape that eats the next rule via error recovery.
    const head = css.slice(0, css.indexOf("{") >= 0 ? css.indexOf("{") : css.length);
    assert(head.indexOf(";") < 0 && head.indexOf("}") < 0,
      `styles/${name}: nothing declaration-like before the first rule`);
  }
  // V2: the decorative skins (responsive.css = Swiss, skin-minimal, skin-gold)
  // were retired; the entrypoint must not import a sheet that no longer ships,
  // and every sheet it imports must exist (a missing @import is a silent 404).
  const entry = stripComments(fs.readFileSync(path.join(STYLES, "..", "styles.css"), "utf8"));
  const imports = [...entry.matchAll(/@import\s+url\("\/assets\/styles\/([\w.-]+)"\)/g)].map((m) => m[1]);
  for (const retired of ["responsive.css", "skin-minimal.css", "skin-gold.css"]) {
    assert(imports.indexOf(retired) < 0, `styles.css no longer imports retired skin ${retired}`);
  }
  for (const name of imports) {
    assert(fs.existsSync(path.join(STYLES, name)), `styles.css import ${name} exists`);
  }
  assert(imports[imports.length - 1] === "v2-shell.css" && imports.indexOf("v2-tokens.css") > imports.indexOf("skeleton.css"),
    "V2 layers are imported last (tokens → primitives → shell)");
}

function run() {
  console.log("css_split_guard.test.js\n");
  cssIntegrityTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
