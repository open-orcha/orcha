/**
 * Composer — Linear comment / agent-reply field (directives D9, D10):
 * a rounded bordered field that grows with its text, an optional context
 * chip row above the text, a bottom toolbar with a leading slot (e.g. a
 * "Skills" MenuButton), an attach button, and a CIRCULAR send button that
 * turns into a circular STOP button while a run is in flight (`onStop`).
 *
 *   <Composer label="Comment on task" placeholder="Leave a comment…"
 *     value={draft} onChange={setDraft} onSubmit={post} busy={posting}
 *     onFiles={attach} attachments={<ContextChip …/>} />
 *
 * Keyboard: Enter submits, Shift+Enter inserts a newline (IME composition is
 * respected); Cmd/Ctrl+Enter always submits. Send is disabled while the
 * trimmed value is empty (unless `allowEmpty`, e.g. attachments only), while
 * `busy`, or when `disabled` — `disabledReason` is shown as the tooltip and
 * announced under the field, never silently.
 */
import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { IconButton } from "./IconButton";
import { DictationButton } from "../../dictation/DictationButton";

export function AttachGlyph() {
  return (
    <svg className="v2-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15.6 9.6 10 15.2a3.6 3.6 0 0 1-5.1-5.1l6-6a2.4 2.4 0 0 1 3.4 3.4l-6 6a1.2 1.2 0 0 1-1.7-1.7l5.5-5.5" />
    </svg>
  );
}
function SendGlyph() {
  return (
    <svg className="v2-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 15.5V4.8M5.6 9.2 10 4.8l4.4 4.4" />
    </svg>
  );
}
function StopGlyph() {
  return (
    <svg className="v2-ico" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="6" y="6" width="8" height="8" rx="1.6" fill="currentColor" />
    </svg>
  );
}

/** The one composer key-hint copy (Needs, Requests, task comments). */
export const COMPOSER_KEY_HINT = "↵ to send · ⇧↵ new line";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Accessible name of the text field ("Reply to lead"). */
  label: string;
  placeholder?: string;
  /** Submit in flight: send disabled + aria-busy. */
  busy?: boolean;
  /** A run is in flight: the send button becomes a circular Stop that calls this. */
  onStop?: () => void;
  stopLabel?: string;
  running?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Files picked via the attach button (omit to hide the button). */
  onFiles?: (files: FileList) => void;
  accept?: string;
  multiple?: boolean;
  /** Chip row above the text ("DRV-364 added to context", attachments). */
  attachments?: ReactNode;
  /** Bottom-left toolbar slot (Skills / model pickers). */
  leading?: ReactNode;
  /** Show the ONE shared key hint ("↵ to send · ⇧↵ new line") in the bottom-left
   *  slot while the field has focus. Pages use this instead of their own copy. */
  keyHint?: boolean;
  /** Extra buttons before attach (bottom-right). */
  tools?: ReactNode;
  submitLabel?: string;
  /** Allow submitting with empty text (e.g. attachments only). */
  allowEmpty?: boolean;
  minRows?: number;
  /** Max height in px before the field scrolls. */
  maxHeight?: number;
  id?: string;
  /** Stable DOM ids for the attach / send buttons (legacy test + e2e hooks). */
  attachButtonId?: string;
  submitButtonId?: string;
  autoFocus?: boolean;
  textareaRef?: (el: HTMLTextAreaElement | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  className?: string;
}

export function Composer({
  value, onChange, onSubmit, label, placeholder, busy, onStop, stopLabel = "Stop run", running,
  disabled, disabledReason, onFiles, accept, multiple = true, attachments, leading, keyHint, tools,
  submitLabel = "Send", allowEmpty, minRows = 2, maxHeight = 240, id, attachButtonId, submitButtonId, autoFocus, textareaRef, onKeyDown, className,
}: ComposerProps) {
  const autoId = useId();
  const tid = id ?? `v2-composer-${autoId.replace(/:/g, "")}`;
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const canSend = !disabled && !busy && (allowEmpty || value.trim().length > 0);
  const showStop = !!onStop && !!running;

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value, maxHeight]);

  const submit = () => { if (canSend) onSubmit(); };
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    submit();
  };
  const reasonId = disabled && disabledReason ? `${tid}-reason` : undefined;

  return (
    <div
      className={`v2-composer${disabled ? " is-disabled" : ""}${className ? " " + className : ""}`}
      onClick={(e) => { if (e.target === e.currentTarget) ta.current?.focus(); }}
    >
      {attachments ? <div className="v2-composer-ctx">{attachments}</div> : null}
      <textarea
        id={tid}
        ref={(el) => { ta.current = el; textareaRef?.(el); }}
        className="v2-composer-input"
        data-dictation-inline=""
        aria-label={label}
        aria-describedby={reasonId}
        placeholder={placeholder}
        rows={minRows}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={keyDown}
      />
      <div className="v2-composer-bar">
        <div className="v2-composer-lead">
          {leading}
          {keyHint && !disabled ? <span className="v2-composer-hint" aria-hidden="true">{COMPOSER_KEY_HINT}</span> : null}
        </div>
        <div className="v2-composer-tools">
          {tools}
          <DictationButton getTarget={() => ta.current} disabled={disabled} />
          {onFiles ? (
            <>
              <IconButton
                id={attachButtonId}
                glyph={<AttachGlyph />}
                label="Attach files"
                disabled={disabled}
                onClick={() => file.current?.click()}
              />
              <input
                ref={file}
                type="file"
                hidden
                multiple={multiple}
                accept={accept}
                tabIndex={-1}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length) onFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          ) : null}
          {showStop ? (
            <IconButton glyph={<StopGlyph />} label={stopLabel} variant="outline" className="v2-composer-stop" onClick={onStop} />
          ) : (
            <IconButton
              id={submitButtonId}
              glyph={<SendGlyph />}
              label={submitLabel}
              title={disabled && disabledReason ? disabledReason : `${submitLabel} (Enter)`}
              variant={canSend ? "solid" : "outline"}
              className="v2-composer-send"
              disabled={!canSend}
              busy={busy}
              onClick={submit}
            />
          )}
        </div>
      </div>
      {reasonId ? <p id={reasonId} className="v2-composer-reason">{disabledReason}</p> : null}
    </div>
  );
}

/** "DRV-364 added to context" style chip for the Composer / chat context row. */
export function ContextChip({ icon, children, onRemove, removeLabel }: { icon?: ReactNode; children: ReactNode; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className="v2-ctxchip">
      {icon ? <span className="v2-ctxchip-ico" aria-hidden="true">{icon}</span> : null}
      <span className="v2-ctxchip-label">{children}</span>
      {onRemove ? (
        <button type="button" className="v2-ctxchip-x" aria-label={removeLabel ?? "Remove"} title={removeLabel ?? "Remove"} onClick={onRemove}>
          <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
        </button>
      ) : null}
    </span>
  );
}
