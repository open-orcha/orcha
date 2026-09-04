/**
 * Nav build item 3 — header "Recent files" dropdown, fed by the SAME
 * localStorage recency (recentFiles.ts) the landing state's "Recent files"
 * card reads — a human already deep in a file gets the same quick-jump
 * without leaving the file view. Closes on outside click and Escape (house
 * SymbolSearch.tsx / composer convention: Escape closes transient panels).
 */
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
  const rootRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const others = files.filter((f) => f.path !== currentPath);

  return (
    <div className="cs-recentfiles-dd" ref={rootRef}>
      <button type="button" className="cs-recentfiles-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Recent files
      </button>
      {open ? (
        <div className="cs-recentfiles-panel">
          {!others.length ? (
            <div className="none" style={{ padding: 8 }}>No other recent files yet.</div>
          ) : (
            others.map((f) => (
              <div key={f.path} className="cs-recentfiles-row" onClick={() => { onOpenFile(f.path); setOpen(false); }}>
                <span className="cs-recentfiles-path mono" title={f.path}>{f.path}</span>
                <span className="cs-recentfiles-time">{relTime(f.viewedAt)}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
