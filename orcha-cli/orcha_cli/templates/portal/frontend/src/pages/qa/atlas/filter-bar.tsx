import { Monitor, Moon, Search, Smartphone, Spline, Sun, Tablet, X } from "../map/kit/icons";
import type { ReactNode } from "react";
import { PlatformIcon } from "../map/kit";
import { Select } from "../map/kit";
import { cn } from "../map/kit";
import board from "./board.module.css";
import { APPEARANCE_WORD, FORM_WORD, hasFilters, PLATFORM_WORD, shownWords, type AtlasFilters } from "./model";
import { keyboardFocus, TipBubble, useTip } from "./tip";
import { APPEARANCES, DEVICE_FORMS, type Appearance, type Atlas, type DeviceForm } from "./types";

const FORM_ICON: Record<DeviceForm, typeof Smartphone> = { phone: Smartphone, tablet: Tablet, desktop: Monitor };
const SHADE_ICON: Record<Appearance, typeof Sun> = { light: Sun, dark: Moon };

/** The kinds of device and the appearances the atlas has looks on (a filter with one choice is no filter). */
export function deviceChoices(atlas: Pick<Atlas, "coverage">): { forms: DeviceForm[]; shades: Appearance[] } {
  const forms = DEVICE_FORMS.filter((f) => atlas.coverage.some((c) => c.form === f && Object.keys(c.platforms).length));
  const shades = APPEARANCES.filter((a) => atlas.coverage.some((c) => Object.values(c.platforms).some((list) => list?.includes(a))));
  return { forms, shades };
}

const flip = <T,>(list: readonly T[], x: T): T[] => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

/** A toggle in the filter bar: pressed or not, said to a screen reader; one that needs it says
 * what it keeps on hover and keyboard focus (`explain`). */
function Toggle({ on, onClick, children, data, explain, className }: { on: boolean; onClick: () => void; children: ReactNode; data: string; explain?: string; className?: string }) {
  const tip = useTip();
  return (
    <>
      <button
        type="button"
        aria-pressed={on}
        onClick={onClick}
        aria-describedby={explain ? tip.describedBy : undefined}
        onMouseEnter={explain ? (e) => tip.show(e.currentTarget) : undefined}
        onMouseLeave={explain ? () => tip.hide() : undefined}
        onFocus={explain ? (e) => keyboardFocus(e.currentTarget) && tip.show(e.currentTarget, true) : undefined}
        onBlur={explain ? () => tip.hide(true) : undefined}
        className={cn(board.toggle, className)}
        data-atlas-filter={data}
      >
        {children}
      </button>
      {explain ? (
        <TipBubble tip={tip} words={explain}>
          {explain}
        </TipBubble>
      ) : null}
    </>
  );
}

/**
 * The filter bar, sticky over the storyboard: the area, the platforms (a segmented group), the kind
 * of device and the appearance the looks were taken in (each only when the atlas has more than one),
 * what to show (differs, changed, never seen), a search, and the flow arrows; then how many screens
 * the filters keep, a way to clear them and the App map. Calm by default: a pressed filter is a soft
 * tint, not a solid block, so the bar never shouts over the screenshots.
 */
export function FilterBar({
  atlas,
  filters,
  set,
  clear,
  kept,
  onArrows,
  stuck = false,
}: {
  atlas: Atlas;
  filters: AtlasFilters;
  set: (patch: Partial<AtlasFilters>) => void;
  clear: () => void;
  kept: number;
  /** The arrows are being turned on: they draw in. */
  onArrows: () => void;
  /** The header has scrolled away: the bar lifts off the storyboard. */
  stuck?: boolean;
}) {
  const multi = atlas.platforms.length > 1;
  const { forms, shades } = deviceChoices(atlas);
  const devices = filters.devices ?? [];
  const appearances = filters.appearances ?? [];
  return (
    <div className={board.filters} role="toolbar" aria-label="Filter the atlas" data-stuck={stuck || undefined} data-atlas-filters>
      <Select
        aria-label="Area"
        wrapperClassName="w-[164px]"
        value={filters.area ?? ""}
        onChange={(e) => set({ area: e.target.value || null })}
        options={[{ value: "", label: "All areas" }, ...atlas.areas.map((a) => ({ value: a.key, label: a.name, hint: String(a.screens.length) }))]}
        data-atlas-area-filter
      />
      {multi ? (
        <div className={board.group} role="group" aria-label="Platforms">
          {atlas.platforms.map((p) => (
            <Toggle key={p} on={filters.platforms.includes(p)} onClick={() => set({ platforms: filters.platforms.includes(p) ? filters.platforms.filter((x) => x !== p) : [...filters.platforms, p] })} data={`platform:${p}`}>
              <PlatformIcon kind={p} className="size-3" />
              {PLATFORM_WORD[p]}
            </Toggle>
          ))}
        </div>
      ) : null}
      {forms.length > 1 || devices.length ? (
        <div className={board.group} role="group" aria-label="Device">
          {(forms.length > 1 ? forms : devices).map((d) => {
            const Icon = FORM_ICON[d];
            return (
              <Toggle key={d} on={devices.includes(d)} onClick={() => set({ devices: flip(devices, d) })} data={`device:${d}`} explain={`Only screenshots taken on a ${FORM_WORD[d].toLowerCase()}${d === "desktop" ? " or in a desktop browser" : ""}.`}>
                <Icon className="size-3" aria-hidden />
                {FORM_WORD[d]}
              </Toggle>
            );
          })}
        </div>
      ) : null}
      {shades.length > 1 || appearances.length ? (
        <div className={board.group} role="group" aria-label="Appearance">
          {(shades.length > 1 ? shades : appearances).map((a) => {
            const Icon = SHADE_ICON[a];
            return (
              <Toggle key={a} on={appearances.includes(a)} onClick={() => set({ appearances: flip(appearances, a) })} data={`appearance:${a}`} explain={`Only screenshots that show the app in ${a} mode.`}>
                <Icon className="size-3" aria-hidden />
                {APPEARANCE_WORD[a]}
              </Toggle>
            );
          })}
        </div>
      ) : null}
      <div className={board.group} role="group" aria-label="Show only">
        <span className={board.groupWord} aria-hidden>
          Only
        </span>
        {multi ? (
          <Toggle on={filters.differs} onClick={() => set({ differs: !filters.differs })} data="differs" explain="Differs across platforms: screens that read or look different where seen live, and screens not on every platform.">
            <span className={cn(board.lensDot, board.lensDiffers)} aria-hidden />
            Differs
          </Toggle>
        ) : null}
        <Toggle on={filters.changed} onClick={() => set({ changed: !filters.changed })} data="changed">
          <span className={cn(board.lensDot, board.lensChanged)} aria-hidden />
          Changed
        </Toggle>
        <Toggle on={filters.neverSeen} onClick={() => set({ neverSeen: !filters.neverSeen })} data="never_seen">
          <span className={cn(board.lensDot, board.lensNever)} aria-hidden />
          Never seen live
        </Toggle>
      </div>
      <label className={board.search}>
        <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted" aria-hidden />
        <input type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Find a screen" aria-label="Find a screen" data-atlas-search />
      </label>
      <div className="ml-auto flex items-center gap-2">
        <Toggle
          on={filters.arrows}
          onClick={() => {
            if (!filters.arrows) onArrows();
            set({ arrows: !filters.arrows });
          }}
          data="arrows"
          className={board.switch}
        >
          <span className={board.switchTrack} aria-hidden>
            <span className={board.switchKnob} />
          </span>
          <Spline className="size-3" aria-hidden />
          Flow arrows
        </Toggle>
        <span className="flex items-center gap-2 whitespace-nowrap text-xs text-muted" aria-live="polite">
          <span data-atlas-kept>{shownWords(kept, atlas.counts.screens)}</span>
          {hasFilters(filters) ? (
            <button type="button" className={board.clear} onClick={clear} data-atlas-clear>
              <X className="size-3" aria-hidden /> Clear
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
