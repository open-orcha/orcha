/**
 * Code Space — fetch wrappers over code_space_routes.py's Phase 3 symbol
 * provider CONTRACT (see symbolsTypes.ts's module doc):
 *
 *   GET /api/containers/{cid}/code/symbols?ref=&q=
 *   GET /api/containers/{cid}/code/outline?ref=&path=
 *
 * Both routes return `{available:false, reason, detail}` as an ORDINARY 200
 * body for the not-connected/rate-limited/generic-error cases (never a
 * thrown HTTPException) — so success/degrade is decided by `body.available`,
 * not `r.ok`. A non-2xx transport failure (network blip, unexpected 5xx) is
 * still routed through the SAME GhError ladder the rest of the GitHub-backed
 * surfaces use (classifyError), so callers can render through the existing
 * BrowseErrorBody component in either case.
 */
import { classifyError, type GhError } from "../../github/ghlib";
import type { OutlinePayload, SymbolReason, SymbolSearchPayload, SymbolUnavailable } from "./symbolsTypes";

export type SymbolsResult<T> = { ok: true; data: T } | { ok: false; error: GhError };

// `reason` -> GhError.kind, mirroring BrowseErrorBody's cases exactly (a
// not_found reason has no dedicated code-space case today but is mapped
// faithfully in case a future backend revision emits it here).
function reasonToErrorKind(reason: SymbolReason): GhError["kind"] {
  if (reason === "repo_not_connected") return "not_connected";
  if (reason === "rate_limited") return "rate_limited";
  if (reason === "not_found") return "not_found";
  return "error";
}

function unavailableToError(body: SymbolUnavailable): GhError {
  return { kind: reasonToErrorKind(body.reason), detail: body.detail ?? null };
}

async function doFetch<T extends { available: true }>(url: string): Promise<SymbolsResult<T>> {
  try {
    const r = await fetch(url);
    const body = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: classifyError(r.status, body) };
    if (body && body.available === false) return { ok: false, error: unavailableToError(body as SymbolUnavailable) };
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, error: { kind: "error", status: 0, detail: (e as Error).message } };
  }
}

function codePrefix(cid: string): string {
  return "/api/containers/" + encodeURIComponent(cid) + "/code";
}

export function fetchSymbolSearch(
  cid: string,
  opts: { ref?: string; q?: string } = {},
): Promise<SymbolsResult<SymbolSearchPayload>> {
  const q = new URLSearchParams();
  if (opts.ref) q.set("ref", opts.ref);
  if (opts.q != null) q.set("q", opts.q);
  const qs = q.toString();
  return doFetch<SymbolSearchPayload>(codePrefix(cid) + "/symbols" + (qs ? "?" + qs : ""));
}

export function fetchOutline(
  cid: string,
  opts: { ref?: string; path: string },
): Promise<SymbolsResult<OutlinePayload>> {
  const q = new URLSearchParams({ path: opts.path });
  if (opts.ref) q.set("ref", opts.ref);
  return doFetch<OutlinePayload>(codePrefix(cid) + "/outline?" + q.toString());
}
