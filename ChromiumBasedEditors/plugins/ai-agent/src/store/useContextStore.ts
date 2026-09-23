import { create } from "zustand";

export type ContextItem = {
  id: string;
  kind: string;
  label: string;
  text: string;
};

type UseContextStoreProps = {
  items: ContextItem[];
  addContext: (kind: string, label: string, text: string) => void;
  removeContext: (id: string) => void;
  clearContext: () => void;
};

const MAX_CONTEXT_ITEMS = 5;

const createId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const useContextStore = create<UseContextStoreProps>((set) => ({
  items: [],
  addContext: (kind, label, text) =>
    set((state) => {
      if (!text || state.items.length >= MAX_CONTEXT_ITEMS) return state;
      return { items: [...state.items, { id: createId(), kind, label, text }] };
    }),
  removeContext: (id) =>
    set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  clearContext: () => set({ items: [] }),
}));

export default useContextStore;
