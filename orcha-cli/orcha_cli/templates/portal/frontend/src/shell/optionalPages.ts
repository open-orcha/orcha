/**
 * Optional V2 pages owned by other agents (D: Needs you, E: Activity).
 * Detected with a LAZY glob, so this module never imports them (no cycles, and
 * the build stays green before they land). Until a page exists its route is
 * not registered (the URL falls through to the Overview fallback) and shell
 * links point at the pre-V2 destination instead of a dead route:
 *   Needs you → "/" (the Overview action queue), Activity → "/agents" (the old "Run feed").
 */
import type { ComponentType } from "react";

type PageModule<K extends string> = Record<K, ComponentType>;

const needs = import.meta.glob<PageModule<"NeedsPage">>("../pages/needs/NeedsPage.tsx");
const activity = import.meta.glob<PageModule<"ActivityPage">>("../pages/activity/ActivityPage.tsx");

export const loadNeedsPage: (() => Promise<PageModule<"NeedsPage">>) | null = Object.values(needs)[0] ?? null;
export const loadActivityPage: (() => Promise<PageModule<"ActivityPage">>) | null = Object.values(activity)[0] ?? null;

export const HAS_NEEDS_PAGE = loadNeedsPage != null;
export const HAS_ACTIVITY_PAGE = loadActivityPage != null;

export const NEEDS_HREF = HAS_NEEDS_PAGE ? "/needs" : "/";
export const ACTIVITY_HREF = HAS_ACTIVITY_PAGE ? "/activity" : "/agents";
