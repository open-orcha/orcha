import type { ReactNode } from "react";
import { Button } from "../map/kit";
import { Dialog } from "../map/kit";

/**
 * Confirm-destructive-action dialog (native `<dialog>`, not `window.confirm`
 * — spec requirement). Controlled: pass `open`, `onConfirm`, `onClose`.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  loading = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      className="max-w-sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={loading} onClick={onConfirm} data-confirm-delete>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
