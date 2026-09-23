import { create } from "zustand";
import type { Finding } from "@/lib/agentFindings";

export type DiffSummary = {
  newFindings: number;
  clearedFindings: number;
  addedNodes: number;
  removedNodes: number;
  changedNodes: number;
  unchangedNodes?: number;
};

type UseFeedbackStoreProps = {
  findings: Finding[];
  diff?: DiffSummary;
  setFindings: (findings: Finding[]) => void;
  setDiff: (diff?: DiffSummary) => void;
  clear: () => void;
};

const useFeedbackStore = create<UseFeedbackStoreProps>((set) => ({
  findings: [],
  diff: undefined,
  setFindings: (findings) => set({ findings }),
  setDiff: (diff) => set({ diff }),
  clear: () => set({ findings: [], diff: undefined }),
}));

export default useFeedbackStore;
