import { useEffect, useRef, useState } from "react";
import { Paperclip, Trash2 } from "../map/kit/icons";
import { Button } from "../map/kit";
import { useToast } from "../map/kit";
import { errText } from "../parts";
import { addScenarioFile, listScenarioFiles, removeScenarioFile, type ScenarioFile } from "./api";
import { HumanGate, useScenarios } from "./context";
import { PanelSection } from "./panel-ui";

function bytesToKb(n: number | null): string {
  if (n == null) return "";
  return n > 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** File attachments for a scenario (spec §D): upload to bucket `qa-files`, list, delete. */
export function ScenarioFilesList({ scenarioId }: { scenarioId: string }) {
  const { toast } = useToast();
  const { auth } = useScenarios();
  const actor = auth.human?.id ?? null;
  const [files, setFiles] = useState<ScenarioFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function load() {
    void listScenarioFiles(scenarioId).then(setFiles, () => setFiles([]));
  }

  useEffect(load, [scenarioId]);

  async function upload(file: File) {
    setUploading(true);
    try {
      await addScenarioFile(scenarioId, actor, file);
      load();
    } catch (err) {
      toast({ title: "Upload failed", description: errText(err), variant: "error" });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(id: string) {
    try {
      await removeScenarioFile(id, actor);
      load();
    } catch (err) {
      toast({ title: "Could not delete file", description: errText(err), variant: "error" });
    }
  }

  return (
    <PanelSection
      title="Files"
      data-scenario-files
      action={
        <>
          <HumanGate>
            <Button size="sm" variant="ghost" loading={uploading} onClick={() => inputRef.current?.click()} data-attach-file>
              {uploading ? null : <Paperclip />} Attach
            </Button>
          </HumanGate>
          <input
            ref={inputRef}
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </>
      }
    >
      {files === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : files.length === 0 ? (
        <p className="text-xs text-muted">No files attached.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {files.map((f) => (
            <li key={f.id} data-scenario-file={f.id} className="flex h-8 items-center gap-2 pl-2.5 pr-1 text-sm">
              <Paperclip aria-hidden className="size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-fg" title={f.file_name}>
                {f.file_name}
              </span>
              <span className="shrink-0 text-xs tabular text-muted">{bytesToKb(f.size_bytes)}</span>
              <Button size="sm" variant="ghost" icon aria-label="Delete file" disabled={!auth.can} onClick={() => void remove(f.id)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
