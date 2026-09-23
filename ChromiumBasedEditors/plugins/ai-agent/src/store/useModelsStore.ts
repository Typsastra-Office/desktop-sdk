import { create } from "zustand";
import {
  CURRENT_MODEL_KEY,
  DEEP_MODE_KEY,
  REASONING_EFFORT_KEY,
} from "@/lib/constants";
import type { Model } from "@/lib/types";
import { provider } from "@/providers";

export type ReasoningEffort = "low" | "medium" | "high";

type UseModelsStoreProps = {
  currentModel: Model | null;
  persistedModel: Model | null;

  extendedThinking: boolean;
  reasoningEffort: ReasoningEffort;

  selectModel: (model: Model) => void;
  setSessionModel: (model: Model | null) => void;

  deleteSelectedModel: () => void;

  toggleExtendedThinking: () => void;
  setReasoningEffort: (effort: ReasoningEffort) => void;
};

const useModelsStore = create<UseModelsStoreProps>((set) => ({
  currentModel: (() => {
    const saved = localStorage.getItem(CURRENT_MODEL_KEY);

    if (!saved) return null;

    const parsed: Model = JSON.parse(saved);

    provider.setCurrentProviderModel(parsed.id, parsed.reasoning);

    return parsed;
  })(),
  persistedModel: (() => {
    const saved = localStorage.getItem(CURRENT_MODEL_KEY);

    if (!saved) return null;

    const parsed: Model = JSON.parse(saved);

    provider.setCurrentProviderModel(parsed.id, parsed.reasoning);

    return parsed;
  })(),
  extendedThinking: (() => {
    const saved = localStorage.getItem(DEEP_MODE_KEY);

    if (!saved) return false;

    return JSON.parse(saved);
  })(),
  reasoningEffort: (() => {
    const saved = localStorage.getItem(REASONING_EFFORT_KEY);

    const effort: ReasoningEffort =
      saved === "low" || saved === "high" ? saved : "medium";

    provider.setCurrentProviderReasoningEffort(effort);

    return effort;
  })(),

  selectModel: (model) => {
    set({ currentModel: model, persistedModel: model });
    provider.setCurrentProviderModel(model.id, model.reasoning);
    localStorage.setItem(CURRENT_MODEL_KEY, JSON.stringify(model));
  },
  setSessionModel: (model) => {
    set((state) => {
      const nextModel = model ?? state.persistedModel ?? null;
      provider.setCurrentProviderModel(
        nextModel?.id ?? "",
        nextModel?.reasoning
      );
      return { currentModel: nextModel };
    });
  },

  deleteSelectedModel: () => {
    set({ currentModel: null, persistedModel: null });
    localStorage.removeItem(CURRENT_MODEL_KEY);
    provider.setCurrentProviderModel("");
  },

  toggleExtendedThinking: () => {
    set((state) => {
      const currStatus = !state.extendedThinking;

      localStorage.setItem(DEEP_MODE_KEY, JSON.stringify(currStatus));

      return { extendedThinking: currStatus };
    });
  },

  setReasoningEffort: (effort) => {
    provider.setCurrentProviderReasoningEffort(effort);
    localStorage.setItem(REASONING_EFFORT_KEY, effort);
    set({ reasoningEffort: effort });
  },
}));

export default useModelsStore;
