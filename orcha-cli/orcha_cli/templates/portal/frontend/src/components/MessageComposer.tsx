import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./ui";
import "./messageComposer.css";

const DEFAULT_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.log,.json";

function ClipIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export interface MessageComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onFiles: (files: FileList) => void;
  placeholder: string;
  textareaId: string;
  attachButtonId: string;
  fileInputId: string;
  sendButtonId: string;
  ariaLabel: string;
  disabled?: boolean;
  sending?: boolean;
  sendLabel?: string;
  sendingLabel?: string;
  accept?: string;
  leading?: ReactNode;
  overlay?: ReactNode;
  className?: string;
  textareaClassName?: string;
  attachClassName?: string;
  sendClassName?: string;
  sendButtonData?: Record<string, string>;
  textareaRef?: (node: HTMLTextAreaElement | null) => void;
  onTextareaKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaBlur?: () => void;
}

/**
 * Shared message composer used by agent Conversations and Task threads.
 * Enter submits, Shift+Enter inserts a newline, and the textarea grows with
 * its content up to the same capped height on both surfaces.
 */
export function MessageComposer({
  value,
  onValueChange,
  onSend,
  onFiles,
  placeholder,
  textareaId,
  attachButtonId,
  fileInputId,
  sendButtonId,
  ariaLabel,
  disabled = false,
  sending = false,
  sendLabel = "Send",
  sendingLabel = "Sending",
  accept = DEFAULT_ACCEPT,
  leading,
  overlay,
  className = "",
  textareaClassName = "",
  attachClassName = "",
  sendClassName = "btn approve",
  sendButtonData,
  textareaRef,
  onTextareaKeyDown,
  onTextareaBlur,
}: MessageComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = Math.min(el.scrollHeight, 160) + "px";
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onTextareaKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <div className={`message-composer ${className}`.trim()} aria-busy={sending || undefined}>
      {overlay}
      {leading}
      <button
        type="button"
        className={`message-composer__attach ${attachClassName}`.trim()}
        id={attachButtonId}
        title="Attach files (or drag-drop / paste)"
        aria-label="Attach files"
        disabled={disabled}
        onClick={() => fileRef.current?.click()}
      >
        <ClipIcon />
      </button>
      <input
        ref={fileRef}
        id={fileInputId}
        type="file"
        multiple
        accept={accept}
        hidden
        onChange={(event) => {
          if (event.target.files?.length) onFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <textarea
        ref={(node) => {
          inputRef.current = node;
          textareaRef?.(node);
        }}
        id={textareaId}
        className={`message-composer__input ${textareaClassName}`.trim()}
        rows={1}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onTextareaBlur}
        onPaste={(event) => {
          const files = event.clipboardData?.files;
          if (files?.length) onFiles(files);
        }}
      />
      <button
        {...sendButtonData}
        type="button"
        className={`${sendClassName}${sending ? " busy" : ""}`}
        id={sendButtonId}
        disabled={disabled || sending}
        onClick={onSend}
      >
        {sending ? (
          <>
            <span className="message-composer__spinner" aria-hidden="true" />
            {sendingLabel}
          </>
        ) : (
          <>
            <Icon name="arrow" cls="" />
            {sendLabel}
          </>
        )}
      </button>
    </div>
  );
}
