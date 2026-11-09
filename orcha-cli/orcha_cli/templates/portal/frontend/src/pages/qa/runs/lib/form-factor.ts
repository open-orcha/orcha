/**
 * Phone or tablet, from what a device record says it is, then from its name. Plain functions (no
 * "use client"), so server code (the live wall's data) and client code (`device-frame.ts`, the
 * device picker) read a device the same way.
 *
 * A simulator's record says what it is (#455): the worker reads each simulator's device type
 * (`simctl`'s `deviceTypeIdentifier`) and reports `family` ("iPhone"/"iPad") and `form_factor`
 * ("phone"/"tablet") with it, and a run's device record carries the `form_factor`. Its name is
 * whatever a person called it ("QA phone", "Team iPad"), so a name only decides for a
 * record that says neither (an Android AVD, an older worker's report).
 */

/** Phone or tablet: decides which family of bezel "Auto" draws for an iOS/Android run. */
export type FormFactor = "phone" | "tablet";

/** Device names that are tablets: every iPad (`simctl`: "iPad Pro 13-inch (M5)", "iPad Air
 * 11-inch (M3)", "iPad mini (A17 Pro)"), Samsung's Galaxy Tab line ("Galaxy Tab S9", cloud
 * catalogs' "Samsung Galaxy Tab S10+"), Google's Pixel Tablet / Pixel C / Nexus 7·9·10, and
 * any emulator or cloud device that says "tablet" ("Medium_Tablet_API_35", "Pixel_Tablet").
 * Underscores count as separators, since AVD names use them instead of spaces. */
const TABLET_NAME_PATTERNS: readonly RegExp[] = [
  /(^|[^a-z])ipad([^a-z]|$)/i,
  /tablet/i,
  /galaxy[\s_-]*tab([^a-z]|$)/i,
  /(^|[^a-z])pixel[\s_-]*c([^a-z0-9]|$)/i,
  /(^|[^a-z])nexus[\s_-]*(7|9|10)([^0-9]|$)/i,
];

export function isTabletDeviceName(name: string | null | undefined): boolean {
  if (!name) return false;
  return TABLET_NAME_PATTERNS.some((re) => re.test(name));
}

/** Phone names that must never read as a tablet, however square their capture: an iPhone
 * (even the Duo, whose capture is squarer than any other phone's) is a phone. */
export function isPhoneDeviceName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /(^|[^a-z])iphone([^a-z]|$)/i.test(name);
}

/** The form factor a device record says it is, when it says so: a simulator's `family`
 * ("iPhone"/"iPad", from its device type) and `form_factor`; `runs.device` /
 * `run_requests.device` / a cloud catalog entry may carry `form_factor`, `formFactor`,
 * `device_type` or `type` as "tablet"/"phone" (cloud providers report it this way). Null when
 * the record has no such field (an Android AVD, a record from before #455). */
export function formFactorFromRecord(record: unknown): FormFactor | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  for (const key of ["form_factor", "formFactor", "device_type", "deviceType", "type"]) {
    const v = r[key];
    if (typeof v !== "string") continue;
    const t = v.trim().toLowerCase();
    if (t === "tablet" || t === "pad") return "tablet";
    if (t === "phone" || t === "mobile" || t === "handset") return "phone";
  }
  if (r.family === "iPad") return "tablet";
  if (r.family === "iPhone") return "phone";
  return null;
}

/** A listed or recorded device's form factor: what its record says it is, else what its name
 * says, else null (nothing to go on). A renamed iPad ("Team review") is a tablet by its
 * `form_factor`; an iPhone someone called "Team iPad" is a phone by its. */
export function deviceFormFactor(device: { name?: string | null } | null | undefined): FormFactor | null {
  if (!device) return null;
  const recorded = formFactorFromRecord(device);
  if (recorded) return recorded;
  if (isPhoneDeviceName(device.name)) return "phone";
  if (isTabletDeviceName(device.name)) return "tablet";
  return null;
}

/** Whether a device is a tablet (`deviceFormFactor`); a device that says nothing is not. */
export function isTabletDevice(device: { name?: string | null } | null | undefined): boolean {
  return deviceFormFactor(device) === "tablet";
}
