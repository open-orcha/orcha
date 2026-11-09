/**
 * Run a check, as a page (`?view=run`): pick what to run, then only what that kind needs with the
 * defaults already chosen, then Start, which lands on the live run. `kind`, `platform`, `focus` and
 * `scenarios` deep-link; `from` is where Back goes. `pass` is an onboarding pass still waiting for
 * its agent (PendingRun).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import { qaAuthority } from "../authority";
import { ArrowLeft, ClipboardCheck, Compass, Map as MapIcon, PenLine } from "../map/kit/icons";
import { PortRoot } from "../map/kit";
import { useLoad } from "../parts";
import { QA_RUN_KINDS, type QaRunKind } from "../runQa";
import { getQaSetup, setupMissing } from "../setup/setup";
import { SetupGate } from "../setup/SetupGate";
import { PendingRun } from "./PendingRun";
import { RunOptions } from "./RunOptions";
import { KIND_LINE, parsePass } from "./runFlow";
import "./run.css";

const KIND_ICON: Record<QaRunKind, typeof Compass> = { map: MapIcon, explore: Compass, draft: PenLine, check: ClipboardCheck };

const parseKind = (v: string | null): QaRunKind | null => (QA_RUN_KINDS.some((k) => k.key === v) ? (v as QaRunKind) : null);

const noRefresh = () => undefined;

export function RunPage() {
  const { cid } = useSnapshot();
  const auth = qaAuthority(useActingAuthority());
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const kind = parseKind(params.get("kind"));
  const pass = parsePass(params.get("pass"));
  const heading = useRef<HTMLHeadingElement>(null);
  const [tick, setTick] = useState(0);
  const setup = useLoad((s) => getQaSetup(cid ?? "", s), [cid, tick]);
  const missing = setupMissing(setup.data ?? null);
  // Each view opens at its title, so a keyboard carries on from there.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [kind, setup.data]);

  const patch = (next: Record<string, string | null>, push = false) => setParams((cur) => {
    const n = new URLSearchParams(cur);
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === "") n.delete(k);
      else n.set(k, v);
    }
    return n;
  }, { replace: !push });

  const leave = () => {
    const from = params.get("from");
    navigate("/qa" + (from ?? ""));
  };
  // Options opened from the pick go back to it; a deep link goes back to where it came from.
  const back = () => { if (kind && params.get("chose")) patch({ kind: null, chose: null }); else leave(); };
  const title = kind ? QA_RUN_KINDS.find((k) => k.key === kind)!.label : "What do you want to run?";
  if (!cid) return null;
  return (
    <PortRoot refresh={noRefresh} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="qa-run">
        <button type="button" className="qa-back" onClick={back} data-qa-back><ArrowLeft aria-hidden className="size-3.5" /> Back</button>
        {pass ? <PendingRun cid={cid} auth={auth} pass={pass} from={params.get("from")} onLeave={leave} /> : (
          <div className="qa-run-col" data-run-page={kind ?? "pick"}>
            {missing && setup.data ? (
              <SetupGate cid={cid} auth={auth} setup={setup.data} onDone={() => setTick((n) => n + 1)} />
            ) : (
              <>
                <header key={kind ?? "pick"} className="qa-run-rise">
                  <h1 ref={heading} tabIndex={-1} className="text-[22px] font-semibold leading-7 tracking-[-0.01em] text-fg outline-none">{title}</h1>
                </header>
                {kind ? <RunOptions key={`options:${kind}`} cid={cid} auth={auth} kind={kind} params={params} patch={patch} /> : <KindCards onPick={(k) => patch({ kind: k, chose: "1" }, true)} />}
              </>
            )}
          </div>
        )}
      </div>
    </PortRoot>
  );
}

function KindCards({ onPick }: { onPick: (k: QaRunKind) => void }) {
  return (
    <div className="qa-run-cards qa-run-rise">
      {QA_RUN_KINDS.map((k) => {
        const Icon = KIND_ICON[k.key];
        return (
          <button key={k.key} type="button" className="qa-run-card" onClick={() => onPick(k.key)} data-run-kind={k.key}>
            <Icon className="size-5" strokeWidth={1.6} aria-hidden />
            <span className="qa-run-card-t">{k.label}</span>
            <span className="qa-run-card-b">{KIND_LINE[k.key]}</span>
          </button>
        );
      })}
    </div>
  );
}
