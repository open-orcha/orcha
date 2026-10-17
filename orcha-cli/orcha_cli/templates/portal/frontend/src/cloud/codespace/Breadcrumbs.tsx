/**
 * Nav build item 3 — clickable breadcrumb path segments in the content
 * header: each intermediate segment opens that directory in the tree pane
 * (expanding it and clearing any active filter down to that point); the
 * final segment is the current file, non-interactive (it's already open).
 * Pure split/render — path math lives in codespaceTypes-adjacent helpers so
 * it's unit-testable without mounting anything.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui";
export interface BreadcrumbSegment {
  name: string;
  // "" for the repo root (clicking it clears/opens the tree at root).
  dirPath: string;
  isFile: boolean;
}

// path "a/b/c.ts" -> [ {name:"a", dirPath:"a"}, {name:"b", dirPath:"a/b"}, {name:"c.ts", dirPath:"a/b/c.ts", isFile:true} ]
// A root-level file ("a.ts") is a single isFile segment, no leading dir crumb.
export function breadcrumbSegments(path: string): BreadcrumbSegment[] {
  if (!path) return [];
  const parts = path.split("/").filter(Boolean);
  const segments: BreadcrumbSegment[] = [];
  let acc = "";
  parts.forEach((part, i) => {
    acc = acc ? acc + "/" + part : part;
    segments.push({ name: part, dirPath: acc, isFile: i === parts.length - 1 });
  });
  return segments;
}

export interface BreadcrumbsProps {
  path: string;
  onOpenDir: (dirPath: string) => void;
}

/**
 * Middle-collapse for deep paths so the crumb trail stays ONE line: keep the
 * first directory and the last two, fold the rest into a "…" crumb (which
 * opens the deepest folded directory; its title carries the full path).
 * Exported for tests.
 */
export const MAX_VISIBLE_DIRS = 3;
export function collapseSegments(segments: BreadcrumbSegment[]): (BreadcrumbSegment | { ellipsis: true; dirPath: string; hidden: string[] })[] {
  const dirs = segments.filter((s) => !s.isFile);
  if (dirs.length <= MAX_VISIBLE_DIRS) return segments;
  const hidden = dirs.slice(1, dirs.length - 2);
  return [
    dirs[0],
    { ellipsis: true, dirPath: hidden[hidden.length - 1].dirPath, hidden: hidden.map((h) => h.name) },
    ...dirs.slice(dirs.length - 2),
    ...segments.filter((s) => s.isFile),
  ];
}

/**
 * Pure: should the trail collapse to "… / file"? True when the full trail's
 * natural width doesn't fit the space the file bar gives it (0 = unmeasured,
 * e.g. jsdom — never collapse on missing layout).
 */
export function shouldCompact(fullWidth: number, available: number): boolean {
  return available > 0 && fullWidth > available + 0.5;
}

/**
 * The trail never truncates individual segments ("s… / sh… / Shell.tsx" is
 * unreadable): when the full trail doesn't fit — e.g. Edit mode adds the
 * save state and the Editing toggle to the file bar — it collapses to
 * "… / Shell.tsx", where "…" opens the parent directory and carries the full
 * path as its tooltip. The full trail's natural width is measured while it
 * is shown and compared with the file bar's space on every resize.
 */
export function Breadcrumbs({ path, onOpenDir }: BreadcrumbsProps) {
  const navRef = useRef<HTMLElement | null>(null);
  const fullWidth = useRef(0);
  const [compact, setCompact] = useState(false);
  const segments = breadcrumbSegments(path);

  // a new path always re-measures from the full trail
  useLayoutEffect(() => { fullWidth.current = 0; setCompact(false); }, [path]);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const box = (nav.parentElement as HTMLElement | null) ?? nav;
    const check = () => {
      if (!compact) fullWidth.current = nav.scrollWidth;
      setCompact(shouldCompact(fullWidth.current, box.clientWidth));
    };
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(box);
    return () => ro.disconnect();
  }, [path, compact]);

  if (!segments.length) return null;
  const items = collapseSegments(segments);
  const file = segments[segments.length - 1];
  const parentDir = segments.length > 1 ? segments[segments.length - 2].dirPath : "";

  const full = (
    <>
      {/* wave4 review: no other surface calls the repo "root" — a folder
          glyph (named for AT) opens the repository root */}
      <button type="button" className="cs-crumb cs-crumb-root" onClick={() => onOpenDir("")} title="Repository root" aria-label="Repository root">
        <Icon name="folder" cls="v2-ico cs-crumb-root-ico" />
      </button>
      {items.map((seg) => (
        <span key={seg.dirPath + ("ellipsis" in seg ? "…" : "")} className={"cs-crumb-group" + ("isFile" in seg && seg.isFile ? " is-file" : "")}>
          <span className="cs-crumb-sep" aria-hidden="true">/</span>
          {"ellipsis" in seg ? (
            <button type="button" className="cs-crumb cs-crumb-ellipsis" onClick={() => onOpenDir(seg.dirPath)} title={"Open " + seg.dirPath} aria-label={"Open " + seg.dirPath}>
              …
            </button>
          ) : seg.isFile ? (
            <span className="cs-crumb cs-crumb-file" aria-current="page" title={seg.dirPath}>{seg.name}</span>
          ) : (
            <button type="button" className="cs-crumb" onClick={() => onOpenDir(seg.dirPath)} title={"Open " + seg.dirPath}>
              {seg.name}
            </button>
          )}
        </span>
      ))}
    </>
  );

  return (
    <nav ref={navRef} className={"cs-breadcrumbs mono" + (compact ? " is-compact" : "")} aria-label="File path" title={path}>
      {compact ? (
        <>
          <button type="button" className="cs-crumb cs-crumb-ellipsis cs-crumb-up" onClick={() => onOpenDir(parentDir)}
            title={"Open " + (parentDir || "repository root")} aria-label={"Open " + (parentDir || "repository root")}>
            …
          </button>
          <span className="cs-crumb-group is-file">
            <span className="cs-crumb-sep" aria-hidden="true">/</span>
            <span className="cs-crumb cs-crumb-file" aria-current="page" title={file.dirPath}>{file.name}</span>
          </span>
        </>
      ) : full}
    </nav>
  );
}
