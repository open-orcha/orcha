/**
 * Test-data seeds on a scenario (`scenarios.seed`, migration 034, `orcha.scenarios.seeds`): one line per
 * seed, the text after a scenario file's `Seed:`. The Python side is the authority; this mirrors
 * its shape check so a typo is caught when the scenario is saved, not when a run is blocked.
 *
 * - `POST /api/orders {"item": "Blue mug"}`: an HTTP call against the environment's api_base.
 * - `fixture orders`: `seeds/orders.json`, applied by the environment's `seed.command` or
 *   `seed.endpoint` data variable.
 * - `storage {"orders": [...]}` / `cookies {"sid": "abc"}`: web only, set in the browser before
 *   the first screen.
 *
 * Owned data (#191): `… as truck` names what an HTTP or fixture seed made, so later lines say
 * `{{truck.id}}`; `Cleanup:` lines (`scenarios.cleanup`) are HTTP calls run after the scenario.
 */

export const MAX_SEEDS = 10;
export const MAX_SEED_LENGTH = 16384;
export const MAX_CLEANUP = 10;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const FIXTURE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const PLACEHOLDER_RE = /\{\{\s*[A-Za-z_][A-Za-z0-9_ .-]*?\s*\}\}/g;
const BIND_RE = /\s+as\s+([A-Za-z_][A-Za-z0-9_]{0,31})\s*$/;

/** Split the editor's textarea into seed lines, dropping blank ones. */
export function seedsFromText(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function seedsToText(seeds: readonly string[] | null | undefined): string {
  return (seeds ?? []).join("\n");
}

function jsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "invalid JSON";
  }
}

/** Why one seed line is not a seed, or null when it is. `{{name}}` placeholders validate as 0. */
export function seedLineError(line: string): string | null {
  let text = line.trim().replace(PLACEHOLDER_RE, "0");
  if (!text) return "Empty seed.";
  const bind = BIND_RE.exec(text);
  if (bind) {
    text = text.slice(0, bind.index).trimEnd();
    const first = text.split(" ")[0]?.toLowerCase();
    if (first === "storage" || first === "cookies") return `"${line.trim()}": ${first} seeds make nothing to name; drop "as ${bind[1]}".`;
  }
  if (text.length > MAX_SEED_LENGTH) return `A seed is at most ${MAX_SEED_LENGTH} characters.`;
  const space = text.indexOf(" ");
  const word = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? "" : text.slice(space + 1).trim();
  const lowered = word.toLowerCase();
  if (lowered === "fixture") {
    return FIXTURE_NAME_RE.test(rest)
      ? null
      : `"${line.trim()}": the fixture name takes letters, digits, '.', '_' or '-' (a file seeds/<name>.json).`;
  }
  if (lowered === "storage" || lowered === "cookies") {
    if (!rest) return `"${line.trim()}": ${lowered} needs a JSON object.`;
    const err = jsonError(rest);
    if (err) return `"${line.trim()}": ${lowered} is not valid JSON (${err}).`;
    const value: unknown = JSON.parse(rest);
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) {
      return `"${line.trim()}": ${lowered} needs a non-empty JSON object.`;
    }
    return null;
  }
  if (HTTP_METHODS.includes(word.toUpperCase())) {
    const sp = rest.indexOf(" ");
    const path = sp === -1 ? rest : rest.slice(0, sp);
    const body = sp === -1 ? "" : rest.slice(sp + 1).trim();
    if (!path || !(path.startsWith("/") || /^https?:\/\//.test(path))) {
      return `"${line.trim()}": ${word.toUpperCase()} needs a path starting with / (or a full http(s) URL).`;
    }
    if (body) {
      const err = jsonError(body);
      if (err) return `"${line.trim()}": the request body is not valid JSON (${err}).`;
    }
    return null;
  }
  return `"${line.trim().slice(0, 40)}" must start with GET, POST, PUT, PATCH, DELETE, fixture, storage or cookies.`;
}

/** First problem with the textarea's lines, or null when every line is a seed. */
export function seedsError(text: string): string | null {
  const lines = seedsFromText(text);
  if (lines.length > MAX_SEEDS) return `At most ${MAX_SEEDS} seeds.`;
  for (const line of lines) {
    const error = seedLineError(line);
    if (error) return error;
  }
  return null;
}

export type SeedValidation = { ok: true; seed: string[] | null } | { ok: false; error: string };

/** Validate a PATCH body's `seed` (a list of lines, a textarea string, or null). */
export function validateSeeds(raw: unknown): SeedValidation {
  if (raw === null) return { ok: true, seed: null };
  let lines: string[];
  if (typeof raw === "string") lines = seedsFromText(raw);
  else if (Array.isArray(raw) && raw.every((l) => typeof l === "string")) lines = seedsFromText(raw.join("\n"));
  else return { ok: false, error: "seed must be a list of lines." };
  const error = seedsError(lines.join("\n"));
  if (error) return { ok: false, error: `seed: ${error}` };
  return { ok: true, seed: lines.length ? lines : null };
}

/** The names seeds give their records (`… as truck` gives `truck`), in order. */
export function seedNames(lines: readonly string[]): string[] {
  return lines.map((l) => BIND_RE.exec(l.trim())?.[1]).filter((n): n is string => Boolean(n));
}

/** Why a cleanup line is not one (`DELETE /api/products/{{product.id}}`): HTTP calls only. */
export function cleanupLineError(line: string): string | null {
  const t = line.trim();
  if (BIND_RE.test(t)) return `"${t}": cleanup lines do not name a record.`;
  const word = t.split(" ")[0]?.toUpperCase() ?? "";
  if (!HTTP_METHODS.includes(word)) return `"${t.slice(0, 40)}": a cleanup line is an HTTP call, e.g. DELETE /api/products/{{product.id}}.`;
  return seedLineError(t);
}

export function cleanupError(text: string): string | null {
  const lines = seedsFromText(text);
  if (lines.length > MAX_CLEANUP) return `At most ${MAX_CLEANUP} cleanup lines.`;
  for (const line of lines) {
    const error = cleanupLineError(line);
    if (error) return error;
  }
  return null;
}

export type CleanupValidation = { ok: true; cleanup: string[] | null } | { ok: false; error: string };

/** Validate a PATCH body's `cleanup` (a list of lines, a textarea string, or null). */
export function validateCleanup(raw: unknown): CleanupValidation {
  if (raw === null) return { ok: true, cleanup: null };
  let lines: string[];
  if (typeof raw === "string") lines = seedsFromText(raw);
  else if (Array.isArray(raw) && raw.every((l) => typeof l === "string")) lines = seedsFromText(raw.join("\n"));
  else return { ok: false, error: "cleanup must be a list of lines." };
  const error = cleanupError(lines.join("\n"));
  if (error) return { ok: false, error: `cleanup: ${error}` };
  return { ok: true, cleanup: lines.length ? lines : null };
}
