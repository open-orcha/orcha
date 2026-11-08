import { Check, CircleDashed, Hourglass, Lock, MinusCircle, Footprints, RotateCcw, X } from "../../map/kit/icons";
import { ScreenThumb } from "../screen-thumb";
import { urlFor } from "../frames";
import { FLOW_STATUS_LABEL, type FlowPill, type ReasonTone } from "./workflows";
import { cn } from "../../map/kit";
import styles from "./workflows.module.css";

type AnyStatus = FlowPill;

const STATUS_STYLE: Record<AnyStatus, { cls: string; Icon: typeof Check }> = {
  queued: { cls: "border-border text-muted", Icon: CircleDashed },
  walking: { cls: "border-primary/40 bg-primary/10 text-primary dark:text-chart-1", Icon: Footprints },
  passed: { cls: "border-success/35 bg-success/10 text-success", Icon: Check },
  failed: { cls: "border-danger/35 bg-danger/10 text-danger", Icon: X },
  unreachable: { cls: "border-warning/35 bg-warning/10 text-warning", Icon: Lock },
  skipped: { cls: "border-border text-muted", Icon: MinusCircle },
  abandoned: { cls: "border-border text-muted", Icon: MinusCircle },
  cut_off: { cls: "border-warning/35 bg-warning/10 text-warning", Icon: Hourglass },
  requeued: { cls: "border-border text-fg-2", Icon: RotateCcw },
};

/** A flow's or a walk's status: an icon and a word, never colour alone. */
export function StatusPill({ status, className }: { status: AnyStatus; className?: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.queued;
  return (
    <span
      className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium", s.cls, className)}
      data-flow-status={status}
    >
      <s.Icon aria-hidden className={cn("size-3", status === "walking" && styles.dotLive)} strokeWidth={2.25} />
      {FLOW_STATUS_LABEL[status] ?? status}
    </span>
  );
}

const TONE: Record<ReasonTone, string> = {
  new: "bg-primary/10 text-primary dark:text-chart-1",
  fail: "bg-danger/10 text-danger",
  critical: "bg-sev-major/12 text-sev-major",
  changed: "bg-chart-3/12 text-chart-3 dark:text-warning",
  plain: "bg-panel-2 text-fg-2",
};

/** Why a flow is where it is in the queue ("Never walked", "Critical", "Changed 3 days ago"). */
export function ReasonChip({ label, tone }: { label: string; tone: ReasonTone }) {
  return (
    <span className={cn("inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[11px] font-medium leading-none", TONE[tone])} data-rank-reason={tone}>
      {label}
    </span>
  );
}

const isPhone = (kind: string | null | undefined) => kind === "ios" || kind === "android" || kind == null;

/**
 * A step's frame as a small print that opens full size: phone-shaped for iOS and Android,
 * window-shaped for web and desktop. A missing frame keeps the slot as a quiet placeholder.
 */
export function FrameThumb({
  frame,
  kind,
  label,
  size = "sm",
  className,
}: {
  frame: string | null;
  kind: string | null | undefined;
  label: string;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const phone = isPhone(kind);
  const w = phone ? { xs: "w-[30px]", sm: "w-[44px]", md: "w-[72px]" }[size] : { xs: "w-[52px]", sm: "w-[84px]", md: "w-[132px]" }[size];
  const radius = phone ? { xs: "rounded-[5px]", sm: "rounded-[7px]", md: "rounded-[10px]" }[size] : "rounded-[5px]";
  const aspect = phone ? "aspect-[402/874]" : "aspect-[16/10]";
  if (!frame) {
    return <span aria-hidden className={cn("block shrink-0 border border-dashed border-border bg-panel-2", w, aspect, radius, className)} />;
  }
  return (
    <ScreenThumb
      src={urlFor(frame)}
      label={label}
      className={cn("shrink-0", w, radius, styles.develop, className)}
      imgClassName={cn("w-full bg-panel-2 shadow-[var(--shadow-sm)]", aspect, radius)}
      dataAttrs={{ "data-walk-frame": frame }}
    />
  );
}
