import { describe, expect, it } from "vitest";
import { parseCheck } from "./checks";
import {
  columnError,
  examplesError,
  examplesToMarkdown,
  fillRow,
  parseExamples,
  parsePastedTable,
  rowLabel,
  sessionCount,
  unusedColumns,
  validateExamples,
  MAX_ROWS,
} from "./examples";
import { addColumn, addRow, duplicateRow, emptyTable, pasteInto, removeColumn, removeRow, renameColumn, setCell } from "./examples-edit";
import { cleanupLineError, seedLineError, seedNames, validateCleanup } from "./seeds";

const PLATES = { columns: ["plate", "expect", "notes"], rows: [["KBX 421T", "saved"], ["kbx 421t", "saved as KBX 421T", ""], ["", "a plate is required", "edge"]] };

describe("examples tables (#191)", () => {
  it("pads short rows, keeps empty cells and refuses what the worker would", () => {
    const t = parseExamples(PLATES)!;
    expect(t.rows[0]).toEqual(["KBX 421T", "saved", ""]);
    expect(examplesError(t)).toBeNull();
    expect(columnError("tag")).toMatch(/reserved/);
    expect(columnError("Plate", ["plate"])).toMatch(/twice/);
    expect(columnError("2nd")).toMatch(/start with a letter/);
    expect(examplesError({ columns: ["a"], rows: Array.from({ length: MAX_ROWS + 1 }, () => ["x"]) })).toMatch(/At most/);
    expect(validateExamples(null)).toEqual({ ok: true, examples: null });
    expect(validateExamples({ columns: [], rows: [] })).toEqual({ ok: true, examples: null });
    expect(validateExamples({ columns: ["a", "b"], rows: [["1", "2", "3"]] })).toMatchObject({ ok: false });
    expect(validateExamples({ columns: [" plate "], rows: [["A"]] })).toEqual({ ok: true, examples: { columns: ["plate"], rows: [["A"]] } });
  });

  it("handles a 50-row converted table", () => {
    const big = { columns: ["n", "unused"], rows: Array.from({ length: 50 }, (_, i) => [String(i), ""]) };
    expect(validateExamples(big)).toMatchObject({ ok: true });
    expect(unusedColumns(parseExamples(big), ["shows {{n}}"])).toEqual(["unused"]);
  });

  it("finds unused columns, labels rows and fills {{column}} ignoring case", () => {
    const t = parseExamples(PLATES)!;
    expect(unusedColumns(t, ["Typing {{Plate}} shows {{expect}}", null])).toEqual(["notes"]);
    expect(rowLabel({ plate: "", expect: "a plate is required" })).toBe("plate = (empty), expect = a plate is required");
    expect(fillRow("Type {{PLATE}} for {{truck.id}}", { plate: "KBX" })).toBe("Type KBX for {{truck.id}}");
  });

  it("pastes spreadsheets, CSV, markdown and Gherkin tables", () => {
    expect(parsePastedTable("plate\texpect\nKBX 421T\tsaved\n")).toEqual({ columns: ["plate", "expect"], rows: [["KBX 421T", "saved"]] });
    expect(parsePastedTable('plate,expect\n"KBX, 421T",saved')).toEqual({ columns: ["plate", "expect"], rows: [["KBX, 421T", "saved"]] });
    expect(parsePastedTable("Examples:\n  | <plate> | expect |\n  | KBX | saved |\n  | x |")).toEqual({
      columns: ["plate", "expect"],
      rows: [["KBX", "saved"], ["x", ""]],
    });
    const md = examplesToMarkdown({ columns: ["a"], rows: [["x | y"]] });
    expect(md).toBe("## Examples\n| a |\n| --- |\n| x \\| y |");
    expect(parsePastedTable(md)).toEqual({ columns: ["a"], rows: [["x | y"]] });
  });

  it("edits stay inside the limits", () => {
    let t = emptyTable(["plate"]);
    t = setCell(addRow(t), 1, 0, "B");
    t = renameColumn(addColumn(t), 1, "expect");
    expect(t).toEqual({ columns: ["plate", "expect"], rows: [["", ""], ["B", ""]] });
    expect(duplicateRow(t, 1).rows[2]).toEqual(["B", ""]);
    expect(removeRow(t, 0).rows).toEqual([["B", ""]]);
    expect(removeColumn(t, 0)).toEqual({ columns: ["expect"], rows: [[""], [""]] });
    expect(addColumn({ columns: ["column_2"], rows: [] }).columns).toEqual(["column_2", "column_3"]);
    // Pasting a block into one cell fills the grid from there.
    expect(pasteInto(emptyTable(["a"]), 0, 0, "1\t2\n3\t4\n")).toEqual({ columns: ["a", "column_2"], rows: [["1", "2"], ["3", "4"]] });
    const full = { columns: ["a"], rows: Array.from({ length: MAX_ROWS }, () => [""]) };
    expect(addRow(full)).toBe(full);
    expect(emptyTable([])).toEqual({ columns: ["value"], rows: [[""]] });
  });
});

describe("delta checks and owned data", () => {
  it("validates and normalises delta checks like the harness", () => {
    expect(parseCheck("api /trucks/{{truck.id}} .income increases by 4,321 within 10s")).toEqual({
      ok: true,
      normalised: "api GET /trucks/{{truck.id}} .income increases by 4321 within 10s",
    });
    expect(parseCheck("query select count(*) from trips where org = '{{org.id}}' increases by {{added}}")).toEqual({
      ok: true,
      normalised: "query select count(*) from trips where org = '{{org.id}}' increases by {{added}}",
    });
    expect(parseCheck("query delete from trips increases")).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    expect(parseCheck("api GET /x grows")).toMatchObject({ ok: false });
    expect(parseCheck("query select 1 decreases by -2")).toMatchObject({ ok: false, error: expect.stringMatching(/positive/) });
    expect(parseCheck('text "Saved"')).toEqual({ ok: true, normalised: 'text "Saved"' });
  });

  it("names seeded records and validates cleanup", () => {
    expect(seedLineError('POST /api/trucks {"plate": "QA-{{tag4}}"} as truck')).toBeNull();
    expect(seedLineError('storage {"a": 1} as x')).toMatch(/nothing to name/);
    expect(seedNames(['POST /api/trucks {} as truck', "fixture fleet as fleet", "fixture x"])).toEqual(["truck", "fleet"]);
    expect(cleanupLineError("DELETE /api/trucks/{{truck.id}}")).toBeNull();
    expect(cleanupLineError("fixture x")).toMatch(/HTTP call/);
    expect(validateCleanup(["DELETE /a/1", ""])).toEqual({ ok: true, cleanup: ["DELETE /a/1"] });
    expect(validateCleanup(null)).toEqual({ ok: true, cleanup: null });
  });

});

describe("sessionCount (#284)", () => {
  it("counts one session per Examples row and one per scenario without a table", () => {
    const table = { columns: ["name"], rows: [["Mary"], ["Amina"], ["Joseph"]] };
    expect(sessionCount([{ examples: table }, { examples: null }, {}])).toBe(5);
    expect(sessionCount([{ examples: JSON.stringify(table) }])).toBe(3);
    expect(sessionCount([{ examples: { columns: ["a"], rows: [] } }])).toBe(1);
  });
});
