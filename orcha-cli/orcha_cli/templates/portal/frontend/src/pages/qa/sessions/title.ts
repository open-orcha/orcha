import type { QaSession } from "../qaApi";
import { platformWord, sessionKindWord } from "../qaWords";

/** A session as a line of text: what it was asked, else its kind and platform. */
export function sessionTitle(s: Pick<QaSession, "goal" | "kind" | "platform">): string {
  return s.goal?.trim() || `${sessionKindWord(s.kind)} on ${platformWord(s.platform)}`;
}
