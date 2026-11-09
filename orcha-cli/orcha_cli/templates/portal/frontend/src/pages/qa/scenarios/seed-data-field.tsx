import { useId } from "react";
import { cleanupError, seedNames, seedsError, seedsFromText } from "./seeds";
import { cn } from "../map/kit";
import { FieldError, PanelSection, textareaClass } from "./panel-ui";

const SEED_HELP =
  "One per line, created before the agent starts: POST /api/orders {…} (the environment's API), fixture orders " +
  "(seeds/orders.json, applied by the environment's seed.command or seed.endpoint), or storage {…} / cookies {…} " +
  "for the browser (web). End a line with 'as product' to name what it made: later lines, criteria and checks say " +
  "{{product.id}} or {{product.name}}. Use values a real user of the app would enter (a Data `one of …` or `pattern …` draws a " +
  "fresh one each run); the run owns the record by its id, never by a QA- prefix. A failed seed blocks the scenario.";

const CLEANUP_HELP =
  "HTTP calls run after the scenario whatever its outcome, newest first, so seeded records do not pile up: " +
  "DELETE /api/products/{{product.id}}. A line whose record was never made is skipped. Test and staging only.";

/**
 * The scenario's test data: seeds (`qa_scenarios.seed`) created before the agent starts, and
 * cleanup lines (`qa_scenarios.cleanup`) run afterwards. A seed
 * that fails blocks the scenario instead of letting it run on missing data; a seed can name its
 * record (`as truck`) so the scenario refers to its own data, never to "the first truck".
 */
export function SeedDataField({
  value,
  onChange,
  cleanup = "",
  onCleanupChange,
  disabled = false,
}: {
  value: string;
  onChange: (text: string) => void;
  cleanup?: string;
  onCleanupChange?: (text: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const error = seedsError(value);
  const lines = seedsFromText(value);
  const names = seedNames(lines);
  const cleanupErr = cleanupError(cleanup);
  return (
    <PanelSection title="Seed data" help={SEED_HELP} lead="Created before the agent starts; a failed seed blocks it." data-seed-data>
      <textarea
        id={id}
        aria-label="Seed data"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        placeholder={'POST /api/products {"name": "Trail running shoes", "price": 89.99} as product\nstorage {"cart": [{"sku": "SHOE-42", "quantity": 1}]}'}
        className={cn(textareaClass, "font-mono text-xs")}
        data-scenario-seed
      />
      {error ? <FieldError>{error}</FieldError> : null}
      {!error && names.length > 0 ? (
        <p className="text-xs text-muted" data-seed-names>
          Refer to {names.length === 1 ? "it" : "them"} as{" "}
          {names.map((n, i) => (
            <span key={n}>
              {i > 0 ? ", " : ""}
              <span className="font-mono text-fg-2">{`{{${n}.id}}`}</span>
            </span>
          ))}
          .
        </p>
      ) : null}
      {onCleanupChange ? (
        <div className="flex flex-col gap-1" data-cleanup>
          <label htmlFor={`${id}-cleanup`} className="text-xs text-muted" title={CLEANUP_HELP}>
            Cleanup, run after the scenario
          </label>
          <textarea
            id={`${id}-cleanup`}
            value={cleanup}
            disabled={disabled}
            onChange={(e) => onCleanupChange(e.target.value)}
            rows={Math.max(1, cleanup.split("\n").length)}
            spellCheck={false}
            aria-invalid={cleanupErr ? true : undefined}
            placeholder={names.length ? `DELETE /api/products/{{${names[0]}.id}}` : "DELETE /api/products/{{product.id}}"}
            className={cn(textareaClass, "font-mono text-xs")}
            data-scenario-cleanup
          />
          {cleanupErr ? <FieldError>{cleanupErr}</FieldError> : null}
        </div>
      ) : null}
    </PanelSection>
  );
}
