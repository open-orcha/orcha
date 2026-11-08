import { useEffect, useState } from "react";

/** Now, ticking once a second while `on`. The phase bar itself is the shared `WorkPhaseBar`
 * (`components/work`). */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
