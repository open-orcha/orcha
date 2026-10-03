/**
 * Binary / media changes in a diff, GitHub-style: a modified image compares
 * 2-up (before | after), Swipe (a draggable divider) or Onion skin (fade
 * after over before); an added file shows only "after", a deleted one only
 * "before". Other previewable kinds (PDF, video, audio, fonts) show their
 * side(s) through FilePreview; anything else gets the unsupported card. The
 * bytes come from a `BlobSource` — the host's raw route for each side.
 */
import { useState, type CSSProperties } from "react";
import { Segmented } from "../primitives";
import { formatBytes, isRichKind, kindFromExt, PREVIEW_CAP_BYTES } from "../../lib/filePreview";
import { DownloadLink, FilePreview, UnsupportedCard } from "./FilePreview";
import { useRawFile, type RawState } from "./useRawFile";
import "./filePreview.css";

export type DiffSide = "old" | "new";

/** The file a diff names (new path, original path, M/A/D/R). */
export interface DiffFileRef {
  path: string;
  old?: string;
  status: string;
  /** byte size of the new side when the patch states it */
  size?: number | null;
}

/** Where a side's bytes live — a portal `/raw` URL, or null when unavailable. */
export type BlobSource = (file: DiffFileRef, side: DiffSide) => string | null;

type Mode = "2up" | "swipe" | "onion";

function useImage(url: string | null, svg: boolean): RawState {
  return useRawFile(url, { cap: svg ? PREVIEW_CAP_BYTES.svg : PREVIEW_CAP_BYTES.image, type: svg ? "image/svg+xml" : undefined });
}

function Side({ label, tone, st, path, url, onDims }: { label: string; tone: "del" | "add"; st: RawState; path: string; url: string | null; onDims: (d: { w: number; h: number }) => void }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  return (
    <figure className={"fp-side fp-side-" + tone} data-testid={"fp-side-" + (tone === "del" ? "before" : "after")}>
      <figcaption className="fp-side-h">
        <span className={"fp-side-l fp-" + tone}>{label}</span>
        <span className="fp-meta">
          {[dims ? `${dims.w} × ${dims.h}` : null, st.status === "ok" ? formatBytes(st.size) : null].filter(Boolean).join(" · ")}
        </span>
      </figcaption>
      {st.status === "loading" ? (
        <div className="fp-loading" role="status">Loading…</div>
      ) : st.status === "ok" && st.objectUrl ? (
        <div className="fp-stage fp-checker">
          <img
            src={st.objectUrl}
            alt={label + ": " + path}
            draggable={false}
            onLoad={(e) => {
              const d = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
              setDims(d);
              onDims(d);
            }}
          />
        </div>
      ) : (
        <UnsupportedCard path={path} url={url} reason={st.status === "too_large" ? "too_large" : st.status === "missing" ? "missing" : "error"} size={st.status === "too_large" ? st.size : null} />
      )}
    </figure>
  );
}

/** Before/after image comparison. Either side may be absent (added / deleted). */
export function ImageCompare({ path, oldPath, oldUrl, newUrl }: { path: string; oldPath?: string; oldUrl: string | null; newUrl: string | null }) {
  const svg = kindFromExt(path) === "svg";
  const before = useImage(oldUrl, svg);
  const after = useImage(newUrl, svg);
  const [mode, setMode] = useState<Mode>("2up");
  const [pos, setPos] = useState(50);
  const [dims, setDims] = useState<{ old?: { w: number; h: number }; new?: { w: number; h: number } }>({});
  const both = !!oldUrl && !!newUrl;

  if (!both) {
    const st = oldUrl ? before : after;
    return (
      <div className="fp-compare" data-testid="fp-compare" data-mode="single">
        <div className="fp-bar">
          <span className="fp-grow" />
          <DownloadLink url={oldUrl || newUrl} name={(path.split("/").pop() || path)} />
        </div>
        <div className="fp-2up is-single">
          <Side label={oldUrl ? "Deleted" : "Added"} tone={oldUrl ? "del" : "add"} st={st} path={oldUrl ? oldPath || path : path} url={oldUrl || newUrl} onDims={() => {}} />
        </div>
      </div>
    );
  }

  const bSrc = before.status === "ok" ? before.objectUrl : null;
  const aSrc = after.status === "ok" ? after.objectUrl : null;
  const ready = !!bSrc && !!aSrc;
  // the overlay stage takes the larger of the two images' boxes
  const w = Math.max(dims.new?.w || 0, dims.old?.w || 0);
  const h = Math.max(dims.new?.h || 0, dims.old?.h || 0);
  const stageStyle: CSSProperties | undefined = w && h ? { aspectRatio: `${w} / ${h}`, width: `min(100%, ${w}px, calc(var(--fp-ov-maxh) * ${(w / h).toFixed(4)}))` } : undefined;

  return (
    <div className="fp-compare" data-testid="fp-compare" data-mode={mode}>
      <div className="fp-bar">
        <Segmented
          size="sm"
          label="Compare mode"
          value={mode}
          onChange={(k) => setMode(k as Mode)}
          items={[
            { key: "2up", label: "2-up" },
            { key: "swipe", label: "Swipe", disabled: !ready },
            { key: "onion", label: "Onion skin", disabled: !ready },
          ]}
        />
        <span className="fp-grow" />
        <DownloadLink url={oldUrl} name={"before-" + (path.split("/").pop() || path)}>Before</DownloadLink>
        <DownloadLink url={newUrl} name={path.split("/").pop() || path}>After</DownloadLink>
      </div>
      {mode === "2up" || !ready ? (
        <div className="fp-2up">
          <Side label="Before" tone="del" st={before} path={oldPath || path} url={oldUrl} onDims={(d) => setDims((x) => ({ ...x, old: d }))} />
          <Side label="After" tone="add" st={after} path={path} url={newUrl} onDims={(d) => setDims((x) => ({ ...x, new: d }))} />
        </div>
      ) : (
        <div className="fp-overlay-wrap">
          <div className="fp-overlay fp-checker" style={stageStyle} data-testid={"fp-" + mode}>
            <img className="fp-ov-img" src={bSrc!} alt={"Before: " + (oldPath || path)} draggable={false} />
            <img
              className="fp-ov-img fp-ov-top"
              src={aSrc!}
              alt={"After: " + path}
              draggable={false}
              style={mode === "onion" ? { opacity: pos / 100 } : { clipPath: `inset(0 0 0 ${pos}%)` }}
            />
            {mode === "swipe" ? <div className="fp-swipe-line" style={{ left: pos + "%" }} aria-hidden="true" /> : null}
          </div>
          <label className="fp-slider">
            <span className="fp-del">Before</span>
            <input
              type="range"
              min={0}
              max={100}
              value={pos}
              aria-label={mode === "onion" ? "After image opacity" : "Swipe position"}
              onChange={(e) => setPos(Number(e.target.value))}
            />
            <span className="fp-add">After</span>
          </label>
        </div>
      )}
    </div>
  );
}

/** The preview pane for one binary / media file in a diff. */
export function BinaryDiffView({ file, source }: { file: DiffFileRef; source?: BlobSource | null }) {
  const kind = kindFromExt(file.path);
  const added = file.status === "A" || file.status === "??";
  const deleted = file.status === "D";
  const oldUrl = source && !added ? source(file, "old") : null;
  const newUrl = source && !deleted ? source(file, "new") : null;
  const oldPath = file.old || file.path;

  if (!source || (!oldUrl && !newUrl)) {
    return (
      <div className="fp" data-testid="fp-binary-diff">
        <UnsupportedCard path={file.path} size={file.size} reason={kind && isRichKind(kind) ? "no_source" : "unsupported"} />
      </div>
    );
  }
  if (kind === "image" || kind === "svg") {
    return (
      <div className="fp" data-testid="fp-binary-diff">
        <ImageCompare path={file.path} oldPath={oldPath} oldUrl={oldUrl} newUrl={newUrl} />
      </div>
    );
  }
  if (kind && isRichKind(kind) && oldUrl && newUrl) {
    return (
      <div className="fp fp-stack" data-testid="fp-binary-diff">
        <div className="fp-side-l fp-del">Before</div>
        <FilePreview url={oldUrl} path={oldPath} kind={kind} />
        <div className="fp-side-l fp-add">After</div>
        <FilePreview url={newUrl} path={file.path} kind={kind} />
      </div>
    );
  }
  const url = newUrl || oldUrl;
  return (
    <div className="fp" data-testid="fp-binary-diff">
      {kind && isRichKind(kind) ? (
        <div className={"fp-side-l " + (deleted ? "fp-del" : "fp-add")}>{deleted ? "Deleted" : added ? "Added" : "After"}</div>
      ) : null}
      <FilePreview url={url} path={deleted ? oldPath : file.path} kind={kind ?? null} sizeHint={file.size} />
    </div>
  );
}
