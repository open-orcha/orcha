/**
 * Object URL for a stored frame. A frame's "path" here is its `qa_frames` id, and the portal serves
 * it at a stable URL, so there is no signing step: `signPath` keeps its name and shape so
 * `FrameCanvas` and `Replay` read as they do in the source.
 */
import { frameUrl } from "../../qaApi";

export function urlFor(path: string): string {
  return frameUrl(path);
}

const cache = new Map<string, Promise<string>>();

/** Resolve a frame id to its URL. Never rejects. */
export function signPath(path: string): Promise<string> {
  const hit = cache.get(path);
  if (hit) return hit;
  const p = Promise.resolve(urlFor(path));
  cache.set(path, p);
  return p;
}

/** The URL is a pure function of the id, so there is nothing to forget. */
export function forgetSignedUrl(_path: string): void {
  // Nothing to forget.
}

/** Warm the cache for a list of frame ids. */
export function prefetchSignedUrls(paths: readonly string[]): void {
  for (const p of paths) void signPath(p);
}

export interface SignedUrlState {
  url: string | null;
  error: string | null;
  loading: boolean;
  onError: () => void;
}

/** URL for a frame id: a plain derived value, computed fresh on every render. */
export function useSignedUrl(path: string | null | undefined): SignedUrlState {
  return {
    url: path ? urlFor(path) : null,
    error: null,
    loading: false,
    onError: () => {
      // A 404 here means the frame is gone; there is nothing to retry.
    },
  };
}
