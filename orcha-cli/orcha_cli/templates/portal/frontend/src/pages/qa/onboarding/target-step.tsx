import { Folder, GitBranch, Plus } from "../map/kit/icons";
import { Button, Chip, Field, Input, PlatformIcon, PLATFORM_TITLES, Select, Switch, cn } from "./ui";
import type { BuildSource, TargetKind } from "./types";
import { newManualTarget, type BuildState, type SetField, type WizardState, type WizardTarget } from "./state";

const KIND_LABEL: Record<TargetKind, string> = { ios: "iOS", web: "Web", android: "Android" };

const buildPathPlaceholder = (kind: TargetKind) => (kind === "ios" ? "/path/to/App.app" : "/path/to/app-debug.apk");

/** A repository on this Mac is built where it is (uncommitted work included); a git URL is
 * cloned by the worker first (#454: the copy said "checks out" for a local folder). */
export function localCheckout(repo: string): boolean {
  const v = repo.trim();
  return v.startsWith("/") || v.startsWith("~");
}

function RepoBuildWhere({ repo, subdir }: { repo: string; subdir: string }) {
  const at = subdir ? (
    <>
      {" "}
      at <span className="font-mono text-fg">{subdir}</span>
    </>
  ) : null;
  return localCheckout(repo) ? (
    <>
      Embodent reads your local checkout (<span className="font-mono text-fg">{repo}</span>
      {at}), uncommitted work included. It
    </>
  ) : (
    <>
      Embodent reads <span className="font-mono text-fg">{repo}</span>
      {at}. It
    </>
  );
}

function BuildBlock({
  target,
  state,
  setBuild,
}: {
  target: WizardTarget;
  state: WizardState;
  setBuild: (patch: Partial<BuildState>) => void;
}) {
  const kind = target.kind;
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-border bg-panel-2 p-3">
      <h3 className="text-sm font-medium text-fg">
        Build <span className="font-normal text-muted">(optional)</span>
      </h3>
      <Select
        aria-label="Build source"
        value={target.build.source}
        onChange={(e) => setBuild({ source: e.target.value as BuildSource })}
        options={[
          ...(state.repoUrl.trim() ? [{ value: "repo", label: "Build from the repository", icon: <GitBranch /> }] : []),
          { value: "path", label: "Local path", icon: <Folder /> },
        ]}
      />
      {target.build.source === "repo" ? (
        <p className="text-xs text-muted" data-onboarding-build-repo={localCheckout(state.repoUrl) ? "local" : "clone"}>
          <RepoBuildWhere repo={state.repoUrl.trim()} subdir={target.subdir} />
          <>
            {" "}does not compile anything: a run opens the {kind === "ios" ? "simulator build" : "debug APK"} already installed on the device, so install the build you want tested first.
          </>
        </p>
      ) : (
        <Input mono value={target.build.path} onChange={(e) => setBuild({ path: e.target.value })} placeholder={buildPathPlaceholder(kind)} data-dictation="off" />
      )}
    </div>
  );
}

function TargetCard({
  target,
  state,
  onChange,
  onRemove,
  removable,
}: {
  target: WizardTarget;
  state: WizardState;
  onChange: (patch: Partial<WizardTarget>) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  function setBuild(patch: Partial<BuildState>) {
    onChange({ build: { ...target.build, ...patch } });
  }
  function setKind(next: TargetKind) {
    onChange({
      kind: next,
      locator: next === "web" ? "http://localhost:3000" : "",
      isDefault: false,
    });
  }
  const folder = target.subdir || target.appName || "";
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-panel p-3.5 transition-opacity",
        !target.enabled && "opacity-60",
      )}
      data-target-card={target.key}
      data-target-platform={target.kind}
      data-target-enabled={target.enabled || undefined}
    >
      {/* The platform header: what this card tests, in its own words and mark. */}
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-2 text-fg"
        >
          <PlatformIcon kind={target.kind} className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-fg" data-target-title>
              {PLATFORM_TITLES[target.kind]}
            </h3>
            {target.stack ? (
              <Chip size="sm" title={`Detected framework: ${target.stack}`} data-target-stack>
                {target.stack}
              </Chip>
            ) : null}
          </div>
          {folder ? (
            <span className="truncate font-mono text-xs text-muted" title={folder} data-target-folder>
              {folder}
            </span>
          ) : (
            <span className="text-xs text-muted">
              {target.kind === "web" ? "A site by URL" : "An app by its id"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {removable ? (
            <Button size="sm" variant="ghost" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
          <Switch
            checked={target.enabled}
            onCheckedChange={(on) => onChange({ enabled: on })}
            aria-label={`Test the ${PLATFORM_TITLES[target.kind]}`}
            title={target.enabled ? "Included" : "Left out"}
            data-target-enable
          />
        </div>
      </div>

      {/* A card the scan did not detect picks its platform here; a detected one is fixed. */}
      {!target.detected ? (
        <div
          role="radiogroup"
          aria-label="Platform"
          className="inline-flex h-8 gap-0.5 self-start rounded-md border border-border bg-panel-2 p-0.5"
        >
          {(["web", "ios", "android"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={target.kind === k}
              data-target-kind={k}
              onClick={() => setKind(k)}
              className={cn(
                "flex items-center gap-1.5 rounded-[4px] px-3 text-sm font-medium transition-colors",
                target.kind === k
                  ? "bg-raised text-fg shadow-sm"
                  : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <PlatformIcon kind={k} className="size-3.5" />
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      ) : null}

      <Field
        label={
          target.kind === "web"
            ? "URL"
            : target.kind === "ios"
              ? "Bundle id"
              : "Package"
        }
        // The folder is in the header already; name the file only when it says more.
        hint={target.from && target.from !== target.subdir ? `From ${target.from}` : undefined}
      >
        {/* More than one plausible id was found for this platform (e.g. a multi-app
            workspace with both an iOS and a macOS project): a combobox lists every candidate,
            picked bundle id first, while still allowing a custom value — a native `<input
            list>` needs no extra dependency and degrades to a plain text field everywhere. */}
        {target.candidates && target.candidates.length > 1 ? (
          <datalist id={`${target.key}-candidates`}>
            {target.candidates.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        ) : null}
        <Input
          mono
          type={target.kind === "web" ? "url" : "text"}
          value={target.locator}
          onChange={(e) =>
            onChange({ locator: e.target.value, isDefault: false })
          }
          placeholder={
            target.kind === "web"
              ? "http://localhost:3000"
              : "com.example.app"
          }
          list={
            target.candidates && target.candidates.length > 1
              ? `${target.key}-candidates`
              : undefined
          }
          data-onboarding-locator
          data-dictation="off"
        />
      </Field>

      {target.kind !== "web" ? (
        <BuildBlock target={target} state={state} setBuild={setBuild} />
      ) : null}
    </div>
  );
}

// Step 2 (Platforms) ------------------------------------------------------

export function TargetStep({
  state,
  set,
}: {
  state: WizardState;
  set: SetField;
}) {
  function updateTarget(key: string, patch: Partial<WizardTarget>) {
    set(
      "targets",
      state.targets.map((t) => (t.key === key ? { ...t, ...patch } : t)),
    );
  }
  function removeTarget(key: string) {
    set("targets", state.targets.filter((t) => t.key !== key));
  }
  function addTarget() {
    // One target per platform: start the new card on the first platform not yet added.
    const used = new Set(state.targets.map((t) => t.kind));
    const next = (["web", "ios", "android"] as const).find((k) => !used.has(k)) ?? "web";
    set("targets", [...state.targets, newManualTarget(next)]);
  }

  return (
    <div className="flex flex-col gap-3">
      {state.targets.map((target) => (
        <TargetCard
          key={target.key}
          target={target}
          state={state}
          onChange={(patch) => updateTarget(target.key, patch)}
          onRemove={() => removeTarget(target.key)}
          removable={state.targets.length > 1}
        />
      ))}
      <Button onClick={addTarget} data-add-target className="self-start">
        <Plus /> Add platform
      </Button>
    </div>
  );
}
