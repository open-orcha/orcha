import { Copy } from "../map/kit/icons";
import { Button, Dialog, useToast } from "../map/kit";

/** Read-only text in a dialog with a copy action. */
export function TextDialog({
  open,
  onClose,
  title,
  description,
  text,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  text: string;
}) {
  const { toast } = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", variant: "success", duration: 2000 });
    } catch {
      toast({ title: "Could not copy", description: "Clipboard access was refused.", variant: "error" });
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} className="w-[760px] max-w-[95vw]">
      <div className="flex flex-col gap-2.5">
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-panel-2 p-3 font-mono text-xs leading-relaxed text-fg" data-markdown-text>
          {text}
        </pre>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={copy} data-copy-markdown>
            <Copy /> Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
