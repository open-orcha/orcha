/**
 * Fetch a preview's bytes once, into a blob: URL the native element renders.
 * Reading through fetch (not a bare `<img src>`) lets the viewer check the
 * size BEFORE downloading (Content-Length / X-Orcha-Size vs the per-kind cap),
 * read the real Content-Type, sniff the first bytes, and pin the blob's type
 * (an SVG blob is always image/svg+xml, rendered only through <img>).
 */
import { useEffect, useState } from "react";

export type RawState =
  | { status: "loading" }
  | { status: "missing"; detail: string }
  | { status: "error"; detail: string }
  | { status: "too_large"; size: number | null }
  | { status: "ok"; objectUrl: string | null; size: number; mime: string; head: Uint8Array; text: string | null };

export interface RawOptions {
  /** Bytes past which nothing is downloaded (the size notice shows instead). */
  cap: number;
  /** Force the blob's type (e.g. image/svg+xml) — the server's type is used otherwise. */
  type?: string;
  /** Also decode the bytes as UTF-8 text (SVG source view) — only under this many bytes. */
  textUnder?: number;
  /** Only read the headers + first bytes (an unsupported file's size / sniff). */
  headOnly?: boolean;
}

async function detailOf(r: Response): Promise<string> {
  try {
    const d = (await r.json()) as { detail?: unknown };
    if (typeof d?.detail === "string") return d.detail;
  } catch {
    /* not JSON */
  }
  return "HTTP " + r.status;
}

function header(r: Response, name: string): string | null {
  try {
    return r.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

function sizeOf(r: Response): number | null {
  const h = header(r, "x-orcha-size") || header(r, "content-length");
  const n = h == null ? NaN : Number(h);
  return Number.isFinite(n) ? n : null;
}

export async function fetchRaw(url: string, opts: RawOptions, signal?: AbortSignal): Promise<RawState> {
  let r: Response;
  try {
    r = await fetch(url, { signal });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    return { status: "error", detail: "the file could not be loaded" };
  }
  if (r.status === 404 || r.status === 400) return { status: "missing", detail: await detailOf(r) };
  if (r.status === 413) return { status: "too_large", size: null };
  if (!r.ok) return { status: "error", detail: await detailOf(r) };
  const size = sizeOf(r);
  const mime = (header(r, "content-type") || "").split(";")[0].trim();
  if (size != null && size > opts.cap && !opts.headOnly) {
    try {
      await r.body?.cancel();
    } catch {
      /* already closed */
    }
    return { status: "too_large", size };
  }
  if (opts.headOnly) {
    let head = new Uint8Array();
    try {
      const reader = r.body?.getReader();
      const first = reader ? await reader.read() : null;
      head = first?.value ? first.value.slice(0, 64) : new Uint8Array();
      await reader?.cancel();
    } catch {
      /* best effort */
    }
    return { status: "ok", objectUrl: null, size: size ?? 0, mime, head, text: null };
  }
  let buf: Uint8Array<ArrayBuffer>;
  try {
    buf = new Uint8Array(await (await r.blob()).arrayBuffer());
  } catch {
    return { status: "error", detail: "the file could not be read" };
  }
  if (buf.length > opts.cap) return { status: "too_large", size: buf.length };
  const typed = new Blob([buf], { type: opts.type || mime || "application/octet-stream" });
  const text = opts.textUnder && buf.length <= opts.textUnder ? new TextDecoder().decode(buf) : null;
  const objectUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(typed) : null;
  return { status: "ok", objectUrl, size: buf.length, mime, head: buf.slice(0, 64), text };
}

export function useRawFile(url: string | null, opts: RawOptions): RawState {
  const [st, setSt] = useState<RawState>({ status: "loading" });
  const { cap, type, textUnder, headOnly } = opts;
  useEffect(() => {
    if (!url) {
      setSt({ status: "missing", detail: "no source for this file" });
      return;
    }
    const ac = new AbortController();
    let made: string | null = null;
    setSt({ status: "loading" });
    fetchRaw(url, { cap, type, textUnder, headOnly }, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) {
          if (res.status === "ok" && res.objectUrl) URL.revokeObjectURL(res.objectUrl);
          return;
        }
        if (res.status === "ok") made = res.objectUrl;
        setSt(res);
      })
      .catch(() => {
        /* aborted */
      });
    return () => {
      ac.abort();
      if (made && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(made);
    };
  }, [url, cap, type, textUnder, headOnly]);
  return st;
}
