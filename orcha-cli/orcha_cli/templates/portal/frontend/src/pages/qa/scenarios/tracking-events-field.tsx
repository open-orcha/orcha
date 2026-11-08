import { useId } from "react";
import { MAX_EVENT_LINES, eventLineError, eventsFromText } from "./tracking-events";
import { cn } from "../map/kit";
import { FieldError, PanelSection, textareaClass } from "./panel-ui";

/** First problem with the textarea's lines, or null when every line is an expectation. */
export function trackingEventsError(text: string): string | null {
  const lines = eventsFromText(text);
  if (lines.length > MAX_EVENT_LINES) return `At most ${MAX_EVENT_LINES} lines.`;
  for (const line of lines) {
    const error = eventLineError(line);
    if (error) return error;
  }
  return null;
}

const EVENTS_HELP =
  "One per line: network:, console:, device: or any:, then the words that must appear. Matched in order " +
  "unless the first line is 'any order'; end a line with [warning] to make it non-critical.";

/**
 * The scenario's tracking-event expectations (`scenarios.events`), one per line. Checked after
 * the run against the traffic it captured and reported as one more criterion.
 */
export function TrackingEventsField({ value, onChange, disabled = false }: { value: string; onChange: (text: string) => void; disabled?: boolean }) {
  const id = useId();
  const error = trackingEventsError(value);
  return (
    <PanelSection title="Tracking events" help={EVENTS_HELP} lead="Checked after the run against the traffic it captured.">
      <textarea
        id={id}
        aria-label="Tracking events"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        placeholder={'network: POST /v1/track "checkout_started"\nconsole: "[analytics]" purchase'}
        className={cn(textareaClass, "font-mono text-xs")}
        data-scenario-events
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </PanelSection>
  );
}
