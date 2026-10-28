/**
 * Menu-triggered dialogs (issue #350 §4.2): a workflow dialog keeps its own open state when
 * rendered standalone, and defers to the page when the header menu owns it. Logic inside each
 * dialog is unchanged; only who opens it moves.
 */
import { useState } from "react";

export interface DialogControl { open: boolean; onOpenChange: (open: boolean) => void }

export function useDialogOpen(control: DialogControl | undefined, initial = false): [boolean, (next: boolean) => void] {
  const [own, setOwn] = useState(initial);
  return [control ? control.open : own, (next) => { if (control) control.onOpenChange(next); else setOwn(next); }];
}
