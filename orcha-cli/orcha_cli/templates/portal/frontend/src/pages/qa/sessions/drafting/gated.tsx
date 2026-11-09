import type { ReactElement } from "react";
import { Tooltip } from "../../../../components/primitives";
import type { QaAuthority } from "../../authority";

/** A decision only a person takes: the disabled control says why, the server enforces it. */
export function Gated({ auth, children }: { auth: QaAuthority; children: ReactElement }) {
  return auth.can ? children : <Tooltip label={auth.reason || "Only a person can decide on a draft"} placement="top">{children}</Tooltip>;
}
