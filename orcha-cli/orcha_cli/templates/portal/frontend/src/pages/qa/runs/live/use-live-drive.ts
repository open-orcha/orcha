import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../map/kit";
import { sendInput, setTakeover } from "./liveApi";
import type { Json, RecordingCommand, RecordingCommandKind } from "./recording";
import type { Command } from "./recording-gestures";
import { HEARTBEAT_MS, NO_OFFSET, inputRows, previewOffset, unsettled, type InputRow, type Offset, type PendingInput } from "./recording-inputs";
import type { LiveMeta } from "./recording-live";

/** The stored inputs as the portal lists them. */
function commandsOf(meta: LiveMeta | null): RecordingCommand[] {
  return (meta?.inputs ?? []).map((c) => ({ ...c, id: String(c.seq) }));
}

/**
 * A person driving the device from the live view: taking it over and handing it back, the
 * heartbeat that keeps the agent held only while their page is open, and their inputs, made
 * optimistic and posted strictly one after another, in the order made, so the server assigns seqs
 * in that order. Nothing waits for a frame: the next input can follow at once.
 */
export function useLiveDrive(sessionId: string, meta: LiveMeta | null, actor: string | null, wake: () => void) {
  const { toast } = useToast();
  const [inputs, setInputs] = useState<PendingInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [longPress, setLongPress] = useState(false);
  const commands = useMemo(() => commandsOf(meta), [meta]);
  const driving = Boolean(meta?.takeover && actor && meta.takeover.by_id === actor);
  const liveCmdSeq = meta?.cmd_seq ?? null;
  const live = unsettled(inputs, commands, null, liveCmdSeq);

  const latest = useRef({ commands, liveCmdSeq });
  useEffect(() => {
    latest.current = { commands, liveCmdSeq };
  });
  useEffect(() => {
    setInputs((prev) => unsettled(prev, latest.current.commands, null, latest.current.liveCmdSeq));
  }, [commands, liveCmdSeq]);

  // While their page is open the agent stays held; a closed tab gives the device back.
  useEffect(() => {
    if (!driving) return;
    const timer = setInterval(() => void setTakeover(sessionId, actor, true, true).catch(() => {}), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [driving, sessionId, actor]);

  const take = useCallback(
    async (on: boolean) => {
      setBusy(true);
      try {
        await setTakeover(sessionId, actor, on);
        wake();
      } catch (err) {
        toast({ title: on ? "Could not take over" : "Could not hand back", description: err instanceof Error ? err.message : String(err), variant: "error" });
      } finally {
        setBusy(false);
      }
    },
    [sessionId, actor, wake, toast],
  );

  const nextLocalId = useRef(1);
  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());

  const send = useCallback(
    (kind: RecordingCommandKind, args: Record<string, Json>, slide: Offset = NO_OFFSET): Promise<boolean> => {
      const localId = nextLocalId.current++;
      setInputs((prev) => [...prev, { localId, kind, args, preview: slide, sentAtSeq: null, command: null }]);
      const next = sendQueue.current.then(async () => {
        let command: RecordingCommand | null = null;
        try {
          const row = await sendInput(sessionId, actor, kind, args);
          command = { ...row, id: String(row.seq) };
        } catch (err) {
          toast({ title: "Input not sent", description: err instanceof Error ? err.message : String(err), variant: "error" });
        }
        setInputs((prev) =>
          command ? prev.map((i) => (i.localId === localId ? { ...i, command } : i)) : prev.filter((i) => i.localId !== localId),
        );
        wake();
        return command !== null;
      });
      sendQueue.current = next;
      wake();
      return next;
    },
    [sessionId, actor, wake, toast],
  );

  const onInput = useCallback((command: Command, slide: Offset) => void send(command.kind, command.args, slide), [send]);

  const slideFor = useCallback(() => previewOffset(unsettled(inputs, commands, null, liveCmdSeq)), [inputs, commands, liveCmdSeq]);

  const rows: InputRow[] = inputRows(commands, live);
  return { driving, busy, take, send, onInput, slideFor, rows, longPress, setLongPress };
}
