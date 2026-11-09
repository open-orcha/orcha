/** Tolerant readers for this folder's server shapes: null and missing fields never reach the screen. */
export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
export const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
export const listOf = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const numberOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
