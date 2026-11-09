import { useState } from "react";
import { Moon, Sun, X } from "../../map/kit/icons";
import { SeverityTag } from "../../map/kit";
import { appearanceLabel, auditKindLabel } from "./exploration";
import { elementText, occurrences, screenLabel, type MergedFinding } from "./exploration-list";
import { cn } from "../../map/kit";
import { FindingScreenshot } from "./finding-screenshot";
import { Measurement } from "./finding-row";

const HEX = /^#[0-9a-f]{3,8}$/i;

function Swatch({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i aria-hidden className="inline-block size-3 rounded-sm border border-border" style={{ background: color }} />
      <span className="text-muted">{label}</span>
      <code className="font-mono text-2xs text-fg-2">{color}</code>
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-fg-2">{children}</dd>
    </>
  );
}

/**
 * The detail panel for one list row: the screenshot with the element outlined, the
 * full sentence, the identifier, the measurement against its threshold and — for a
 * merged row — every screen it was seen on, each of which swaps the screenshot.
 *
 * The parent keys this by row, so picking another row starts at its first
 * occurrence instead of carrying an index that may not exist.
 */
export function FindingDetailPanel({ row, onClose }: { row: MergedFinding; onClose: () => void }) {
  const [index, setIndex] = useState(() => Math.max(0, row.findings.indexOf(row.head)));
  const f = row.findings[index] ?? row.head;
  const confident = row.confident;
  const why = typeof f.detail?.why_unconfident === "string" ? f.detail.why_unconfident : null;
  const fg = typeof f.detail?.foreground === "string" && HEX.test(f.detail.foreground) ? f.detail.foreground : null;
  const bg = typeof f.detail?.background === "string" && HEX.test(f.detail.background) ? f.detail.background : null;
  const label = elementText(f);
  const count = row.findings.length;

  return (
    <aside
      className="flex min-w-0 flex-col gap-3 p-3.5"
      data-finding-panel={row.key}
      aria-label={`${auditKindLabel(row.kind)}: ${label}`}
    >
      <div className="flex items-center gap-2">
        {confident ? (
          <SeverityTag severity={row.severity} />
        ) : (
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-dashed border-border px-[7px] text-xs font-medium leading-none text-muted">
            needs a look
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted">{auditKindLabel(row.kind)}</span>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close details"
          data-finding-panel-close
          className="flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <h3 className={cn("text-base font-semibold leading-snug", confident ? "text-fg" : "text-fg-2")}>{label}</h3>

      <FindingScreenshot
        framePath={f.frame_path}
        rect={f.rect}
        label={label}
        alt={`${f.summary} The outlined region is the measured element.`}
      />

      <p className={cn("text-sm leading-snug", confident ? "text-fg" : "text-muted")}>{f.summary}</p>
      {why ? (
        <p className="text-xs leading-snug text-muted">
          <span className="font-medium">Not conclusive:</span> {why}
        </p>
      ) : null}

      <Measurement finding={f} confident={confident} />

      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        {f.element_identifier ? (
          <Fact label="Identifier">
            <code className="rounded-sm bg-panel-2 px-1 py-px font-mono text-2xs text-fg" data-finding-identifier>
              {f.element_identifier}
            </code>
          </Fact>
        ) : null}
        {f.element_label && f.element_label !== label ? <Fact label="Label">{f.element_label}</Fact> : null}
        {f.appearance ? (
          <Fact label="Appearance">
            <span className="inline-flex items-center gap-1">
              {f.appearance === "dark" ? <Moon className="size-3" aria-hidden /> : <Sun className="size-3" aria-hidden />}
              {appearanceLabel(f.appearance)}
            </span>
          </Fact>
        ) : null}
        <Fact label="Screen">{screenLabel(f.screen_hash, f.step_seq)}</Fact>
        {fg || bg ? (
          <Fact label="Colours">
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {fg ? <Swatch label="text" color={fg} /> : null}
              {bg ? <Swatch label="behind" color={bg} /> : null}
            </span>
          </Fact>
        ) : null}
      </dl>

      {count > 1 ? (
        <section className="flex flex-col gap-1" data-finding-occurrences>
          <h4 className="text-xs font-medium text-fg">
            Seen {count} times
            <span className="font-normal text-muted">
              {" "}
              on {row.screens.length} {row.screens.length === 1 ? "screen" : "screens"}
            </span>
          </h4>
          <ul className="flex max-h-56 flex-col overflow-y-auto rounded-md border border-border">
            {occurrences(row).map((o) => {
              const on = row.findings[index]?.screen_hash === row.findings[o.index].screen_hash &&
                row.findings[index]?.step_seq === o.step &&
                row.findings[index]?.appearance === o.appearance;
              return (
                <li key={`${o.screen}:${o.step}:${o.appearance}`} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setIndex(o.index)}
                    aria-current={on ? "true" : undefined}
                    className={cn(
                      "flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs transition-colors",
                      on ? "bg-selected text-fg" : "text-fg-2 hover:bg-hover",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{screenLabel(o.screen, o.step)}</span>
                    {o.appearance ? <span className="text-muted">{appearanceLabel(o.appearance)}</span> : null}
                    {o.count > 1 ? (
                      <span className="w-7 text-right font-mono tabular text-muted" title="Recorded this many times on this visit">
                        ×{o.count}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
