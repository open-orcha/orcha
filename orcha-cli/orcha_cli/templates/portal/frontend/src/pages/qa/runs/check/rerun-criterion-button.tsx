import { RotateCw } from "../../map/kit/icons";
import { Button, type ButtonProps } from "../../map/kit";

/** Re-run: opens Run check for a check on this platform. A run starts as a task a person can see. */
export function RerunCriterionButton({
  scenarioId,
  onRerun,
  variant = "default",
  size = "sm",
  children,
  ...rest
}: {
  scenarioId: string;
  onRerun: () => void;
} & Omit<ButtonProps, "onClick">) {
  return (
    <Button variant={variant} size={size} data-rerun-criterion={scenarioId} onClick={onRerun} {...rest}>
      <RotateCw /> {children ?? "Re-run"}
    </Button>
  );
}
