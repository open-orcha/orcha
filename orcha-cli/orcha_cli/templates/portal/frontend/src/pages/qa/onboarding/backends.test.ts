import { describe, expect, it } from "vitest";
import { backendFor, backendHost, backendTone, buildWords, detectedBackends, liveBackendLine, runBuild, targetBackend, type DetectedBackends } from "./backends";
import { parseOnboardingMap, type FoundBackend } from "./contract";

/** What `found.read_folder` answers for a repository shaped like FleetMate (fake project id). */
const LOCAL: FoundBackend = {
  platforms: ["ios", "android"],
  service: "Supabase",
  url: "http://127.0.0.1:54321",
  source: "apps/mobile/.env",
  variable: "EXPO_PUBLIC_SUPABASE_URL",
  build: "checkout",
  production: false,
};
const PROD: FoundBackend = { ...LOCAL, url: "https://abcdefghijklmnopqrst.supabase.co", source: "apps/mobile/eas.json", build: "release", production: true };
const WEB: FoundBackend = { ...LOCAL, platforms: ["web"], source: "apps/web/.env.local", variable: "NEXT_PUBLIC_SUPABASE_URL" };
const detected: DetectedBackends = { for: "/repo\0apps/mobile", list: [LOCAL, PROD, WEB], unknown: {} };

describe("backends in the contract (#453)", () => {
  it("parses each backend and the platforms whose backend cannot be told, dropping what is malformed", () => {
    const m = parseOnboardingMap({
      project_id: "new",
      found: {
        backends: [LOCAL, PROD, { platforms: ["tv"], url: "http://x" }, { platforms: ["ios"], url: "not a url" }, { ...WEB, build: "nightly", production: "yes" }],
        backend_unknown: { ios: "It reads EXPO_PUBLIC_API_URL, but no value for it is in the repository", desktop: "x", android: 3 },
      },
    })!;
    expect(m.found.backends).toEqual([LOCAL, PROD, { ...WEB, build: "any", production: false }]);
    expect(m.found.backend_unknown).toEqual({ ios: "It reads EXPO_PUBLIC_API_URL, but no value for it is in the repository" });
    expect(parseOnboardingMap({ project_id: "new", found: {} })!.found.backends).toBeUndefined();
  });

  it("keeps the live run's stage and its words", () => {
    const m = parseOnboardingMap({
      project_id: "p",
      live_run: { request_id: "r1", status: "running", depth: "overview", targets: 4, reached: 0, stage: "building", stage_note: "Compiling the Expo app" },
    })!;
    expect(m.live_run).toMatchObject({ stage: "building", stage_note: "Compiling the Expo app" });
    expect(parseOnboardingMap({ project_id: "p", live_run: { request_id: "r1", stage: "dancing" } })!.live_run?.stage).toBeUndefined();
  });
});

describe("which backend a platform's runs reach", () => {
  it("a phone built from the checkout reaches the checkout's; one someone adds (or none) the release's", () => {
    expect(runBuild("ios", "repo")).toBe("checkout");
    expect(runBuild("android", "upload")).toBe("release");
    expect(runBuild("android", "path")).toBe("release");
    // A web app on this Mac is the checkout's dev server; a deployed one is the release.
    expect(runBuild("web", "path", "http://localhost:3000")).toBe("checkout");
    expect(runBuild("web", "path", "https://app.truckline.io")).toBe("release");
    expect(targetBackend(detected, { kind: "ios", locator: "com.truckline.app", build: { source: "repo" } })).toBe(LOCAL);
    expect(targetBackend(detected, { kind: "android", locator: "com.truckline.app", build: { source: "upload" } })).toBe(PROD);
    expect(targetBackend(detected, { kind: "web", locator: "http://localhost:3000", build: { source: "path" } })).toBe(WEB);
  });

  it("falls back to what every build uses, and never guesses one build from the other", () => {
    const any: FoundBackend = { ...LOCAL, url: "https://api.truckline.io", build: "any", production: true };
    expect(backendFor({ list: [any] }, "ios", "release")).toBe(any);
    expect(backendFor({ list: [LOCAL] }, "android", "release")).toBeNull();
    expect(backendFor({ list: [PROD] }, "ios", "checkout")).toBeNull();
    expect(backendFor(null, "ios", "checkout")).toBeNull();
  });

  it("reads as Production, Local or Not production, with the host only", () => {
    expect(backendTone(PROD)).toBe("production");
    expect(backendTone(LOCAL)).toBe("local");
    expect(backendTone({ url: "https://api.staging.truckline.io", production: false })).toBe("hosted");
    expect(backendHost(PROD.url)).toBe("abcdefghijklmnopqrst.supabase.co");
    expect(buildWords(PROD)).toBe("Release builds (an APK or IPA you add)");
    expect(buildWords({ ...WEB, build: "release" })).toBe("The deployed site");
    expect(buildWords(WEB)).toBe("The dev server from this checkout");
  });

  it("the Map step says when the pass would reach production, or cannot tell, before it starts", () => {
    expect(liveBackendLine(detected, "android", PROD)).toEqual({
      tone: "production",
      text: "This build talks to Supabase at abcdefghijklmnopqrst.supabase.co, a production system: the pass is read-only.",
    });
    expect(liveBackendLine(detected, "ios", LOCAL)).toBeNull();
    const unknown = { ...detected, unknown: { ios: "It reads EXPO_PUBLIC_API_URL, but no value for it is in the repository" } };
    expect(liveBackendLine(unknown, "ios", null)?.text).toBe(
      "Embodent could not tell which backend this build talks to (it reads EXPO_PUBLIC_API_URL, but no value for it is in the repository). If it could be production, check the environment before you start.",
    );
    expect(liveBackendLine(detected, "web", null)).toBeNull();
    expect(detectedBackends("k", { backends: [LOCAL] })).toEqual({ for: "k", list: [LOCAL], unknown: {} });
  });
});
