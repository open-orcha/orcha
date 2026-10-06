/**
 * Settings → Execution › Review (mig 057): where an agent's finished work goes
 * for verification, and whether AI managers pre-review it first.
 *
 *   Finished work goes to   Manager chain · Project owner · Anyone
 *   AI managers pre-review  switch (advisory — a person still verifies)
 *
 * Reads the snapshot container (review_route / ai_manager_prereview); writes
 * PUT /api/containers/{cid}/review-routing {review_route?, ai_manager_prereview?,
 * actor_agent_id}. The server gate is owner-or-assign_reviewers (deciding who
 * reviews is exactly that permission); without it the controls are disabled
 * and say why. Older backends that don't send the fields render nothing.
 */
import { useState } from "react";
import { sendJSON } from "../../api/client";
import { useToast } from "../../components/ui";
import { Segmented, Tooltip } from "../../components/primitives";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Container } from "../../types";
import { useGrantAuthority } from "./grantAuthority";
import { SettingRow, settingsErrText } from "./settingsUi";
import "./reviewRouting.css";

type Route = NonNullable<Container["review_route"]>;

export const REVIEW_ROUTE_LABEL: Record<Route, string> = {
  manager_chain: "Manager chain",
  owner: "Project owner",
  anyone: "Anyone",
};

/** The row's description line (pure, tested). */
export function reviewRouteDesc(route: Route, reportingLines: number): string {
  if (route === "manager_chain") {
    return reportingLines
      ? "The assignee’s nearest human manager on the org chart verifies. Agents without a manager: anyone may."
      : "The assignee’s nearest human manager verifies — set reporting lines on the Org chart. Until then, anyone may.";
  }
  if (route === "owner") return "The project owner verifies all finished work.";
  return "No reviewer is assigned automatically — any member may verify.";
}

export function ReviewRoutingRow({ cid }: { cid: string | null }) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const auth = useGrantAuthority("assign_reviewers");
  const c = snap?.container ?? null;
  const [busy, setBusy] = useState(false);
  // optimistic value while the write + snapshot refresh are in flight
  const [pending, setPending] = useState<{ route?: Route; pre?: boolean } | null>(null);

  if (!c || c.review_route == null) return null; // older backend: nothing honest to show
  const route: Route = pending?.route ?? c.review_route;
  const pre = pending?.pre ?? c.ai_manager_prereview !== false;
  const locked = !auth.can;
  const lines = (snap?.agents || []).filter((a) => a.reports_to != null).length;

  const save = async (patch: { review_route?: Route; ai_manager_prereview?: boolean }, done: string) => {
    if (!cid || busy || locked || !auth.human) return;
    setBusy(true);
    setPending({ route: patch.review_route, pre: patch.ai_manager_prereview });
    try {
      await sendJSON("PUT", "/api/containers/" + encodeURIComponent(cid) + "/review-routing", {
        ...patch,
        actor_agent_id: auth.human.id,
      });
      await refresh();
      toast(done, "ok");
    } catch (e) {
      toast("Couldn't change review routing — " + settingsErrText(e) + ".", "danger");
    }
    setPending(null);
    setBusy(false);
  };

  const seg = (
    <Segmented
      size="sm"
      label="Finished work goes to"
      value={route}
      className="set-review-route"
      items={(Object.keys(REVIEW_ROUTE_LABEL) as Route[]).map((k) => ({
        key: k,
        label: REVIEW_ROUTE_LABEL[k],
        disabled: locked || busy,
      }))}
      onChange={(k) => {
        if (k !== route) void save({ review_route: k as Route }, "Finished work now goes to: " + REVIEW_ROUTE_LABEL[k as Route] + ".");
      }}
    />
  );
  const sw = (
    <button
      type="button"
      className={"set-switch" + (pre ? " on" : "") + (locked || route !== "manager_chain" ? " is-locked" : "")}
      role="switch"
      id="setPrereviewSwitch"
      aria-checked={pre}
      aria-labelledby="setPrereviewL"
      aria-describedby="setPrereviewD"
      aria-busy={busy || undefined}
      aria-disabled={locked || undefined}
      disabled={busy}
      onClick={() => {
        if (locked) return;
        void save({ ai_manager_prereview: !pre }, pre ? "AI managers no longer pre-review." : "AI managers now pre-review before a person verifies.");
      }}
    >
      <span className="set-switch-knob" />
    </button>
  );
  const why = locked && auth.reason && !auth.pending ? auth.reason : null;
  return (
    <>
      <SettingRow
        label="Finished work goes to"
        id="setReviewRouteL"
        className="set-review-row"
        desc={
          <span id="setReviewRouteD">
            {reviewRouteDesc(route, lines)}
            {why ? <> · <span data-testid="review-route-reason">{why}</span></> : null}
          </span>
        }
      >
        {locked && auth.reason ? <Tooltip label={auth.reason} placement="left">{seg}</Tooltip> : seg}
      </SettingRow>
      <SettingRow
        label="AI managers pre-review"
        id="setPrereviewL"
        desc={
          <span id="setPrereviewD">
            {route === "manager_chain"
              ? "When an AI manager sits between the assignee and the person who verifies, it reviews first and recommends approve or send back. A person still verifies."
              : "Applies only when finished work goes to the manager chain."}
          </span>
        }
      >
        {locked && auth.reason ? <Tooltip label={auth.reason} placement="left">{sw}</Tooltip> : sw}
      </SettingRow>
    </>
  );
}
