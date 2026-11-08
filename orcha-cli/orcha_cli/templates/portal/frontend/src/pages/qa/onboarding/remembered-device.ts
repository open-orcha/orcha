import type { Platform } from "../qaApi";

/** The device picked for a project and platform, remembered in this browser ("" is Default). */
const pickKey = (cid: string, platform: Platform) => `orcha:qa:device:${cid}:${platform}`;

export function rememberedDevice(cid: string, platform: Platform): string {
  try {
    return window.localStorage.getItem(pickKey(cid, platform)) ?? "";
  } catch {
    return "";
  }
}

export function rememberDevice(cid: string, platform: Platform, key: string) {
  try {
    window.localStorage.setItem(pickKey(cid, platform), key);
  } catch {
    // A browser that keeps nothing asks again next time.
  }
}
