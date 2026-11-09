import { Info, MonitorSmartphone } from "../map/kit/icons";
import type { CSSProperties, ReactNode } from "react";
import { PlatformIcon } from "../map/kit";
import { cn } from "../map/kit";
import hero from "./hero.module.css";
import { coverageWords, PLATFORM_WORD } from "./model";
import { Num } from "./num";
import { countedWords, share, summarize, type PartKey } from "./summary";
import { keyboardFocus, TipBubble, useTip } from "./tip";
import type { Atlas, Platform } from "./types";

const TONE: Record<PartKey, string> = {
  same: hero.toneSame,
  differs: hero.toneDiffers,
  missing: hero.toneMissing,
  unchecked: hero.toneUnchecked,
  seen: hero.toneSeen,
  unseen: hero.toneUnseen,
};

/** Each part's `data-atlas-count`, as the header has always named them. */
const COUNT_ID: Record<PartKey, string> = { same: "the same", differs: "differ", missing: "missing", unchecked: "not compared yet", seen: "seen live", unseen: "never seen" };

/**
 * One of the header's counts, its number and words. One that says what it counts (`title`) is a
 * toggletip: hover it, Tab to it or press it to read what it counts; Escape puts it away. The
 * number glides when the atlas fills in.
 */
export function Count({ n, label, tone, title, id, big = false, i = 0 }: { n: number; label: string; tone?: string; title?: string; id?: string; big?: boolean; i?: number }) {
  const tip = useTip();
  const body = (
    <>
      {tone ? <span className={cn(hero.dot, tone)} aria-hidden /> : null}
      <Num value={n} className={cn(hero.countNum, big && hero.countBig)} delay={120 + i * 60} />
      <span className={hero.countLabel}>{label}</span>
    </>
  );
  if (!title) {
    return (
      <span className={hero.count} data-atlas-count={id ?? label}>
        {body}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        aria-describedby={tip.describedBy}
        aria-expanded={tip.open}
        className={cn(hero.count, hero.countTip)}
        onClick={(e) => tip.show(e.currentTarget, true)}
        onMouseEnter={(e) => tip.show(e.currentTarget)}
        onMouseLeave={() => tip.hide()}
        onFocus={(e) => keyboardFocus(e.currentTarget) && tip.show(e.currentTarget, true)}
        onBlur={() => tip.hide(true)}
        data-atlas-count={id ?? label}
      >
        {body}
      </button>
      <TipBubble tip={tip} words={title}>
        <span className="block font-semibold">
          {n} {label}
        </span>
        <span className="mt-1 block text-fg-2">{title}</span>
      </TipBubble>
    </>
  );
}

/** How the atlas counts, said under its number; the note squares it with the App map and Coverage. */
function Counted({ line, note }: { line: string; note: string | null }) {
  const tip = useTip();
  if (!note) return <p className={hero.counted}>{line}</p>;
  return (
    <p className={hero.counted} data-atlas-counted>
      <button
        type="button"
        className={hero.countedTip}
        aria-describedby={tip.describedBy}
        aria-expanded={tip.open}
        onClick={(e) => tip.show(e.currentTarget, true)}
        onMouseEnter={(e) => tip.show(e.currentTarget)}
        onMouseLeave={() => tip.hide()}
        onFocus={(e) => keyboardFocus(e.currentTarget) && tip.show(e.currentTarget, true)}
        onBlur={() => tip.hide(true)}
      >
        {line}
        <Info className="size-3.5" aria-hidden />
      </button>
      <TipBubble tip={tip} words={note}>
        <span className="block font-semibold">{line}</span>
        <span className="mt-1 block text-fg-2" data-atlas-counted-note>
          {note}
        </span>
      </TipBubble>
    </p>
  );
}

/** A ring that fills to `part` of `whole`, drawn in once (stroke only, decorative). */
function Ring({ part, whole }: { part: number; whole: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const p = whole ? Math.min(1, part / whole) : 0;
  return (
    <svg viewBox="0 0 40 40" className={hero.ring} aria-hidden>
      <circle cx="20" cy="20" r={r} className={hero.ringTrack} />
      <circle cx="20" cy="20" r={r} className={hero.ringFill} style={{ strokeDasharray: `${c}`, "--ring-off": `${c * (1 - p)}`, "--ring-from": `${c}` } as CSSProperties} />
    </svg>
  );
}

/**
 * The atlas's header: its name, how many screens it holds and how it counts them (honestly beside
 * the App map's and Coverage's per-platform count), what each platform holds, which kinds of device
 * and appearances its looks were taken on ("Phones: iOS and Android, light and dark"), and one bar of every
 * screen split by what is known about its platforms, the counts under it as its legend. The
 * numbers count up when the page opens and glide as the atlas fills in; the bar grows in from the
 * left. `actions` are the header's buttons (changed since, export, refresh, play).
 */
export function AtlasHero({ atlas, actions, since, platformAction }: { atlas: Atlas; actions: ReactNode; since?: ReactNode; platformAction?: (platform: Platform) => ReactNode }) {
  const sum = summarize(atlas);
  const { line, note } = countedWords(atlas, sum);
  const c = atlas.counts;
  const total = sum.parts.reduce((n, p) => n + p.n, 0) || 1;
  const multi = atlas.platforms.length > 1;
  const covered = coverageWords(atlas);
  return (
    <header className={hero.hero} data-atlas-header>
      <div className={hero.main}>
        <h1 className={hero.eyebrow}>
          Screen atlas{atlas.name ? <span className={hero.eyebrowName}> · {atlas.name}</span> : null}
        </h1>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className={hero.total} data-atlas-count={c.screens === 1 ? "screen" : "screens"}>
            <Num value={c.screens} className="tabular-nums" />
            <span className={hero.totalWord}>{c.screens === 1 ? "screen" : "screens"}</span>
          </p>
          {line ? <Counted line={line} note={note} /> : null}
        </div>
        <ul className={hero.platforms} aria-label="On each platform">
          {sum.platforms.map((p, i) => (
            <li key={p.platform} className={hero.platform} style={{ "--i": i } as CSSProperties} data-atlas-platform-sum={p.platform}>
              <PlatformIcon kind={p.platform} className="size-3.5" />
              <span className="font-medium text-fg">{PLATFORM_WORD[p.platform]}</span>
              {p.unknown ? (
                <span className="text-muted">not matched yet</span>
              ) : (
                <span className="text-muted" title={`${p.on} ${p.on === 1 ? "screen" : "screens"} on ${PLATFORM_WORD[p.platform]}, ${p.seen} seen live there`}>
                  <span className="tabular-nums text-fg-2">{p.on}</span> {p.on === 1 ? "screen" : "screens"} · <span className="tabular-nums text-fg-2">{p.seen}</span> seen
                </span>
              )}
              {platformAction ? platformAction(p.platform) : null}
            </li>
          ))}
        </ul>
        {covered ? (
          <p className={hero.coverage} data-atlas-coverage>
            <MonitorSmartphone className="size-3.5" aria-hidden />
            <span>
              <span className="sr-only">Seen on: </span>
              {covered}
            </span>
          </p>
        ) : null}
        <div className={hero.summary}>
          <div
            className={hero.bar}
            role="img"
            aria-label={`${c.screens} ${c.screens === 1 ? "screen" : "screens"}: ${sum.parts.map((p) => `${p.n} ${p.label}`).join(", ")}`}
            data-atlas-bar
          >
            {sum.parts
              .filter((p) => p.n > 0)
              .map((p) => (
                <span key={p.key} className={cn(hero.seg, TONE[p.key])} style={{ flexGrow: p.n }} title={`${p.n} ${p.label}, ${share(p.n, total)}%`} data-atlas-bar-part={p.key} />
              ))}
          </div>
          <div className={hero.legend} data-atlas-counts>
            {sum.parts.map((p, i) => (
              <Count key={p.key} n={p.n} label={p.label} tone={TONE[p.key]} title={p.means} id={COUNT_ID[p.key]} i={i} />
            ))}
          </div>
        </div>
      </div>
      <div className={hero.side}>
        <div className={hero.actions}>{actions}</div>
        <div className={hero.kpis}>
          {multi ? (
            <div className={hero.kpi}>
              <Ring part={c.seen} whole={c.screens} />
              <div className="min-w-0">
                <Count n={c.seen} label="seen live" big />
                <p className={hero.kpiSub}>{share(c.seen, c.screens)}% have a screenshot</p>
              </div>
            </div>
          ) : null}
          <div className={hero.kpi}>
            <span className={hero.changedMark} aria-hidden />
            <div className="min-w-0">
              <Count n={c.changed} label="changed" id="changed" big />
              {since ? <div className="mt-1">{since}</div> : <p className={hero.kpiSub}>since {atlas.since.label}</p>}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
