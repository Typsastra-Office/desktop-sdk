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
  coverage?: Record<string, string>;
  setFindings: (findings: Finding[]) => void;
  setDiff: (diff?: DiffSummary) => void;
  setCoverage: (coverage?: Record<string, string>) => void;
  clear: () => void;
};

const useFeedbackStore = create<UseFeedbackStoreProps>((set) => ({
  findings: [],
  diff: undefined,
  coverage: undefined,
  setFindings: (findings) => set({ findings }),
  setDiff: (diff) => set({ diff }),
  setCoverage: (coverage) => set({ coverage }),
  clear: () => set({ findings: [], diff: undefined, coverage: undefined }),
}));

export default useFeedbackStore;
