/**
 * The recording page's optimistic inputs: what the person did, shown at once in the Inputs
 * list and on the screen (a scroll slides the frame), before the server and the worker catch
 * up. Pure helpers; `use-live-drive.ts` holds the state.
 */
import type { Json, RecordingCommand, RecordingCommandKind } from "./recording";

export interface Offset {
  x: number;
  y: number;
}

export const NO_OFFSET: Offset = { x: 0, y: 0 };

/** An input the page sent (or is sending). */
export interface PendingInput {
  localId: number;
  kind: RecordingCommandKind;
  args: Record<string, Json>;
  /** How far the frame was slid for it (displayed pixels); undone once its frame is shown. */
  preview: Offset;
  /** The frame on screen when it was made: its own frame is a newer one. */
  sentAtSeq: number | null;
  /** The stored row, once the POST returned. */
  command: RecordingCommand | null;
}

/** One row of the Inputs list. `sending`: not stored yet. */
export interface InputRow {
  key: string;
  seq: number | null;
  kind: RecordingCommandKind;
  args: Record<string, Json>;
  status: "sending" | RecordingCommand["status"];
  result: string | null;
}

/** How many inputs the person made (#472): every command but Finish, which only ends it. */
export function personInputCount(commands: readonly Pick<RecordingCommand, "kind">[]): number {
  return commands.filter((c) => c.kind !== "finish").length;
}

/** The stored commands, then the inputs the server has not listed yet, in the order made. */
export function inputRows(commands: readonly RecordingCommand[], inputs: readonly PendingInput[]): InputRow[] {
  const listed = new Set(commands.map((c) => c.id));
  const rows: InputRow[] = commands.map((c) => ({
    key: c.id,
    seq: c.seq,
    kind: c.kind,
    args: c.args,
    status: c.status,
    result: c.result,
  }));
  for (const input of inputs) {
    if (input.command && listed.has(input.command.id)) continue;
    rows.push(
      input.command
        ? { key: input.command.id, seq: input.command.seq, kind: input.kind, args: input.args, status: input.command.status, result: null }
        : { key: `local-${input.localId}`, seq: null, kind: input.kind, args: input.args, status: "sending", result: null },
    );
  }
  return rows;
}

/**
 * The inputs still in flight: an input is settled once the worker played it (its stored row
 * is no longer pending) and the screen shows the result: a live frame taken after its command
 * ran (`liveCmdSeq`, the newest command seq the live frame on screen shows), or a recorded
 * frame newer than the one it was made on.
 */
export function unsettled(
  inputs: readonly PendingInput[],
  commands: readonly RecordingCommand[],
  shownSeq: number | null,
  liveCmdSeq: number | null = null,
): PendingInput[] {
  const status = new Map(commands.map((c) => [c.id, c.status]));
  return inputs.filter((input) => {
    if (!input.command) return true;
    const s = status.get(input.command.id) ?? input.command.status;
    if (s === "pending" || s === "sent") return true;
    if (liveCmdSeq != null && liveCmdSeq >= input.command.seq) return false;
    return shownSeq == null || input.sentAtSeq == null ? false : shownSeq <= input.sentAtSeq;
  });
}

/** How far the frame is slid in all for the inputs still in flight. */
export function previewOffset(inputs: readonly PendingInput[], live: Offset = NO_OFFSET): Offset {
  return inputs.reduce((acc, i) => ({ x: acc.x + i.preview.x, y: acc.y + i.preview.y }), live);
}

/** The driving page says it is there this often, so the agent is not held for a closed tab. */
export const HEARTBEAT_MS = 15_000;

