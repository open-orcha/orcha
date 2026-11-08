import { useState } from "react";
import { Button, Input } from "../../map/kit";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Flag, Globe, House, Undo2, X } from "../../map/kit/icons";
import { normalizeRecordingUrl, type Json, type RecordingCommandKind, type TargetKind } from "./recording";

const SWIPES = [
  { direction: "up", icon: ArrowUp },
  { direction: "down", icon: ArrowDown },
  { direction: "left", icon: ArrowLeft },
  { direction: "right", icon: ArrowRight },
] as const;

/** Everything besides tapping the screen: type, swipe, keys, long-press mode, hand back, stop. */
export function RecordingControls({
  kind,
  disabled,
  canCancel,
  longPress,
  onLongPressChange,
  onSend,
  onFinish,
  finishing,
  onCancel,
  cancelling,
}: {
  /** Web adds an address bar (`open_url`). */
  kind: TargetKind;
  disabled: boolean;
  /** Stopping the session stays available while it runs, also while handing back. */
  canCancel: boolean;
  longPress: boolean;
  onLongPressChange: (on: boolean) => void;
  onSend: (kind: RecordingCommandKind, args: Record<string, Json>) => Promise<boolean>;
  /** Gives the device back to the agent. */
  onFinish: () => void;
  finishing: boolean;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const [text, setText] = useState("");
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);

  async function type() {
    if (!text) return;
    if (await onSend("type", { text })) setText("");
  }

  async function go() {
    const parsed = normalizeRecordingUrl(address);
    if (!parsed.ok) {
      setAddressError(parsed.error);
      return;
    }
    setAddressError(null);
    if (await onSend("open_url", { url: parsed.url })) setAddress("");
  }

  return (
    <div className="flex flex-col gap-3" data-recording-controls>
      {kind === "web" ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <div className="flex items-center gap-1.5">
            <Input
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setAddressError(null);
              }}
              placeholder="Go to a URL"
              disabled={disabled}
              mono
              aria-label="Go to URL"
              aria-invalid={addressError ? true : undefined}
              data-recording-url
              data-dictation="off"
            />
            <Button type="submit" size="sm" disabled={disabled || !address.trim()} data-recording-go>
              <Globe /> Go
            </Button>
          </div>
          {addressError ? <p className="text-xs text-danger">{addressError}</p> : null}
        </form>
      ) : null}

      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void type();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Text to type into the focused field"
          disabled={disabled}
          aria-label="Text to type"
          data-recording-text
          data-dictation="off"
        />
        <Button type="submit" size="sm" disabled={disabled || !text} data-recording-type>
          Type
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-12 text-xs text-muted">Swipe</span>
        {SWIPES.map(({ direction, icon: Icon }) => (
          <Button
            key={direction}
            size="sm"
            icon
            aria-label={`Swipe ${direction}`}
            title={`Swipe ${direction}`}
            disabled={disabled}
            onClick={() => void onSend("swipe", { direction })}
          >
            <Icon />
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-12 text-xs text-muted">Keys</span>
        <Button size="sm" disabled={disabled} onClick={() => void onSend("press", { key: "back" })}>
          <Undo2 /> Back
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => void onSend("press", { key: "home" })}>
          <House /> Home
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => void onSend("press", { key: "enter" })}>
          <CornerDownLeft /> Enter
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={longPress}
          disabled={disabled}
          onChange={(e) => onLongPressChange(e.target.checked)}
          data-recording-long-press
        />
        Long press instead of tap
      </label>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        <Button variant="primary" size="sm" loading={finishing} disabled={disabled} onClick={onFinish} data-recording-finish>
          <Flag /> Hand back
        </Button>
        <Button variant="danger" size="sm" loading={cancelling} disabled={!canCancel} onClick={onCancel} data-recording-cancel>
          <X /> Stop session
        </Button>
      </div>
    </div>
  );
}
