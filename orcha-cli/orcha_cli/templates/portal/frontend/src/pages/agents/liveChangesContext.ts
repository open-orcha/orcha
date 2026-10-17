/**
 * Live changes — what the workspace hands its Conversation so the live "Working…" row
 * can carry the same "Live changes 3 files +42 −7" button as the header (one poller,
 * owned by AgentsPage; null = no run to show changes for).
 */
import { createContext, useContext } from "react";

export interface LiveChangesCtx {
  runId: string;
  live: boolean;
  summary: { files: number; additions: number; deletions: number } | null;
  isOpen: boolean;
  open: () => void;
}

export const LiveChangesContext = createContext<LiveChangesCtx | null>(null);

export const useLiveChangesCtx = () => useContext(LiveChangesContext);
