import type { CSSProperties, ReactNode } from "react";
import { cn } from "./ui";
import styles from "./onboarding-map.module.css";

const d = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

/** Files light up and fly onto screens, which turn solid and covered: the map in one loop. */
function MapScene() {
  const files = [26, 44, 62, 80];
  const screens = [
    { x: 196, y: 14 },
    { x: 246, y: 14 },
    { x: 196, y: 70 },
    { x: 246, y: 70 },
  ];
  return (
    <svg viewBox="0 0 300 130" className={styles.scene} aria-hidden>
      <text x="8" y="12" className={styles.sceneDim}>
        Your code
      </text>
      {files.map((y, i) => (
        <rect key={y} x="8" y={y} width={i % 2 ? 62 : 78} height="7" rx="2" className={styles.sceneFile} style={d(i * 1200)} />
      ))}
      {files.map((y, i) => {
        const s = screens[i];
        return <path key={`c${y}`} d={`M90 ${y + 3.5} C 140 ${y + 3.5}, 150 ${s.y + 24}, ${s.x - 4} ${s.y + 24}`} className={styles.sceneCurve} style={d(i * 1200)} />;
      })}
      {screens.map((s, i) => (
        <rect key={`${s.x}-${s.y}`} x={s.x} y={s.y} width="40" height="50" rx="6" className={styles.sceneScreen} style={d(i * 1200)} />
      ))}
    </svg>
  );
}

/** Tiles fill with the three coverage colours. */
function CoverageScene() {
  const tones = ["yours", "none", "yours", "qa", "none", "yours", "qa", "yours", "none", "qa"];
  return (
    <svg viewBox="0 0 300 120" className={styles.scene} aria-hidden>
      {tones.map((t, i) => (
        <rect key={i} x={20 + (i % 5) * 54} y={14 + Math.floor(i / 5) * 54} width="42" height="44" rx="6" className={styles.sceneTile} data-tone={t} style={d(i * 220)} />
      ))}
    </svg>
  );
}

/** A test file becomes a scenario that points back at it. */
function BringInScene() {
  return (
    <svg viewBox="0 0 300 110" className={styles.scene} aria-hidden>
      <rect x="10" y="22" width="110" height="64" rx="7" fill="var(--s-tile)" stroke="var(--s-line)" />
      <text x="20" y="40" className={styles.sceneInk}>
        CheckoutUITests.swift
      </text>
      {[52, 62, 72].map((y, i) => (
        <rect key={y} x="20" y={y} width={i === 1 ? 60 : 84} height="5" rx="2" fill="var(--s-line)" />
      ))}
      <g className={styles.sceneMove}>
        <rect x="24" y="30" width="86" height="48" rx="7" fill="var(--s-tile)" stroke="var(--s-qa)" strokeWidth="1.5" />
        <text x="34" y="48" className={styles.sceneInk}>
          Pay for an order
        </text>
        <text x="34" y="64" className={styles.sceneDim}>
          points to line 42
        </text>
      </g>
      <path d="M128 54 L170 54" stroke="var(--s-line)" strokeDasharray="3 3" />
    </svg>
  );
}

/** A phone runs one test and a check lands. */
function FirstRunScene() {
  return (
    <svg viewBox="0 0 300 130" className={styles.scene} aria-hidden>
      <rect x="120" y="6" width="62" height="118" rx="12" fill="var(--s-tile)" stroke="var(--s-line)" strokeWidth="1.5" />
      <rect x="132" y="24" width="38" height="6" rx="2" fill="var(--s-line)" />
      <rect x="132" y="36" width="30" height="6" rx="2" fill="var(--s-line)" />
      <rect x="132" y="94" width="38" height="12" rx="6" fill="var(--s-qa)" opacity=".8" />
      <circle cx="151" cy="66" r="14" fill="none" stroke="var(--s-line)" />
      <path d="M144 66 L149 71 L158 61" className={styles.sceneCheck} />
    </svg>
  );
}

const SCENES = { map: MapScene, coverage: CoverageScene, bring_in: BringInScene, first_run: FirstRunScene };

/**
 * A teaching empty state: the scene that shows what the step does, a title and a line, and
 * (optionally) the action that starts it. Every new onboarding screen has one.
 */
export function TeachingState({
  scene,
  title,
  children,
  action,
  className,
  live = false,
}: {
  scene: keyof typeof SCENES;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** A waiting state (the scene is the in-progress view): announced as status. */
  live?: boolean;
}) {
  const Scene = SCENES[scene];
  return (
    <div
      className={cn("flex flex-col items-center gap-3 px-6 py-8 text-center", className)}
      role={live ? "status" : undefined}
      data-onboarding-teach={scene}
    >
      <Scene />
      <div className="max-w-md">
        <p className="text-sm font-semibold text-fg">{title}</p>
        {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}
