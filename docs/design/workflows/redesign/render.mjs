// Renders every frame of redesign.html to renders/<id>-<theme>.png.
//   node render.mjs [--theme dark|light|both] [--frames f01,f02] [--chrome /path/to/chrome]
// Needs puppeteer-core next to it or on NODE_PATH:  npm i puppeteer-core
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : null).filter(Boolean));
const puppeteer = (await import(process.env.PUPPETEER_CORE ?? "puppeteer-core")).default;
const chrome = args.chrome ?? process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const themes = args.theme === "both" || !args.theme ? ["dark", "light"] : [args.theme];
const only = args.frames ? new Set(args.frames.split(",")) : null;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--allow-file-access-from-files"] });
const url = pathToFileURL(path.join(here, "redesign.html")).href;
for (const theme of themes) {
  const page = await browser.newPage(); // a fresh page per theme: no state carried across themes
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${url}?theme=${theme}`, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  const frames = await page.$$eval(".frame", (els) => els.map((e) => ({ id: e.id, w: Number(e.dataset.viewport || 1440) })));
  for (const f of frames) {
    if (only && !only.has(f.id)) continue;
    // Render every frame in solo mode: gallery padding otherwise trims 48 px.
    await page.setViewport({ width: f.w, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${url}?theme=${theme}&frame=${f.id}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$("#" + f.id);
    await el.evaluate((e) => e.scrollIntoView({ block: "start" }));
    await new Promise((r) => setTimeout(r, 150));
    await el.screenshot({ path: path.join(here, "renders", `${f.id}-${theme}.png`) });
    console.log("rendered", f.id, theme, f.w);

  }
  await page.close();
}
await browser.close();
