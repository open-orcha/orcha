import { Copy } from "../../map/kit/icons";
import { Button, type ButtonProps } from "../../map/kit";
import { useToast } from "../../map/kit";

/** `text` plus a `## Runtime logs` section when `logs` is non-empty — the "why"
 * (console error, failed request, device crash) travels with the fix prompt into the coding
 * agent's context. */
function withLogs(text: string, logs: readonly string[]): string {
  if (logs.length === 0) return text;
  return `${text.trimEnd()}\n\n## Runtime logs\n${logs.join("\n")}`;
}

/** Copies the finding's fix prompt (plus any correlated runtime logs) to the clipboard and
 * toasts "Copied". */
export function CopyFixPromptButton({
  text,
  logs = [],
  variant = "primary",
  size = "sm",
  children,
  ...rest
}: { text: string | null; logs?: readonly string[] } & Omit<ButtonProps, "onClick">) {
  const { toast } = useToast();
  return (
    <Button
      variant={variant}
      size={size}
      disabled={!text}
      title={text ? "Copy fix prompt" : "No fix prompt for this finding"}
      onClick={async () => {
        if (!text) return;
        try {
          await navigator.clipboard.writeText(withLogs(text, logs));
          toast({ title: "Copied", variant: "success", duration: 2000 });
        } catch (err) {
          toast({
            title: "Copy failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "error",
          });
        }
      }}
      {...rest}
    >
      <Copy />
      {children ?? "Copy fix prompt"}
    </Button>
  );
}
