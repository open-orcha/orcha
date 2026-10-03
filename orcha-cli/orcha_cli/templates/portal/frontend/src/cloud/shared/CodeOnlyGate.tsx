/**
 * codeOnly(key, Page) — the route guard for the code-only project sections (/code,
 * /github). In General mode their tabs are hidden (lib/projectMode.ts); a direct URL or
 * an old bookmark must not open a working code page either (general-mode U04). It
 * renders a calm notice pointing at Settings › Work type instead. Nothing is unbound:
 * switching back to Code shows the real page again, intact.
 *
 * Until the project's mode is read it shows a quiet skeleton, not the code page, so a
 * General project never flashes the Code UI. If the mode can't be read at all (an older
 * server without /project-profile), it falls back to the page — Code is the default.
 */
import type { ComponentType } from "react";
import { ButtonLink, EmptyState, Skeleton } from "../../components/primitives";
import { isSectionHidden, useProjectMode } from "../../lib/projectMode";
import { withCid } from "../../lib/scope";
import { Shell } from "../../shell/Shell";
import { useSnapshot } from "../../state/SnapshotProvider";

type CodeOnlyKey = "code" | "github";
const TITLE: Record<CodeOnlyKey, string> = { code: "Code Space", github: "GitHub" };
const NOUN: Record<CodeOnlyKey, string> = { code: "Code", github: "GitHub" };

export function CodeOnlyNotice({ section, cid }: { section: CodeOnlyKey; cid: string | null }) {
  return (
    <Shell page={section} title={TITLE[section]}>
      <div className="mx-empty" id="generalModeGate" data-section={section}>
        <EmptyState
          icon="info"
          title="This project is in General mode"
          body={<>Switch to Code mode in Settings to use {NOUN[section]}. Nothing was removed — the repository and its
            history come back as they were.</>}
          action={<ButtonLink variant="secondary" size="sm" href={(cid ? withCid("/settings", cid) : "/settings") + "#tab=general"}>
            Open Work type settings</ButtonLink>}
        />
      </div>
    </Shell>
  );
}

export function codeOnly(section: CodeOnlyKey, Page: ComponentType): ComponentType {
  function CodeOnlyRoute() {
    const { cid } = useSnapshot();
    const pm = useProjectMode(cid);
    if (cid && !pm.known && !pm.error) {
      return <Shell page={section} title={TITLE[section]}><Skeleton lines={3} label="Loading" /></Shell>;
    }
    if (pm.known && isSectionHidden(section, pm.mode)) return <CodeOnlyNotice section={section} cid={cid ?? null} />;
    return <Page />;
  }
  CodeOnlyRoute.displayName = "CodeOnly(" + section + ")";
  return CodeOnlyRoute;
}
