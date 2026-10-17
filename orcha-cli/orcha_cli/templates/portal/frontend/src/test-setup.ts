import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { runTestResets } from "./lib/testResets";

// Async queries (findBy*/waitFor) get 3 s instead of 1 s: the full suite runs
// many jsdom files in parallel, and a loaded machine used to time out waits
// that pass in isolation (identity + snapshot settle on separate ticks).
configure({ asyncUtilTimeout: 3000 });

// Reset module-level singletons (/api/me cache, acting identity/auth slots,
// optimistic attention marks) after every test — see lib/testResets.ts.
afterEach(() => runTestResets());
