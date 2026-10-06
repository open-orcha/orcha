/**
 * <DictationButton> — the mic as a toolbar button, for fields that have a
 * toolbar of their own (Composer, MessageComposer). Same engine, HUD and
 * shortcut as the floating mic; the field carries `data-dictation-inline` so
 * the floating button doesn't double up. Renders nothing outside a
 * <DictationProvider> or when dictation is turned off.
 */
import { IconButton } from "../components/primitives/IconButton";
import { MicGlyph, useDictation } from "./DictationHost";
import type { DictationTarget } from "./target";

export function DictationButton({ getTarget, disabled, size = "md" }: { getTarget: () => DictationTarget | null; disabled?: boolean; size?: "sm" | "md" }) {
  const d = useDictation(getTarget);
  if (!d) return null;
  const label = d.active ? "Stop dictation" : `Dictate (${d.shortcut})`;
  return (
    <IconButton
      glyph={<MicGlyph size={size === "sm" ? 14 : 16} />}
      label={label}
      size={size}
      pressed={d.active}
      busy={d.busy}
      disabled={disabled}
      className={"dict-inline" + (d.active ? " is-rec" : "")}
      data-testid="dictation-inline"
      onMouseDown={(e) => e.preventDefault()}
      onClick={d.toggle}
    />
  );
}
