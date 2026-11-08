import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileCode2, ImageDown } from "../map/kit/icons";
import { Button, cn, useToast } from "../map/kit";
import type { Platform } from "../qaApi";
import { exportMarkdown } from "./api";
import { TextDialog } from "./text-dialog";

export interface ExportMenuProps {
  cid: string;
  /** The platform the filter is on; null = every platform. */
  platform: Platform | null;
  projectName: string;
  /** Map view: saves the map as a PNG; false when there is nothing on it. */
  onPng?: () => boolean;
}

/** Toolbar export menu: all scenarios as scenario markdown. */
export function ExportMenu({ cid, platform, projectName, onPng }: ExportMenuProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  async function exportAll() {
    setOpen(false);
    setLoading(true);
    try {
      setText(await exportMarkdown(cid, platform));
    } catch (err) {
      toast({ title: "Could not export", description: err instanceof Error ? err.message : "Network error.", variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <Button size="sm" loading={loading} onClick={() => setOpen((o) => !o)} aria-expanded={open} data-export-menu-trigger>
        <Download /> Export <ChevronDown className="size-3" />
      </Button>
      <div role="menu" aria-label="Export" data-export-menu className={cn("absolute right-0 top-full z-20 mt-1.5 w-[220px] rounded-lg border border-border bg-raised p-1 shadow-md", open ? "block" : "hidden")}>
        <button type="button" role="menuitem" data-export-all-markdown onClick={() => void exportAll()} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-hover">
          <FileCode2 className="size-3.5 text-muted" /> Export all as Markdown
        </button>
        {onPng ? (
          <button
            type="button"
            role="menuitem"
            data-export-png
            onClick={() => {
              setOpen(false);
              if (!onPng()) toast({ title: "Nothing to export", description: "No scenario is on the map.", variant: "error" });
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-hover"
          >
            <ImageDown className="size-3.5 text-muted" /> Export map as PNG
          </button>
        ) : null}
      </div>
      <TextDialog open={text !== null} onClose={() => setText(null)} title="All scenarios as Markdown" description={`Every scenario of ${projectName}.`} text={text ?? ""} />
    </div>
  );
}
