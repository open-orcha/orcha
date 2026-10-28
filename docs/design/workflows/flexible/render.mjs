// Renders every frame of flexible.html to renders/<id>-<theme>.png.
//   node render.mjs [--theme dark|light|both] [--frames x01,x02] [--chrome /path/to/chrome]
// Needs puppeteer-core on NODE_PATH (npm i puppeteer-core), e.g. NODE_PATH=/tmp/pptr/node_modules.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : null).filter(Boolean));
const req = createRequire(process.env.PUPPETEER_DIR ? path.join(process.env.PUPPETEER_DIR, "x.js") : import.meta.url);
const puppeteer = req("puppeteer-core");
const chrome = args.chrome ?? process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const themes = args.theme === "both" || !args.theme ? ["dark", "light"] : [args.theme];
const only = args.frames ? new Set(args.frames.split(",")) : null;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--allow-file-access-from-files"] });
const url = pathToFileURL(path.join(here, "flexible.html")).href;
for (const theme of themes) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${url}?theme=${theme}`, { waitUntil: "networkidle0" });
  const frames = await page.$$eval(".frame", (els) => els.map((e) => ({ id: e.id, w: Number(e.dataset.viewport || 1440) })));
  for (const f of frames) {
    if (only && !only.has(f.id)) continue;
    await page.setViewport({ width: f.w, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${url}?theme=${theme}&frame=${f.id}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$("#" + f.id);
    await el.evaluate((e) => { e.scrollIntoView({ block: "start" }); const sc = e.querySelector(".v2-content"); if (sc && e.dataset.scroll) sc.scrollTop = Number(e.dataset.scroll); });
    await new Promise((r) => setTimeout(r, 150));
    await el.screenshot({ path: path.join(here, "renders", `${f.id}-${theme}.png`) });
    console.log("rendered", f.id, theme);
  }
  await page.close();
}
await browser.close();
