/**
 * FilePreview — one non-text file rendered with the browser's own engines:
 * images (checkerboard, fit / actual size, dimensions), SVG (as an image on a
 * typed blob URL — never inline markup — with a Source toggle), PDF (the
 * built-in viewer, or an Open / Download card where there is none), video and
 * audio (native players, streamed), fonts (a FontFace specimen). Everything
 * else is a "Preview not supported" card with the size and a Download link —
 * binary bytes are never shown as text.
 *
 * The kind comes from lib/filePreview (extension, then the response's MIME and
 * a byte sniff for unknown extensions). Bytes come from a portal `/raw` route.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { Segmented } from "../primitives";
import {
  detectKind,
  formatBytes,
  extOf,
  kindFromExt,
  PREVIEW_CAP_BYTES,
  withDownload,
  type PreviewKind,
} from "../../lib/filePreview";
import { useRawFile } from "./useRawFile";
import "./filePreview.css";

/* ---- shared bits ---------------------------------------------------------- */

export function DownloadLink({ url, name, children }: { url: string | null | undefined; name: string; children?: ReactNode }) {
  if (!url) return null;
  return (
    <a className="v2-btn v2-btn-secondary v2-btn-sm fp-dl" href={withDownload(url)} download={name}>
      <span className="v2-btn-label">{children ?? "Download"}</span>
    </a>
  );
}

function baseName(path: string): string {
  return (path || "").split("/").pop() || path;
}

/** The "Preview not supported" card (also the too-large / missing notices). */
export function UnsupportedCard({
  path,
  size,
  url,
  reason,
}: {
  path: string;
  size?: number | null;
  url?: string | null;
  reason?: "unsupported" | "too_large" | "missing" | "error" | "no_source";
}) {
  const ext = extOf(path);
  const sz = size != null ? formatBytes(size) : "";
  const r = reason || "unsupported";
  const head =
    r === "too_large"
      ? "Too large to preview"
      : r === "missing"
        ? "This version isn't available"
        : r === "error"
          ? "Preview failed to load"
          : r === "no_source"
            ? "Binary file"
            : ext
              ? `Preview not supported for .${ext} files`
              : "Preview not supported for this file";
  return (
    <div className="fp-card" data-testid="fp-unsupported" data-reason={r}>
      <svg className="fp-card-ico" viewBox="0 0 20 20" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
        <path d="M5 2.75h6.5L15.25 6.5v10a.75.75 0 0 1-.75.75h-9.5a.75.75 0 0 1-.75-.75V3.5A.75.75 0 0 1 5 2.75Z" />
        <path d="M11.25 2.75V6.75h4" />
      </svg>
      <span className="fp-card-t">{head}</span>
      {sz ? <span className="fp-card-m">· {sz}</span> : null}
      {r === "no_source" ? <span className="fp-card-m">· no preview here</span> : null}
      <span className="fp-grow" />
      {r !== "missing" ? <DownloadLink url={url} name={baseName(path)} /> : null}
    </div>
  );
}

function Loading({ what = "preview" }: { what?: string }) {
  return (
    <div className="fp-loading" role="status" aria-busy="true">
      Loading {what}…
    </div>
  );
}

/* ---- images --------------------------------------------------------------- */

type Fit = "fit" | "actual";

/** One image on the checkerboard with Fit / Actual size and its dimensions. */
export function ImageView({
  src,
  path,
  size,
  url,
  toolbarExtra,
  alt,
}: {
  src: string;
  path: string;
  alt?: string;
  size?: number | null;
  url?: string | null;
  toolbarExtra?: ReactNode;
}) {
  const [fit, setFit] = useState<Fit>("fit");
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  if (broken) return <UnsupportedCard path={path} size={size} url={url} reason="error" />;
  return (
    <div className="fp-image" data-testid="fp-image">
      <div className="fp-bar">
        <Segmented
          size="sm"
          label="Image zoom"
          value={fit}
          onChange={(k) => setFit(k as Fit)}
          items={[
            { key: "fit", label: "Fit" },
            { key: "actual", label: "Actual size" },
          ]}
        />
        {toolbarExtra}
        <span className="fp-grow" />
        <span className="fp-meta" data-testid="fp-meta">
          {[dims ? `${dims.w} × ${dims.h}` : null, size != null ? formatBytes(size) : null].filter(Boolean).join(" · ")}
        </span>
        <DownloadLink url={url} name={baseName(path)} />
      </div>
      <div className={"fp-stage fp-checker" + (fit === "actual" ? " is-actual" : "")}>
        <img
          src={src}
          alt={alt ?? baseName(path)}
          draggable={false}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setBroken(true)}
        />
      </div>
    </div>
  );
}

function RasterPreview({ url, path, sizeHint }: { url: string; path: string; sizeHint?: number | null }) {
  const st = useRawFile(url, { cap: PREVIEW_CAP_BYTES.image });
  if (st.status === "loading") return <Loading what="image" />;
  if (st.status !== "ok") return <StateCard st={st} path={path} url={url} sizeHint={sizeHint} />;
  if (!st.objectUrl) return <UnsupportedCard path={path} size={st.size} url={url} reason="error" />;
  return <ImageView src={st.objectUrl} path={path} size={st.size} url={url} />;
}

function StateCard({ st, path, url, sizeHint }: { st: Exclude<ReturnType<typeof useRawFile>, { status: "ok" } | { status: "loading" }>; path: string; url: string | null; sizeHint?: number | null }) {
  if (st.status === "too_large") return <UnsupportedCard path={path} size={st.size ?? sizeHint} url={url} reason="too_large" />;
  if (st.status === "missing") return <UnsupportedCard path={path} size={sizeHint} url={url} reason="missing" />;
  return <UnsupportedCard path={path} size={sizeHint} url={url} reason="error" />;
}

/* ---- SVG ------------------------------------------------------------------ */

function SvgPreview({ url, path, sourceView }: { url: string; path: string; sourceView?: ReactNode }) {
  // typed blob: an SVG renders ONLY through <img> (no script, no same-origin DOM)
  const st = useRawFile(url, { cap: PREVIEW_CAP_BYTES.svg, type: "image/svg+xml", textUnder: 1024 * 1024 });
  const [mode, setMode] = useState<"image" | "source">("image");
  if (st.status === "loading") return <Loading what="image" />;
  if (st.status !== "ok") return <StateCard st={st} path={path} url={url} />;
  const toggle = (
    <Segmented
      size="sm"
      label="SVG view"
      value={mode}
      onChange={(k) => setMode(k as "image" | "source")}
      items={[
        { key: "image", label: "Image" },
        { key: "source", label: "Source" },
      ]}
    />
  );
  if (mode === "source") {
    return (
      <div className="fp-image" data-testid="fp-svg-source">
        <div className="fp-bar">
          {toggle}
          <span className="fp-grow" />
          <span className="fp-meta">{formatBytes(st.size)}</span>
        </div>
        {sourceView ?? <pre className="fp-source mono">{st.text ?? "Source too large to show — download it instead."}</pre>}
      </div>
    );
  }
  if (!st.objectUrl) return <UnsupportedCard path={path} size={st.size} url={url} reason="error" />;
  return <ImageView src={st.objectUrl} path={path} size={st.size} url={url} toolbarExtra={toggle} />;
}

/* ---- PDF ------------------------------------------------------------------ */

export function pdfViewerAvailable(): boolean {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { pdfViewerEnabled?: boolean }) : null;
  return !!nav && nav.pdfViewerEnabled !== false;
}

export function PdfPreview({ url, path, size }: { url: string; path: string; size?: number | null }) {
  const name = baseName(path);
  if (!pdfViewerAvailable()) {
    return (
      <div className="fp-card" data-testid="fp-pdf-card">
        <span className="fp-card-t">PDF</span>
        {size != null ? <span className="fp-card-m">· {formatBytes(size)}</span> : null}
        <span className="fp-card-m">· this view can't show PDFs inline</span>
        <span className="fp-grow" />
        <a className="v2-btn v2-btn-ghost v2-btn-sm" href={url} target="_blank" rel="noopener noreferrer">
          <span className="v2-btn-label">Open</span>
        </a>
        <DownloadLink url={url} name={name} />
      </div>
    );
  }
  return (
    <div className="fp-pdf" data-testid="fp-pdf">
      <div className="fp-bar">
        <span className="fp-meta">PDF{size != null ? " · " + formatBytes(size) : ""}</span>
        <span className="fp-grow" />
        <a className="v2-btn v2-btn-ghost v2-btn-sm" href={url} target="_blank" rel="noopener noreferrer">
          <span className="v2-btn-label">Open</span>
        </a>
        <DownloadLink url={url} name={name} />
      </div>
      <iframe className="fp-pdf-frame" src={url} title={name} />
    </div>
  );
}

/* ---- video / audio -------------------------------------------------------- */

export function MediaPreview({ url, path, kind }: { url: string; path: string; kind: "video" | "audio" }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <UnsupportedCard path={path} url={url} reason="error" />;
  return (
    <div className={"fp-media fp-" + kind} data-testid={"fp-" + kind}>
      {kind === "video" ? (
        // streamed by the native player (Range requests) — never buffered whole
        <video src={url} controls preload="metadata" onError={() => setFailed(true)} aria-label={baseName(path)} />
      ) : (
        <audio src={url} controls preload="metadata" onError={() => setFailed(true)} aria-label={baseName(path)} />
      )}
      <div className="fp-bar">
        <span className="fp-meta">{extOf(path).toUpperCase() || kind}</span>
        <span className="fp-grow" />
        <DownloadLink url={url} name={baseName(path)} />
      </div>
    </div>
  );
}

/* ---- fonts ---------------------------------------------------------------- */

const SPECIMEN = "The quick brown fox jumps over the lazy dog";

function FontPreview({ url, path }: { url: string; path: string }) {
  const st = useRawFile(url, { cap: PREVIEW_CAP_BYTES.font });
  const fam = "orcha-fp-" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [ready, setReady] = useState<"wait" | "ok" | "fail">("wait");
  useEffect(() => {
    if (st.status !== "ok" || !st.objectUrl) return;
    const FF = (globalThis as { FontFace?: typeof FontFace }).FontFace;
    if (!FF || typeof document === "undefined" || !document.fonts) {
      setReady("fail");
      return;
    }
    let face: FontFace | null = null;
    let live = true;
    try {
      face = new FF(fam, `url(${st.objectUrl})`);
      face
        .load()
        .then((f) => {
          if (!live) return;
          document.fonts.add(f);
          setReady("ok");
        })
        .catch(() => live && setReady("fail"));
    } catch {
      setReady("fail");
    }
    return () => {
      live = false;
      if (face) document.fonts.delete(face);
    };
  }, [st, fam]);
  if (st.status === "loading") return <Loading what="font" />;
  if (st.status !== "ok") return <StateCard st={st} path={path} url={url} />;
  if (ready === "fail") return <UnsupportedCard path={path} size={st.size} url={url} />;
  if (ready === "wait") return <Loading what="font" />;
  return (
    <div className="fp-font" data-testid="fp-font" style={{ fontFamily: `"${fam}", sans-serif` }}>
      <div className="fp-font-xl">Aa Bb Cc 0123</div>
      <div className="fp-font-l">{SPECIMEN}</div>
      <div className="fp-font-m">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !?&amp;@#</div>
      <div className="fp-bar">
        <span className="fp-meta">{extOf(path).toUpperCase()} · {formatBytes(st.size)}</span>
        <span className="fp-grow" />
        <DownloadLink url={url} name={baseName(path)} />
      </div>
    </div>
  );
}

/* ---- unknown / binary ----------------------------------------------------- */

/** Reads only the headers + first bytes, then decides: a rich kind the sniff
 *  proved, the caller's text view, or the unsupported card with the size. */
function ProbePreview({ url, path, sizeHint, sourceView, knownBinary }: { url: string; path: string; sizeHint?: number | null; sourceView?: ReactNode; knownBinary?: boolean }) {
  const st = useRawFile(url, { cap: Infinity, headOnly: true });
  if (st.status === "loading") return <Loading />;
  if (st.status !== "ok") return <StateCard st={st} path={path} url={url} sizeHint={sizeHint} />;
  const k = knownBinary ? "binary" : detectKind({ path, mime: st.mime, bytes: st.head });
  if (k === "text" && sourceView) return <>{sourceView}</>;
  if (k !== "text" && k !== "binary") return <PreviewByKind kind={k} url={url} path={path} sizeHint={st.size} sourceView={sourceView} />;
  return <UnsupportedCard path={path} size={st.size || sizeHint} url={url} />;
}

function PreviewByKind({ kind, url, path, sizeHint, sourceView }: { kind: PreviewKind; url: string; path: string; sizeHint?: number | null; sourceView?: ReactNode }) {
  switch (kind) {
    case "image":
      return <RasterPreview url={url} path={path} sizeHint={sizeHint} />;
    case "svg":
      return <SvgPreview url={url} path={path} sourceView={sourceView} />;
    case "pdf":
      return <PdfPreview url={url} path={path} size={sizeHint} />;
    case "video":
    case "audio":
      return <MediaPreview url={url} path={path} kind={kind} />;
    case "font":
      return <FontPreview url={url} path={path} />;
    case "binary":
      return <ProbePreview url={url} path={path} sizeHint={sizeHint} knownBinary />;
    default:
      return <ProbePreview url={url} path={path} sizeHint={sizeHint} sourceView={sourceView} />;
  }
}

export interface FilePreviewProps {
  /** A portal `/raw` URL for the bytes (null: nothing to fetch — card only). */
  url: string | null;
  path: string;
  /** Override the extension-derived kind (e.g. "binary" for a file the server flagged). */
  kind?: PreviewKind | null;
  sizeHint?: number | null;
  /** The code view, for SVG's Source toggle / an unknown file that sniffs as text. */
  sourceView?: ReactNode;
}

export function FilePreview({ url, path, kind, sizeHint, sourceView }: FilePreviewProps) {
  const k = kind ?? kindFromExt(path);
  if (!url) return <UnsupportedCard path={path} size={sizeHint} reason="no_source" />;
  return (
    <div className="fp" data-kind={k || "unknown"}>
      <PreviewByKind kind={k || "text"} url={url} path={path} sizeHint={sizeHint} sourceView={sourceView} />
    </div>
  );
}
