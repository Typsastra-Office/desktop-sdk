import { create } from "zustand";
import type { Finding } from "@/lib/agentFindings";

type UseFeedbackStoreProps = {
  findings: Finding[];
  setFindings: (findings: Finding[]) => void;
  clear: () => void;
};

const useFeedbackStore = create<UseFeedbackStoreProps>((set) => ({
  findings: [],
  setFindings: (findings) => set({ findings }),
  clear: () => set({ findings: [] }),
}));

export default useFeedbackStore;
