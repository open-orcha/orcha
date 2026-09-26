/**
 * A single-value debounce hook — used to trigger the repo browser's search
 * fetch 300ms after the user stops typing. No shared debounce utility exists
 * elsewhere in the frontend (checked: only per-page comments mentioning
 * debounced PUTs), so this is a small local primitive scoped to browse/**.
 */
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
