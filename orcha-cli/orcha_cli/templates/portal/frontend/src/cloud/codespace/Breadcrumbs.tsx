/**
 * Nav build item 3 — clickable breadcrumb path segments in the content
 * header: each intermediate segment opens that directory in the tree pane
 * (expanding it and clearing any active filter down to that point); the
 * final segment is the current file, non-interactive (it's already open).
 * Pure split/render — path math lives in codespaceTypes-adjacent helpers so
 * it's unit-testable without mounting anything.
 */
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

export function Breadcrumbs({ path, onOpenDir }: BreadcrumbsProps) {
  const segments = breadcrumbSegments(path);
  if (!segments.length) return null;
  return (
    <nav className="cs-breadcrumbs mono" aria-label="File path">
      <button type="button" className="cs-crumb cs-crumb-root" onClick={() => onOpenDir("")} title="Repository root">
        root
      </button>
      {segments.map((seg) => (
        <span key={seg.dirPath} className="cs-crumb-group">
          <span className="cs-crumb-sep" aria-hidden="true">/</span>
          {seg.isFile ? (
            <span className="cs-crumb cs-crumb-file" aria-current="page">{seg.name}</span>
          ) : (
            <button type="button" className="cs-crumb" onClick={() => onOpenDir(seg.dirPath)} title={"Open " + seg.dirPath}>
              {seg.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
