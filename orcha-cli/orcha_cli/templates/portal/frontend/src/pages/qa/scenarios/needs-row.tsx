import { Input, cn } from "../map/kit";
import { FieldError, PropRow } from "./panel-ui";
import { needsError, needsFromText, needsWarning, parseNeeds } from "./needs";

const HELP =
  "What this scenario needs from its environment: fresh install, reset, cleanup, writes, seed API, launch hook, " +
  'fixture "7 routines", purchases sandbox, payments sandbox, email sandbox, SMS sandbox, signed in.';

/** The scenario's `Needs:` line: typed as comma-separated items, shown as chips. */
export function NeedsRow({ id, value, onChange, disabled }: { id: string; value: string; onChange: (text: string) => void; disabled?: boolean }) {
  const error = needsError(value);
  const warning = error ? null : needsWarning(value);
  const chips = parseNeeds(needsFromText(value) ?? []);
  return (
    <PropRow label="Needs" htmlFor={`${id}-needs`} help={HELP}>
      <Input
        id={`${id}-needs`}
        value={value}
        placeholder="fresh install, purchases sandbox"
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        data-scenario-needs
      />
      {error ? <FieldError>{error}</FieldError> : null}
      {warning ? (
        <p className="text-xs text-warning" data-needs-warning>
          {warning}
        </p>
      ) : null}
      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="What it needs">
          {chips.map((c) => (
            <li key={c.text} className={cn("inline-flex h-5 items-center rounded-full border border-border px-2 text-xs text-fg-2")} data-need-chip>
              {c.text}
            </li>
          ))}
        </ul>
      ) : null}
    </PropRow>
  );
}
