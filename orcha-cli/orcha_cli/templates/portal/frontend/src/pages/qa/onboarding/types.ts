/** The few shared types the onboarding port needs (the shared types, narrowed to Orcha's platforms). */
export type TargetKind = "ios" | "android" | "web";

/** A device the person named for a run: the simulator / emulator name, or the web viewport. */
export type RunDevice =
  | { kind: "ios"; name: string }
  | { kind: "android"; name: string }
  | { kind: "web"; viewport: string };

/** A device this machine can run on now (`GET C/devices`), or a browser size. */
export interface DeviceHolder { project?: string; kind?: string }

/** What a phone needs before it can run: a short title, then the fix in plain words. */
export interface DeviceSetup { code?: string; title: string; fix: string }

/** A phone this Mac knows: `connection` null when it is not connected now. */
export interface PhoneFacts {
  physical?: boolean;
  model?: string | null;
  os?: string | null;
  connection?: string | null;
  ready?: boolean;
  setup?: DeviceSetup | null;
}

export type WorkerDevice =
  | ({ kind: "ios"; name: string; udid: string; runtime?: string | null; state?: string | null; held_by?: DeviceHolder | null } & PhoneFacts)
  | ({ kind: "android"; name: string; serial?: string | null; state?: string | null; held_by?: DeviceHolder | null } & PhoneFacts)
  | { kind: "web"; name: string; viewport: string; size: string };

export type BuildSource = "repo" | "path" | "url" | "upload";
