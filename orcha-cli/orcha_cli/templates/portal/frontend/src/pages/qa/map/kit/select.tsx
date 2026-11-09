
import {
  Children,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "./icons";
import { cn } from "./cn";

/**
 * Linear-style select (Orcha V2 `MenuButton` + listbox): a 28px trigger that opens a raised
 * popover of rows with an optional icon, a muted description, a check on the chosen row and
 * muted disabled rows with their reason.
 *
 * Drop-in for the old native `<select>`: it still takes `<option>` / `<optgroup>` children,
 * `value` / `defaultValue`, `onChange` (called with `{ target: { value, name } }`, so
 * `e.target.value` keeps working), and puts `id`, `aria-*` and `data-*` on the trigger. The
 * trigger also exposes the current value as `data-value`.
 *
 * Richer call sites pass `options` instead (icons, descriptions, disabled reasons, groups).
 */

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Plain text for typeahead / filtering when `label` is not a string. */
  textValue?: string;
  /** Leading 16px icon (BrandLogo, PlatformIcon, StatusGlyph, a lucide icon…). */
  icon?: ReactNode;
  /** Muted text after the label ("your subscription"). */
  description?: ReactNode;
  /** Muted trailing text (a count, a shortcut). */
  hint?: ReactNode;
  disabled?: boolean;
  /** Why the row is disabled ("Not set up"); shown muted at the end of the row. */
  disabledReason?: string;
  /** Group header; consecutive options with the same group sit under one header. */
  group?: string;
  /** Present in the value set but not listed (the native `<option hidden>` placeholder). */
  hidden?: boolean;
}

/** What `onChange` receives: enough of a change event for `e.target.value` code. */
export interface SelectChangeEvent {
  type: "change";
  target: { value: string; name: string; id: string };
  currentTarget: { value: string; name: string; id: string };
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface SelectProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "onChange" | "value" | "defaultValue" | "children" | "type"
  > {
  size?: never;
  /** Height: sm 24px · md 28px (default) · lg 32px. */
  dimension?: "sm" | "md" | "lg";
  wrapperClassName?: string;
  value?: string | number | null;
  defaultValue?: string | number;
  onChange?: (e: SelectChangeEvent) => void;
  /** Called with the new value (alongside `onChange`). */
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  form?: string;
  /** Rich options; when given, `children` are ignored. */
  options?: SelectOption[];
  /** `<option>` / `<optgroup>` children (native-select compatible). */
  children?: ReactNode;
  /** Leading icon on the trigger; defaults to the selected option's icon. Pass `null` to hide. */
  icon?: ReactNode;
  /** Custom trigger content for the selected option. */
  renderValue?: (option: SelectOption | undefined) => ReactNode;
  /** Text shown when no option matches the value. */
  placeholder?: string;
  /** Show a filter box: `"auto"` (default) when there are more than 8 options. */
  searchable?: boolean | "auto";
  /** Extra classes for the popover. */
  menuClassName?: string;
  /** Accessible name of the listbox (defaults to the trigger's aria-label). */
  menuLabel?: string;
}

const FILTER_THRESHOLD = 8;

/* ---------- children → options ---------- */

/** Plain text of a React node (for typeahead, filtering and the hidden native option). */
export function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

type OptionProps = {
  value?: string | number;
  children?: ReactNode;
  disabled?: boolean;
  hidden?: boolean;
  label?: string;
  title?: string;
};

function parseChildren(children: ReactNode, group?: string, out: SelectOption[] = []): SelectOption[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<OptionProps & { children?: ReactNode }>;
    if (el.type === "option") {
      const text = nodeText(el.props.children);
      out.push({
        value: el.props.value != null ? String(el.props.value) : text,
        label: el.props.children ?? el.props.label ?? text,
        textValue: el.props.label ?? text,
        disabled: !!el.props.disabled,
        disabledReason: el.props.disabled ? el.props.title : undefined,
        hidden: !!el.props.hidden,
        group,
      });
    } else if (el.type === "optgroup") {
      const label = el.props.label ?? "";
      parseChildren(el.props.children, label, out);
    } else if (el.props && "children" in el.props) {
      // Fragments (and other wrappers) — flatten.
      parseChildren(el.props.children, group, out);
    }
  });
  return out;
}

function optionText(o: SelectOption): string {
  return (o.textValue ?? nodeText(o.label)).trim();
}

/* ---------- positioning ---------- */

interface Placement {
  top: number;
  left: number;
  minWidth: number;
  maxHeight: number;
}

/** Where a popover goes under (or over) its trigger; shared with `combobox.tsx`. */
export function place(trigger: HTMLElement, menu: HTMLElement, list: HTMLElement | null): Placement {
  const r = trigger.getBoundingClientRect();
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const gap = 4;
  const margin = 8;
  // Natural height = chrome (filter, borders) + the full list, however much is showing now.
  const natural = list ? menu.offsetHeight - list.clientHeight + list.scrollHeight : menu.scrollHeight || 240;
  const below = vh - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const wanted = Math.min(natural, 360);
  const openUp = wanted > below && above > below;
  const maxHeight = Math.max(120, Math.min(360, openUp ? above : below));
  const h = Math.min(natural, maxHeight);
  const top = openUp ? r.top - gap - h : r.bottom + gap;
  const w = Math.max(menu.offsetWidth, r.width);
  const left = Math.max(margin, Math.min(r.left, vw - w - margin));
  return { top: Math.round(top), left: Math.round(left), minWidth: Math.round(r.width), maxHeight };
}

/* ---------- component ---------- */

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    className,
    wrapperClassName,
    dimension = "md",
    children,
    options: optionsProp,
    value: valueProp,
    defaultValue,
    onChange,
    onValueChange,
    name,
    required,
    form,
    id: idProp,
    disabled,
    icon,
    renderValue,
    placeholder,
    searchable = "auto",
    menuClassName,
    menuLabel,
    onKeyDown,
    onClick,
    onBlur,
    style,
    title,
    ...rest
  },
  forwardedRef,
) {
  const options = useMemo(
    () => optionsProp ?? parseChildren(children),
    [optionsProp, children],
  );
  const listed = useMemo(() => options.filter((o) => !o.hidden), [options]);

  const controlled = valueProp !== undefined;
  const [inner, setInner] = useState<string>(() =>
    defaultValue != null ? String(defaultValue) : (options[0]?.value ?? ""),
  );
  const current = controlled ? (valueProp == null ? "" : String(valueProp)) : inner;
  const selected = options.find((o) => o.value === current);
  // A native select with no matching option shows its first option; keep that for display only
  // when there is no placeholder to show instead.
  const shown = selected ?? (placeholder ? undefined : options[0]);

  const autoId = useId();
  const id = idProp ?? `sel-${autoId}`;
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useImperativeHandle(forwardedRef, () => triggerRef.current as HTMLButtonElement);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<Placement | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const typeahead = useRef({ text: "", at: 0 });

  const showFilter = searchable === true || (searchable === "auto" && listed.length > FILTER_THRESHOLD);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return listed;
    return listed.filter((o) =>
      `${optionText(o)} ${nodeText(o.description)} ${o.value}`.toLowerCase().includes(q),
    );
  }, [listed, query]);

  const enabledIdx = useCallback(
    (from: number, step: 1 | -1): number => {
      for (let i = from; i >= 0 && i < visible.length; i += step) {
        if (!visible[i].disabled) return i;
      }
      return -1;
    },
    [visible],
  );

  const openMenu = useCallback(
    (initial?: number) => {
      if (disabled) return;
      const trigger = triggerRef.current;
      setContainer((trigger?.closest("dialog[open]") as HTMLElement | null) ?? document.body);
      setQuery("");
      const sel = listed.findIndex((o) => o.value === current && !o.disabled);
      const first = listed.findIndex((o) => !o.disabled);
      setActive(initial ?? (sel >= 0 ? sel : first));
      setPos(null);
      setOpen(true);
    },
    [disabled, listed, current],
  );

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (o: SelectOption | undefined) => {
      if (!o || o.disabled) return;
      close(true);
      if (o.value === current) return;
      if (!controlled) setInner(o.value);
      const target = { value: o.value, name: name ?? "", id };
      onChange?.({
        type: "change",
        target,
        currentTarget: target,
        preventDefault() {},
        stopPropagation() {},
      });
      onValueChange?.(o.value);
    },
    [close, current, controlled, name, id, onChange, onValueChange],
  );

  // Position under (or over) the trigger; follow scrolls and resizes while open.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const t = triggerRef.current;
      const m = menuRef.current;
      if (!t || !m) return;
      const p = place(t, m, listRef.current);
      setPos((prev) =>
        prev &&
        prev.top === p.top &&
        prev.left === p.left &&
        prev.minWidth === p.minWidth &&
        prev.maxHeight === p.maxHeight
          ? prev
          : p,
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, container, visible.length]);

  // Focus the filter on open; close on outside pointer-down.
  useEffect(() => {
    if (!open) return;
    if (showFilter) filterRef.current?.focus();
    // Without a filter the trigger takes the keys (arrows, Enter, Escape). A click does not
    // focus a button in Safari or the Mac app's WKWebView, so a menu opened by pointer left
    // focus on the page, and its Escape reached New Run's page handler, which left the form
    // with every selection (#177).
    else if (document.activeElement !== triggerRef.current) triggerRef.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, showFilter, close]);

  // The menu renders into a portal once it is placed: focus the filter then too, or a menu opened by
  // pointer kept focus on the trigger and typing never reached the filter (the recipe step picker).
  const placed = pos !== null;
  useEffect(() => {
    if (open && showFilter && placed && document.activeElement !== filterRef.current) filterRef.current?.focus({ preventScroll: true });
  }, [open, showFilter, placed]);

  // Keep the active row in view.
  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, pos]);

  // Clamp the active row when the filter narrows the list.
  useEffect(() => {
    if (!open) return;
    setActive((a) => (a >= 0 && a < visible.length && !visible[a].disabled ? a : enabledIdx(0, 1)));
  }, [open, visible, enabledIdx]);

  function runTypeahead(key: string): number {
    const now = Date.now();
    const t = typeahead.current;
    t.text = now - t.at > 700 ? key : t.text + key;
    t.at = now;
    const q = t.text.toLowerCase();
    const list = visible;
    const start = active >= 0 ? active : 0;
    // A repeated single letter cycles through matches; longer text matches from the current row.
    const cycling = t.text.length > 1 && t.text.split("").every((c) => c === t.text[0]);
    const needle = cycling ? q[0] : q;
    const order = [...list.keys()].map((k) => (start + (t.text.length === 1 || cycling ? 1 : 0) + k) % list.length);
    const hit = order.find((i) => !list[i].disabled && optionText(list[i]).toLowerCase().startsWith(needle));
    return hit ?? -1;
  }

  function handleKey(e: ReactKeyboardEvent<HTMLElement>, fromFilter: boolean) {
    const key = e.key;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        e.preventDefault();
        openMenu();
        return;
      }
      if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const now = Date.now();
        typeahead.current = { text: key, at: now };
        const q = key.toLowerCase();
        const hit = listed.findIndex((o) => !o.disabled && optionText(o).toLowerCase().startsWith(q));
        openMenu(hit >= 0 ? hit : undefined);
      }
      return;
    }
    switch (key) {
      case "ArrowDown": {
        e.preventDefault();
        const n = enabledIdx(active + 1, 1);
        if (n >= 0) setActive(n);
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        const n = enabledIdx(active - 1, -1);
        if (n >= 0) setActive(n);
        return;
      }
      case "PageDown": {
        e.preventDefault();
        const n = enabledIdx(Math.min(visible.length - 1, active + 10), -1);
        if (n >= 0) setActive(n);
        return;
      }
      case "PageUp": {
        e.preventDefault();
        const n = enabledIdx(Math.max(0, active - 10), 1);
        if (n >= 0) setActive(n);
        return;
      }
      case "Home":
        if (fromFilter) return;
        e.preventDefault();
        setActive(enabledIdx(0, 1));
        return;
      case "End":
        if (fromFilter) return;
        e.preventDefault();
        setActive(enabledIdx(visible.length - 1, -1));
        return;
      case "Enter":
        e.preventDefault();
        commit(visible[active]);
        return;
      case " ":
        if (fromFilter) return;
        e.preventDefault();
        commit(visible[active]);
        return;
      case "Escape":
        // Ours, not the enclosing <dialog>'s or popover's.
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        close(true);
        return;
      case "Tab":
        // Close and let Tab move on from the trigger.
        close(fromFilter);
        return;
    }
    if (!fromFilter && key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const hit = runTypeahead(key);
      if (hit >= 0) setActive(hit);
    }
  }

  const sizeCls =
    dimension === "sm"
      ? "h-6 gap-1.5 pl-2 pr-1.5 text-sm"
      : dimension === "lg"
        ? "h-8 gap-2 pl-3 pr-2.5 text-base"
        : "h-7 gap-2 pl-2.5 pr-2 text-base";

  const leading = icon !== undefined ? icon : shown?.icon;
  const display = renderValue
    ? renderValue(selected)
    : shown
      ? shown.label
      : placeholder;

  const activeOptionId = open && active >= 0 && visible[active] ? optId(active) : undefined;

  // Group headers / separators for the visible rows.
  const rows: ReactNode[] = [];
  let lastGroup: string | undefined;
  visible.forEach((o, i) => {
    if (o.group !== lastGroup) {
      if (i > 0) rows.push(<div key={`sep-${i}`} role="separator" className="mx-1 my-1 h-px bg-border" />);
      if (o.group) {
        rows.push(
          <div
            key={`grp-${i}`}
            role="presentation"
            className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted"
          >
            {o.group}
          </div>,
        );
      }
      lastGroup = o.group;
    }
    const isSel = o.value === current;
    const isActive = i === active;
    rows.push(
      <div
        key={`opt-${o.value}-${i}`}
        id={optId(i)}
        role="option"
        aria-selected={isSel}
        aria-disabled={o.disabled || undefined}
        data-value={o.value}
        data-index={i}
        data-active={isActive || undefined}
        title={o.disabled && o.disabledReason ? o.disabledReason : optionText(o) || undefined}
        className={cn(
          "flex min-h-7 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 text-base text-fg",
          isActive && !o.disabled && "bg-selected",
          o.disabled && "cursor-not-allowed text-muted",
        )}
        onMouseMove={() => {
          if (!o.disabled && active !== i) setActive(i);
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => commit(o)}
      >
        {listed.some((x) => x.icon) ? (
          <span
            aria-hidden
            className={cn(
              "flex size-4 shrink-0 items-center justify-center text-muted [&_svg]:size-3.5",
              o.disabled && "opacity-60",
            )}
          >
            {o.icon}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* The description gives way first: the label keeps its width ("Any Google Pixel"
              was cut to "Any Google …" beside a long description). */}
          <span className={cn("truncate", o.description && "max-w-[70%] shrink-0")}>{o.label}</span>
          {o.description ? (
            <span className="min-w-0 truncate text-sm text-muted">{o.description}</span>
          ) : null}
        </span>
        {o.disabled && o.disabledReason ? (
          <span className="shrink-0 text-xs text-muted">{o.disabledReason}</span>
        ) : o.hint ? (
          <span className="shrink-0 text-xs text-muted">{o.hint}</span>
        ) : null}
        <Check
          aria-hidden
          className={cn("size-3.5 shrink-0 text-primary", isSel ? "visible" : "invisible")}
        />
      </div>,
    );
  });

  const menuStyle: CSSProperties = pos
    ? { top: pos.top, left: pos.left, minWidth: pos.minWidth, maxHeight: pos.maxHeight }
    : { top: -9999, left: -9999, visibility: "hidden" };

  const menu =
    open && container
      ? createPortal(
          <div
            ref={menuRef}
            data-select-menu=""
            className={cn(
              "qa-port fixed z-[80] flex w-max max-w-[min(420px,calc(100vw-16px))] flex-col overflow-hidden rounded-lg border border-border-strong bg-raised text-fg shadow-md",
              menuClassName,
            )}
            style={menuStyle}
            // Portaled, so outside the DOM of whatever owns the trigger, while React events
            // still bubble through the component tree. Keep a press in the menu from reaching a
            // clickable row that owns the trigger, or a popover's document-level "outside
            // click" listener (the app's React root is the document, so that takes
            // stopImmediatePropagation).
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                // Ours, not a Dialog's or popover's that owns the trigger.
                e.preventDefault();
                e.nativeEvent.stopImmediatePropagation();
                close(true);
              }
            }}
          >
            {showFilter ? (
              <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
                <Search aria-hidden className="size-3.5 shrink-0 text-muted" />
                <input
                  ref={filterRef}
                  type="text"
                  role="combobox"
                  aria-expanded
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeOptionId}
                  aria-label="Filter options"
                  placeholder="Filter…"
                  data-select-filter=""
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => handleKey(e, true)}
                  className="h-6 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-muted focus-visible:shadow-none"
                />
              </div>
            ) : null}
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={menuLabel ?? (rest["aria-label"] as string | undefined)}
              aria-labelledby={menuLabel || rest["aria-label"] ? undefined : id}
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-y-auto p-1"
            >
              {rows.length ? (
                rows
              ) : (
                <div className="px-2 py-1.5 text-sm text-muted">No matches</div>
              )}
            </div>
          </div>,
          container,
        )
      : null;

  return (
    <span className={cn("relative inline-flex w-full min-w-0 items-center", wrapperClassName)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={showFilter ? undefined : activeOptionId}
        aria-required={required || undefined}
        disabled={disabled}
        data-value={current}
        data-state={open ? "open" : "closed"}
        title={title ?? (shown ? optionText(shown) : undefined)}
        style={style}
        {...rest}
        className={cn(
          "inline-flex w-full min-w-0 cursor-pointer items-center rounded-md border border-border-strong bg-transparent text-left text-fg transition-colors duration-[90ms]",
          "hover:border-muted/60 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-muted/60 bg-hover",
          sizeCls,
          className,
        )}
        onClick={(e) => {
          onClick?.(e);
          if (e.defaultPrevented) return;
          if (open) close(true);
          else openMenu();
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          const wasOpen = open;
          handleKey(e, false);
          // A key the select used (or any key while it is open) is not a list row's or a page
          // shortcut's. Those listen on the document, which is also React's root here.
          if (wasOpen || e.defaultPrevented) {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
          }
        }}
        onBlur={onBlur}
      >
        {leading ? (
          <span
            aria-hidden
            className="flex size-4 shrink-0 items-center justify-center text-muted [&_svg]:size-3.5"
          >
            {leading}
          </span>
        ) : null}
        <span className={cn("min-w-0 flex-1 truncate", !shown && !renderValue && "text-muted")}>
          {display}
        </span>
        <ChevronDown
          aria-hidden
          className={cn("shrink-0 text-muted", dimension === "sm" ? "size-3" : "size-3.5")}
        />
      </button>
      {menu}
    </span>
  );
});
