import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent } from "react";
import { ClipboardPaste, Copy, Eye, Lock, LockOpen, Plus, Table2, Trash2, X } from "../map/kit/icons";
import { Button } from "../map/kit";
import { StatusGlyph, type GlyphStatus } from "../map/kit";
import { useToast } from "../map/kit";
import { columnError, examplesError, isSecretRef, MAX_COLUMNS, MAX_ROWS, parsePastedTable, unusedColumns, type ExamplesTable } from "./examples";
import {
  addColumn,
  addRow,
  duplicateRow,
  emptyTable,
  isSecretAt,
  pasteInto,
  removeColumn,
  removeRow,
  renameColumn,
  setCell,
  toggleSecret,
  withDetectedSecrets,
} from "./examples-edit";
import { qaHref } from "../parts";
import { exampleRows, revealExample } from "./api";
import { useScenarios } from "./context";
import { rowsSummary, type RowResult, type RowState } from "./example-results";
import { cn } from "../map/kit";
import { FieldError, PanelSection, textareaClass } from "./panel-ui";
import m from "./examples.module.css";

const HELP =
  "The same journey over rows of data: each row is its own run with its own verdict. Write {{column}} in the " +
  "description, criteria, checks, seeds or cleanup lines and each run fills it from its row. A row value wins over a " +
  "Data variable of the same name. Empty cells are values. Paste a table from a spreadsheet, a CSV, or a Gherkin or " +
  "markdown table. A password, PIN, code, token or key column is secret (the lock): its values are stored encrypted, " +
  "shown as dots, and a run types them with type_secret; a sign-in that every row shares belongs in the environment's " +
  "test account instead.";

const ROW_GLYPH: Record<RowState, GlyphStatus> = {
  passed: "pass",
  failed: "fail",
  inconclusive: "inconclusive",
  errored: "errored",
  skipped: "cancelled",
  running: "running",
  queued: "queued",
  cancelled: "cancelled",
};

const ROW_WORD: Record<RowState, string> = {
  passed: "Passed",
  failed: "Failed",
  inconclusive: "Inconclusive",
  errored: "Errored",
  skipped: "Skipped",
  running: "Running",
  queued: "Queued",
  cancelled: "Cancelled",
};

export interface ExamplesFieldProps {
  value: ExamplesTable | null;
  onChange: (table: ExamplesTable | null) => void;
  /** Every text of the scenario a row fills, for the "not used" hints. */
  texts: readonly (string | null | undefined)[];
  /** `{{names}}` the scenario uses that no Data variable or seed gives a value: a new table
   * starts with them as its columns. */
  suggestedColumns?: readonly string[];
  /** Saved scenario: its rows' latest results are shown beside each row. */
  scenarioId?: string;
}

/**
 * The scenario's examples table (`scenarios.examples`, #191): an editable grid of columns and
 * rows, built for the long, wide tables converted from existing tests. Column names and cells
 * edit in place; Enter moves down (adding a row at the end); pasting several lines or tabs into
 * a cell fills the grid from there; a column the scenario never reads is marked, not refused.
 * Each row shows its latest verdict once the scenario has run.
 */
export function ExamplesField({ value, onChange, texts, suggestedColumns = [], scenarioId }: ExamplesFieldProps) {
  const { toast } = useToast();
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const results = useRowResults(scenarioId, value !== null);
  const gridRef = useRef<HTMLTableElement>(null);
  const unused = useMemo(() => unusedColumns(value, texts), [value, texts]);
  const error = examplesError(value);
  const byRow = useMemo(() => new Map(results.map((r) => [r.row, r])), [results]);
  const total = value?.rows.length ?? 0;
  // Each column as wide as what it holds (within reason), so a narrow table fits the panel and
  // a wide one scrolls sideways inside its frame.
  const widths = useMemo(
    () =>
      (value?.columns ?? []).map((col, c) =>
        value && isSecretAt(value, c)
          ? Math.max(12, col.length + 6)
          : Math.min(28, Math.max(6, col.length + 4, ...(value?.rows ?? []).slice(0, 100).map((r) => (r[c] ?? "").length + 1))),
      ),
    [value],
  );

  function focusCell(row: number, col: number) {
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLInputElement>(`[data-cell="${row}:${col}"]`)?.focus();
    });
  }

  function applyPaste() {
    const table = parsePastedTable(pasteText);
    if (!table || table.columns.length === 0) {
      toast({ title: "Nothing to paste", description: "The first line names the columns, each next line is a row.", variant: "error" });
      return;
    }
    // A pasted password, PIN, code or token column is marked secret straight away.
    onChange(withDetectedSecrets({ columns: table.columns.slice(0, MAX_COLUMNS), rows: table.rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLUMNS)) }));
    setPasting(false);
    setPasteText("");
    if (table.rows.length > MAX_ROWS) toast({ title: `Kept the first ${MAX_ROWS} rows`, description: `The pasted table had ${table.rows.length}.` });
  }

  function onCellKey(e: KeyboardEvent<HTMLInputElement>, row: number, col: number) {
    if (!value) return;
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const next = e.shiftKey ? row - 1 : row + 1;
      if (next >= value.rows.length) {
        if (value.rows.length >= MAX_ROWS) return;
        onChange(addRow(value));
      }
      if (next >= 0) focusCell(next, col);
    } else if (e.key === "ArrowDown" && row < value.rows.length - 1) {
      e.preventDefault();
      focusCell(row + 1, col);
    } else if (e.key === "ArrowUp" && row > 0) {
      e.preventDefault();
      focusCell(row - 1, col);
    }
  }

  function onCellPaste(e: ClipboardEvent<HTMLInputElement>, row: number, col: number) {
    if (!value) return;
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text.replace(/\n$/, ""))) return;
    e.preventDefault();
    onChange(pasteInto(value, row, col, text));
  }

  async function copyPlaceholder(col: string) {
    const token = `{{${col}}}`;
    try {
      await navigator.clipboard.writeText(token);
      toast({ title: `Copied ${token}`, description: "Paste it into a criterion, check or seed." });
    } catch {
      toast({ title: token, description: "Type it into a criterion, check or seed." });
    }
  }

  const lead = value
    ? results.length
      ? `${total} ${total === 1 ? "row" : "rows"} · ${rowsSummary(results)}`
      : `${total} ${total === 1 ? "row" : "rows"}, one run each`
    : "Run this journey once per row of data.";

  return (
    <PanelSection
      title="Examples"
      help={HELP}
      lead={lead}
      data-examples-field
      action={
        value ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setPasting((p) => !p)} aria-expanded={pasting} data-examples-paste-toggle>
              <ClipboardPaste /> Paste
            </Button>
            <Button size="sm" variant="ghost" icon aria-label="Remove the table" title="Remove the table" onClick={() => onChange(null)} data-examples-remove>
              <Trash2 />
            </Button>
          </>
        ) : null
      }
    >
      {!value && !pasting ? (
        <ExamplesEmpty
          onStart={() => onChange(emptyTable(suggestedColumns))}
          onPaste={() => setPasting(true)}
          suggested={suggestedColumns}
        />
      ) : null}

      {pasting ? (
        <div className="flex flex-col gap-1.5" data-examples-paste>
          <textarea
            aria-label="Paste a table"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={4}
            autoFocus
            spellCheck={false}
            placeholder={"quantity\texpect\n1\tadded to cart\n\nor a CSV, or | quantity | expect | rows"}
            className={cn(textareaClass, "font-mono text-xs")}
          />
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="primary" onClick={applyPaste} disabled={!pasteText.trim()} data-examples-paste-apply>
              {value ? "Replace the table" : "Use this table"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>
              Cancel
            </Button>
            <span className="ml-auto text-xs text-muted">The first line names the columns.</span>
          </div>
        </div>
      ) : null}

      {value ? (
        <>
          <div className="max-h-[360px] overflow-auto rounded-md border border-border" data-examples-grid>
            <table ref={gridRef} className="w-max min-w-full border-separate border-spacing-0 text-xs">
              <thead className="sticky top-0 z-10 bg-panel-2">
                <tr>
                  <th scope="col" className="sticky left-0 z-20 w-9 border-b border-r border-border bg-panel-2 px-1.5 text-right font-normal text-muted">
                    <span className="sr-only">Row</span>#
                  </th>
                  {value.columns.map((col, c) => {
                    const colError = columnError(col, value.columns.slice(0, c));
                    const isUnused = unused.includes(col);
                    return (
                      <th key={c} scope="col" className="group/col border-b border-r border-border p-0 font-normal" data-examples-column={col}>
                        <div className="flex items-center gap-0.5 pr-0.5">
                          <input
                            aria-label={`Column ${c + 1} name`}
                            size={1}
                            style={{ width: `max(${col.length + 2}ch, calc(${widths[c] ?? 8}ch - 2.5rem))` }}
                            value={col}
                            onChange={(e) => onChange(renameColumn(value, c, e.target.value))}
                            spellCheck={false}
                            aria-invalid={colError ? true : undefined}
                            title={colError ?? (isUnused ? `Not used: no {{${col}}} in the scenario yet` : `Use {{${col}}} in the scenario`)}
                            className={cn(
                              "h-7 min-w-0 flex-1 bg-transparent px-2 font-mono font-medium text-fg outline-none placeholder:text-muted focus-visible:bg-hover aria-invalid:text-danger",
                              isUnused && "text-muted",
                            )}
                          />
                          {isUnused ? (
                            <span aria-label="not used by the scenario" title={`Not used: no {{${col}}} in the scenario yet`} className="size-1.5 shrink-0 rounded-full bg-muted/60" data-examples-unused={col} />
                          ) : null}
                          <SecretToggle on={isSecretAt(value, c)} column={col || `column ${c + 1}`} onToggle={() => onChange(toggleSecret(value, c))} />
                          <button
                            type="button"
                            aria-label={`Copy {{${col}}}`}
                            title={`Copy {{${col}}}`}
                            onClick={() => void copyPlaceholder(col)}
                            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/col:opacity-100"
                          >
                            <Copy className="size-3" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove column ${col || c + 1}`}
                            title="Remove the column"
                            onClick={() => onChange(removeColumn(value, c))}
                            disabled={value.columns.length === 1}
                            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted opacity-0 transition-opacity hover:bg-hover hover:text-danger focus-visible:opacity-100 disabled:hidden group-hover/col:opacity-100"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      </th>
                    );
                  })}
                  <th scope="col" className="w-8 border-b border-border p-0">
                    <button
                      type="button"
                      aria-label="Add a column"
                      title="Add a column"
                      disabled={value.columns.length >= MAX_COLUMNS}
                      onClick={() => {
                        onChange(addColumn(value));
                        requestAnimationFrame(() => gridRef.current?.querySelector<HTMLInputElement>(`[aria-label="Column ${value.columns.length + 1} name"]`)?.select());
                      }}
                      className="flex h-7 w-8 items-center justify-center text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                      data-examples-add-column
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {value.rows.map((row, r) => {
                  // A result only belongs to this row while the row still holds the values it ran with.
                  const ran = byRow.get(r);
                  const res = ran && value.columns.every((c, i) => (ran.values[c] ?? "") === (row[i] ?? "")) ? ran : undefined;
                  return (
                    <tr key={r} className="group/row" data-examples-row={r} data-row-state={res?.state}>
                      <th scope="row" className="sticky left-0 z-[5] border-b border-r border-border bg-panel px-1.5 text-right font-normal tabular text-muted group-hover/row:bg-hover">
                        {res ? (
                          <RowVerdict result={res} index={r} />
                        ) : (
                          <span>{r + 1}</span>
                        )}
                      </th>
                      {value.columns.map((col, c) => (
                        <td key={c} className="border-b border-r border-border p-0 group-hover/row:bg-hover/50">
                          {isSecretAt(value, c) ? (
                            <SecretCell
                              label={`Row ${r + 1}, ${col || `column ${c + 1}`}`}
                              cellKey={`${r}:${c}`}
                              value={row[c] ?? ""}
                              scenarioId={scenarioId}
                              width={widths[c] ?? 12}
                              onChange={(v) => onChange(setCell(value, r, c, v))}
                              onKeyDown={(e) => onCellKey(e, r, c)}
                            />
                          ) : (
                          <input
                            aria-label={`Row ${r + 1}, ${col || `column ${c + 1}`}`}
                            data-cell={`${r}:${c}`}
                            size={1}
                            value={row[c] ?? ""}
                            onChange={(e) => onChange(setCell(value, r, c, e.target.value))}
                            onKeyDown={(e) => onCellKey(e, r, c)}
                            onPaste={(e) => onCellPaste(e, r, c)}
                            spellCheck={false}
                            placeholder="empty"
                            style={{ width: `calc(${widths[c] ?? 8}ch + 1rem)` }}
                            className="h-7 w-full min-w-full bg-transparent px-2 text-fg outline-none placeholder:italic placeholder:text-muted/60 focus-visible:bg-selected"
                          />
                          )}
                        </td>
                      ))}
                      <td className="border-b border-border p-0">
                        <div className="flex h-7 items-center justify-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                          <button
                            type="button"
                            aria-label={`Duplicate row ${r + 1}`}
                            title="Duplicate the row"
                            onClick={() => onChange(duplicateRow(value, r))}
                            disabled={total >= MAX_ROWS}
                            className="hidden size-5 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg sm:flex"
                          >
                            <Copy className="size-3" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove row ${r + 1}`}
                            title="Remove the row"
                            onClick={() => onChange(removeRow(value, r))}
                            className="flex size-5 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-danger"
                            data-examples-remove-row
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {value.rows.length === 0 ? <p className="px-2.5 py-2 text-xs text-muted">No rows yet: the scenario will not run until the table has one.</p> : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={total >= MAX_ROWS}
              onClick={() => {
                onChange(addRow(value));
                focusCell(total, 0);
              }}
              data-examples-add-row
            >
              <Plus /> Add row
            </Button>
            {total >= MAX_ROWS ? <span className="text-xs text-muted">{MAX_ROWS} rows is the most a table holds.</span> : null}
          </div>

          {unused.length > 0 ? (
            <p className="text-xs text-muted" data-examples-unused-hint>
              {unused.length === 1 ? (
                <>
                  <span className="font-mono text-fg-2">{unused[0]}</span> is not used by the scenario. It is kept; write{" "}
                  <span className="font-mono">{`{{${unused[0]}}}`}</span> where it belongs.
                </>
              ) : (
                <>
                  {unused.length} columns are not used by the scenario ({unused.map((u, i) => (
                    <span key={u}>
                      {i > 0 ? ", " : ""}
                      <span className="font-mono text-fg-2">{u}</span>
                    </span>
                  ))}). They are kept.
                </>
              )}
            </p>
          ) : null}
          {error ? <FieldError data-examples-error>{error}</FieldError> : null}
        </>
      ) : null}
    </PanelSection>
  );
}

/** A column header's secret toggle: on, the column's values are sealed and shown as dots. */
function SecretToggle({ on, column, onToggle }: { on: boolean; column: string; onToggle: () => void }) {
  const label = on ? `${column} is secret: sealed, typed with type_secret. Make it plain` : `Make ${column} secret`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={on ? "Secret: stored encrypted, shown as dots, typed with type_secret. Turning it off clears the stored values." : "Mark secret: a password, PIN, code, token or key"}
      onClick={onToggle}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-sm transition-opacity hover:bg-hover focus-visible:opacity-100",
        on ? "text-accent" : "text-muted opacity-0 group-hover/col:opacity-100",
      )}
      data-examples-secret-toggle={on ? "on" : "off"}
    >
      {on ? <Lock className="size-3" aria-hidden /> : <LockOpen className="size-3" aria-hidden />}
    </button>
  );
}

/**
 * A secret column's cell: dots, never the value. A stored (sealed) cell shows only that something
 * is stored; typing replaces it. Holding the eye shows the value for as long as it is held: a
 * value typed here from memory, a stored one from the encrypted store (the owner's app only).
 */
export function SecretCell({
  label,
  cellKey,
  value,
  scenarioId,
  width,
  onChange,
  onKeyDown,
}: {
  label: string;
  cellKey: string;
  value: string;
  scenarioId?: string;
  width: number;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const { auth } = useScenarios();
  const stored = isSecretRef(value);
  const [shown, setShown] = useState<string | null>(null);
  const held = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // The value goes on the input as a property only, never as a `value` attribute in the markup
  // (React writes a controlled input's value into the attribute too).
  const text = shown ?? (stored ? "" : value);
  useLayoutEffect(() => {
    if (input.current && input.current.value !== text) input.current.value = text;
  }, [text]);

  async function show() {
    held.current = true;
    if (!stored) {
      setShown(value);
      return;
    }
    if (!scenarioId) return;
    try {
      const got = await revealExample(scenarioId, auth.human?.id ?? null, value);
      // Released before the value came back: it is never shown.
      if (held.current) setShown(got);
    } catch {
      // nothing to show
    }
  }
  function hide() {
    held.current = false;
    setShown(null);
  }

  return (
    <div className="flex h-7 items-center" data-secret-cell={stored ? "stored" : value ? "typed" : "empty"}>
      <input
        aria-label={`${label} (secret)`}
        data-cell={cellKey}
        type={shown !== null ? "text" : "password"}
        ref={input}
        size={1}
        autoComplete="off"
        spellCheck={false}
        readOnly={shown !== null}
        placeholder={stored ? "••••••••" : "empty"}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={hide}
        style={{ width: `calc(${width}ch + 1rem)` }}
        className={cn(
          "h-7 min-w-0 flex-1 bg-transparent px-2 text-fg outline-none focus-visible:bg-selected",
          stored ? "placeholder:text-fg-2" : "placeholder:italic placeholder:text-muted/60",
        )}
      />
      {stored || value ? (
        <button
          type="button"
          aria-label={`Hold to show ${label}`}
          title="Hold to show"
          onPointerDown={() => void show()}
          onPointerUp={hide}
          onPointerLeave={hide}
          onPointerCancel={hide}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) void show();
          }}
          onKeyUp={hide}
          onBlur={hide}
          className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg"
          data-secret-reveal
        >
          <Eye className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** A row's latest verdict in its number cell; opens the run. */
function RowVerdict({ result, index }: { result: RowResult; index: number }) {
  const label = `Row ${index + 1}: ${ROW_WORD[result.state]}${result.reason ? `. ${result.reason}` : ""}`;
  const glyph = <StatusGlyph status={ROW_GLYPH[result.state]} decorative className="size-3" />;
  return result.runId ? (
    <a href={qaHref({ view: "sessions", session: result.runId })} title={label} aria-label={label} className={cn("inline-flex items-center gap-1 rounded-sm hover:text-fg", m.land)} data-row-verdict={result.state}>
      {glyph}
      <span>{index + 1}</span>
    </a>
  ) : (
    <span title={label} aria-label={label} className={cn("inline-flex items-center gap-1", m.land)} data-row-verdict={result.state}>
      {glyph}
      <span>{index + 1}</span>
    </span>
  );
}

/** The teaching empty state: a ghost table whose rows turn into runs. */
function ExamplesEmpty({ onStart, onPaste, suggested }: { onStart: () => void; onPaste: () => void; suggested: readonly string[] }) {
  const ghost = [
    ["1", "added to cart", "pass"],
    ["3", "3 in the cart", "pass"],
    ["0", "quantity must be at least 1", "fail"],
  ];
  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed border-border px-3 py-3" data-examples-empty>
      <div aria-hidden className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1 font-mono text-2xs text-muted">
          <div className="flex gap-2 text-fg-2">
            <span className="w-16">quantity</span>
            <span>expect</span>
          </div>
          {ghost.map(([a, b], i) => (
            <div key={i} className={cn("flex gap-2", m.ghostRow)} style={{ "--d": `${i * 140}ms` } as CSSProperties}>
              <span className="w-16 truncate">{a || <i className="text-muted/60">empty</i>}</span>
              <span className="truncate">{b}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1 pt-4">
          {ghost.map(([, , s], i) => (
            <span key={i} className={cn("flex h-[15px] items-center", m.ghostRun)} style={{ "--d": `${500 + i * 220}ms` } as CSSProperties}>
              <StatusGlyph status={s === "pass" ? "pass" : "fail"} decorative className="size-3" />
            </span>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">
        Each row becomes its own run with its own verdict. Write <span className="font-mono text-fg-2">{"{{column}}"}</span> in criteria,
        checks or seeds{suggested.length > 0 ? (
          <>
            ; this scenario already uses{" "}
            {suggested.slice(0, 3).map((s, i) => (
              <span key={s}>
                {i > 0 ? ", " : ""}
                <span className="font-mono text-fg-2">{`{{${s}}}`}</span>
              </span>
            ))}
          </>
        ) : null}
        .
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={onStart} data-examples-start>
          <Table2 /> Add a table
        </Button>
        <Button size="sm" variant="ghost" onClick={onPaste} data-examples-paste-start>
          <ClipboardPaste /> Paste from a sheet
        </Button>
      </div>
    </div>
  );
}

/** The latest result per row of a saved scenario (refetched when its table appears). */
function useRowResults(scenarioId: string | undefined, enabled: boolean): RowResult[] {
  const [rows, setRows] = useState<RowResult[]>([]);
  useEffect(() => {
    if (!scenarioId || !enabled) return;
    let alive = true;
    exampleRows(scenarioId)
      .then((got) => {
        if (alive) setRows(got);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [scenarioId, enabled]);
  return enabled ? rows : [];
}
