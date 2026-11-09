
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  /** Label for the affirmative button. Say what will happen ("Stop run"), not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get the danger button; everything else stays neutral. */
  destructive?: boolean;
}

type Resolver = (ok: boolean) => void;

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

/**
 * App-themed replacement for `window.confirm`.
 *
 * The native dialog is drawn by the browser, not by us: it says "localhost:3100 says", uses the
 * OS button order and colours, ignores the app's theme and design language entirely, and cannot
 * label its buttons — so a destructive action and a harmless one both read "OK". It also blocks
 * the main thread, which stalls the live-run subscriptions.
 *
 * `useConfirm()` returns a promise, so a call site reads almost exactly as it did before:
 *
 *     if (!(await confirm({ title: "Stop this run?" }))) return;
 *
 * One dialog instance lives at the provider, so opening a confirm never remounts the caller.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<Resolver | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  // Closing by any route (Esc, backdrop, Cancel) must settle the promise, or the caller waits
  // forever and its button stays disabled.
  const settle = useCallback((ok: boolean) => {
    setOptions(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Dialog
        open={options !== null}
        onClose={() => settle(false)}
        title={options?.title}
        description={options?.description}
        className="max-w-md"
        footer={
          <>
            <Button onClick={() => settle(false)} data-confirm-cancel>
              {options?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={options?.destructive ? "danger" : "primary"}
              onClick={() => settle(true)}
              data-confirm-accept
            >
              {options?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      />
    </ConfirmContext.Provider>
  );
}

/** `const confirm = useConfirm();` then `await confirm({ title: … })`. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return ctx;
}
