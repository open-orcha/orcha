
import { useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { addTags, normalizeTag, splitTags, tagKey } from "./tags";
import { cn } from "./cn";
import { TagPill, type TagPillSize } from "./tag-pill";

/** At most this many suggestions show at once. */
const SHOWN = 8;

export interface TagInputProps {
  value: readonly string[];
  onChange: (tags: string[]) => void;
  /** What is typed but not yet a pill, when the owner holds it: a form's save then adds it
   * (`withPendingTag`) so ⌘S never drops a half-typed tag. Uncontrolled when omitted. */
  text?: string;
  onTextChange?: (text: string) => void;
  /** The project's existing tags, most used first: offered as the user types. */
  suggestions?: readonly string[];
  /** The text field's id (a `<label for>` names it). */
  id?: string;
  placeholder?: string;
  /** No more tags than this (the API's own cap). */
  max?: number;
  size?: TagPillSize;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  [data: `data-${string}`]: string | boolean | undefined;
}

/**
 * Tags edited as pills: the current tags as removable pills, then a text field. Enter, comma
 * or Tab adds what was typed; Backspace in an empty field removes the last pill; pasting
 * "a, b, c" adds three. Text is normalised and de-duplicated by `lib/tags` (case-insensitive,
 * as the backend matches). Suggestions come from `suggestions` in an ARIA listbox.
 */
export function TagInput({
  value,
  onChange,
  text: textProp,
  onTextChange,
  suggestions = [],
  id,
  placeholder = "Add a tag",
  max = Infinity,
  size = "sm",
  disabled = false,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  ...data
}: TagInputProps) {
  const auto = useId();
  const inputId = id ?? `${auto}-input`;
  const listId = `${auto}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [ownText, setOwnText] = useState("");
  const text = textProp ?? ownText;
  const setText = (t: string) => {
    if (textProp === undefined) setOwnText(t);
    onTextChange?.(t);
  };
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const full = value.length >= max;

  const options = useMemo(() => {
    const have = new Set(value.map(tagKey));
    const needle = tagKey(text);
    const pool = suggestions.filter((s) => normalizeTag(s) && !have.has(tagKey(s)));
    if (!needle) return pool.slice(0, SHOWN);
    const starts = pool.filter((s) => tagKey(s).startsWith(needle));
    const contains = pool.filter((s) => !tagKey(s).startsWith(needle) && tagKey(s).includes(needle));
    return [...starts, ...contains].slice(0, SHOWN);
  }, [suggestions, value, text]);
  const showList = open && !disabled && !full && options.length > 0;

  function commit(incoming: string[]) {
    const next = addTags(value, incoming, max);
    if (next.length !== value.length) onChange(next);
  }

  function commitText(): boolean {
    const typed = splitTags(text);
    setText("");
    setActive(-1);
    if (typed.length === 0) return false;
    commit(typed);
    return true;
  }

  function pick(option: string) {
    commit([option]);
    setText("");
    setActive(-1);
    inputRef.current?.focus();
  }

  function remove(i: number) {
    onChange(value.filter((_, j) => j !== i));
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (options.length === 0) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (showList ? (a + step + options.length) % options.length : step > 0 ? 0 : options.length - 1));
      return;
    }
    if (e.key === "Escape" && showList) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      if (showList && active >= 0 && options[active] && e.key !== ",") {
        e.preventDefault();
        pick(options[active]);
        return;
      }
      // Tab with nothing typed moves focus on, as usual.
      if (e.key === "Tab" && !normalizeTag(text)) return;
      if (e.key === "Enter" || e.key === ",") e.preventDefault();
      if (commitText() && e.key === "Tab") e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && text === "" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    if (!/[,\n\r]/.test(pasted)) return;
    e.preventDefault();
    commit(splitTags(text + pasted));
    setText("");
  }

  const activeId = showList && active >= 0 ? `${listId}-${active}` : undefined;
  return (
    <div
      className={cn(
        "relative flex min-h-7 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-border-strong bg-transparent px-1.5 py-[3px] transition-colors duration-[90ms] hover:border-muted/60 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-[var(--color-ring)]",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      onMouseDown={(e) => {
        // A click on the box's padding focuses the field, as an input's own box would.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
      data-tag-input
      {...data}
    >
      {value.length > 0 ? (
        <ul className="contents" aria-label={ariaLabel ? `${ariaLabel}: current tags` : "Current tags"}>
          {value.map((t, i) => (
            <li key={`${i}:${tagKey(t)}`} className="flex min-w-0 max-w-full">
              <TagPill tag={t} size={size} onRemove={disabled ? undefined : () => remove(i)} />
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        value={text}
        disabled={disabled}
        placeholder={full ? "" : value.length > 0 ? "" : placeholder}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={activeId}
        autoComplete="off"
        enterKeyHint="enter"
        readOnly={full}
        className="h-5 min-w-[6rem] flex-1 bg-transparent px-1 text-base text-fg outline-none placeholder:text-muted focus-visible:outline-none disabled:cursor-not-allowed"
        onChange={(e) => {
          const v = e.target.value;
          // A typed or autofilled comma ends a tag; the rest stays in the field.
          if (v.includes(",")) {
            const parts = v.split(",");
            const tail = parts.pop() ?? "";
            commit(parts.flatMap(splitTags));
            setText(tail.trimStart());
          } else setText(v);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
          // A tag typed but not entered is kept rather than lost on Save.
          commitText();
        }}
        data-tag-input-field
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Suggested tags"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-md border border-border-strong bg-raised p-1 shadow-md"
          data-tag-suggestions
        >
          {options.map((o, i) => (
            <li
              key={tagKey(o)}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cn(
                "flex cursor-pointer items-center rounded px-2 py-1 text-sm text-fg-2",
                i === active ? "bg-selected text-fg" : "hover:bg-hover hover:text-fg",
              )}
              // Keep focus in the field: a blur would commit the half-typed text first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              onMouseEnter={() => setActive(i)}
              data-tag-suggestion={o}
            >
              {o}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
