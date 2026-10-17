/**
 * Model display names — ONE source for turning a model id into the name users
 * see (screen review r3: Onboarding showed "Claude Opus 5.5" while Metrics
 * showed the raw "claude-opus-5-5", the same fact in two forms).
 *
 * GET /api/models is the catalog ({models: [{id, name?, ...}], default}); the
 * catalog's `name` wins, otherwise prettyModelId() derives a readable form.
 * Display only: the raw id is what gets saved and belongs in a tooltip.
 *
 * useModelCatalog() fetches the catalog ONCE per page (single-flighted module
 * cache — the list is global, not per project) so every surface that shows a
 * model name can call it without adding a request per mount.
 */
import { useEffect, useState } from "react";
import { getJSON } from "../api/client";
import { registerTestReset } from "./testResets";

export interface ModelInfo { id: string; name?: string }

/** /api/models rows → {id, name?}. Tolerates bare string ids (older servers). */
export function normalizeModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelInfo[] = [];
  for (const m of raw) {
    if (typeof m === "string" && m) out.push({ id: m });
    else if (m && typeof m === "object" && typeof (m as ModelInfo).id === "string" && (m as ModelInfo).id) {
      const n = (m as ModelInfo).name;
      out.push({ id: (m as ModelInfo).id, name: typeof n === "string" && n ? n : undefined });
    }
  }
  return out;
}

/** Readable name for a model id the catalog doesn't name: "claude-opus-5-5" →
 *  "Opus 5.5", "claude-sonnet" → "Sonnet", "gpt-5" → "GPT-5". Display only —
 *  the raw id stays in the tooltip and is what gets saved. */
export function prettyModelId(id: string): string {
  const s = String(id || "").trim();
  if (!s) return s;
  const low = s.toLowerCase();
  const gpt = /^gpt-(.+)$/.exec(low);
  if (gpt) return "GPT-" + gpt[1].split("-").map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(" ").replace(/ (\d)/g, "-$1");
  const parts = low.replace(/^(claude|anthropic)-/, "").split("-").filter((p) => p && !/^\d{8}$/.test(p));
  const words: string[] = [];
  let nums: string[] = [];
  const flush = () => { if (nums.length) { words.push(nums.join(".")); nums = []; } };
  for (const p of parts) {
    if (/^\d+$/.test(p)) nums.push(p);
    else { flush(); words.push(/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)); }
  }
  flush();
  return words.join(" ") || s;
}

/** The catalog's display name for a model id, else a readable form of the id. */
export function modelLabel(id: string | null | undefined, models: ModelInfo[]): string {
  if (!id) return "";
  const m = models.find((x) => x.id === id);
  return (m && m.name) || prettyModelId(id);
}

/** Best-effort provider for a model id — only used to GROUP pickers. */
export function modelProvider(id: string): string {
  const s = String(id || "").toLowerCase();
  if (/^(claude|anthropic)/.test(s)) return "Anthropic";
  if (/^(gpt|o\d|codex|openai|chatgpt)/.test(s)) return "OpenAI";
  if (/^(grok|xai)/.test(s)) return "xAI";
  if (/^(gemini|google)/.test(s)) return "Google";
  if (/^(llama|meta)/.test(s)) return "Meta";
  if (/^(mistral|codestral)/.test(s)) return "Mistral";
  return "Other";
}

/** Group models by provider, keeping the server's order (first appearance). */
export function groupModels<T extends { id: string }>(models: T[]): { provider: string; models: T[] }[] {
  const out: { provider: string; models: T[] }[] = [];
  for (const m of models) {
    const p = modelProvider(m.id);
    let g = out.find((x) => x.provider === p);
    if (!g) { g = { provider: p, models: [] }; out.push(g); }
    g.models.push(m);
  }
  return out;
}

/* ---- the shared catalog --------------------------------------------------- */
export interface ModelCatalog {
  models: ModelInfo[];
  /** the server's default model id, when it names one */
  defaultId: string | null;
  /** false until the catalog answered (or failed — then it stays empty) */
  loaded: boolean;
}
const EMPTY: ModelCatalog = { models: [], defaultId: null, loaded: false };

let _catalog: Promise<ModelCatalog> | null = null;
let _resolved: ModelCatalog | null = null;

/** GET /api/models once per page. A failure resolves to an empty, loaded
 *  catalog (every label falls back to prettyModelId) and is NOT cached, so a
 *  later mount retries. */
export function fetchModelCatalog(): Promise<ModelCatalog> {
  if (!_catalog) {
    const p: Promise<ModelCatalog> = getJSON<{ models?: unknown; default?: unknown }>("/api/models")
      .then((d) => {
        const cat: ModelCatalog = {
          models: normalizeModels(d && d.models),
          defaultId: d && typeof d.default === "string" && d.default ? d.default : null,
          loaded: true,
        };
        _resolved = cat;
        return cat;
      })
      .catch((): ModelCatalog => {
        if (_catalog === p) _catalog = null; // retry on the next ask
        return { models: [], defaultId: null, loaded: true };
      });
    _catalog = p;
  }
  return _catalog;
}

export function resetModelCatalog(): void {
  _catalog = null;
  _resolved = null;
}
registerTestReset(resetModelCatalog);

/** The shared /api/models catalog for display (names, grouping). */
export function useModelCatalog(): ModelCatalog {
  const [cat, setCat] = useState<ModelCatalog>(() => _resolved ?? EMPTY);
  useEffect(() => {
    let live = true;
    fetchModelCatalog().then((c) => { if (live) setCat(c); });
    return () => { live = false; };
  }, []);
  return cat;
}

/** A display-name resolver bound to the shared catalog:
 *    const name = useModelName(); name("claude-opus-5-5") → "Claude Opus 5.5"
 *  Before the catalog answers it already returns the readable fallback, so
 *  a raw id never flashes. Keep the raw id in the element's title. */
export function useModelName(): (id: string | null | undefined) => string {
  const { models } = useModelCatalog();
  return (id) => modelLabel(id, models);
}
