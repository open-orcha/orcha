/**
 * Nav build item 3 — header "Recent files" dropdown, fed by the SAME
 * localStorage recency (recentFiles.ts) the landing state's "Recent files"
 * card reads — a human already deep in a file gets the same quick-jump
 * without leaving the file view. Closes on outside click and Escape (house
 * SymbolSearch.tsx / composer convention: Escape closes transient panels).
 */
import { Button, Popover } from "../../components/primitives";
import { useEffect, useRef, useState } from "react";
import { relTime } from "../../lib/format";
import { loadRecentFiles, type RecentFileEntry } from "./recentFiles";

export interface RecentFilesDropdownProps {
  cid: string;
  currentPath: string;
  onOpenFile: (path: string) => void;
  // bump this whenever a file opens elsewhere so the list re-reads
  // localStorage instead of going stale for the lifetime of the mount.
  refreshToken: number;
}

export function RecentFilesDropdown({ cid, currentPath, onOpenFile, refreshToken }: RecentFilesDropdownProps) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<RecentFileEntry[]>([]);
  const anchor = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setFiles(loadRecentFiles(cid));
  }, [cid, refreshToken]);

  // Usability sweep papercut: opening a file via the TREE (or a breadcrumb,
  // or a symbol/thread jump) while this dropdown happens to be open left it
  // dangling open over the new file instead of closing like every other
  // "picked something, done" flow in the panel.
  useEffect(() => {
    setOpen(false);
  }, [currentPath]);

  const others = files.filter((f) => f.path !== currentPath);
  const pick = (p: string) => { onOpenFile(p); setOpen(false); };

  // The menu is the shared Popover (portaled, so the toolbar row never clips
  // it; outside-click / Escape close it and focus returns to the pill).
  return (
    <div className="cs-recentfiles-dd">
      <Button
        ref={anchor}
        size="md"
        variant="ghost"
        pill
        icon="clock"
        iconRight="chev"
        className="cs-recentfiles-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Recent files"
      >
        Recent
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} role="dialog" label="Recent files" className="cs-recentfiles-panel" autoFocus={false}>
        {!others.length ? (
          <div className="cs-empty-line">No other recent files yet.</div>
        ) : (
          others.map((f) => (
            <div
              key={f.path}
              className="cs-recentfiles-row"
              role="button"
              tabIndex={0}
              onClick={() => pick(f.path)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(f.path); } }}
            >
              <span className="cs-recentfiles-path mono" title={f.path}>{f.path}</span>
              <span className="cs-recentfiles-time">{relTime(f.viewedAt)}</span>
            </div>
          ))
        )}
      </Popover>
    </div>
  );
}
