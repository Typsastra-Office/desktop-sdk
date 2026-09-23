import { create } from "zustand";

const GLOBAL_KEY = "ai-agent-skills-global";

export type Skill = {
  id: string;
  name: string;
  description: string;
  instruction: string;
  enabled: boolean;
};

export type Rule = {
  id: string;
  text: string;
  scope: "global" | "document";
  enabled: boolean;
};

const DEFAULT_SKILLS: Skill[] = [
  {
    id: "docx.report",
    name: "Report building",
    description: "Build complete, designed documents",
    instruction:
      "When asked to build a report, template or document, produce a complete, well-designed result: a title block, real headings (h1/h2/h3), sample content in every section and at least one data table.",
    enabled: true,
  },
  {
    id: "docx.rewrite",
    name: "Rewrite and proofread",
    description: "Rewrite or correct selected text in place",
    instruction:
      "When asked to rewrite, correct or proofread text, edit it in place in the document and preserve the surrounding formatting.",
    enabled: true,
  },
  {
    id: "docx.style",
    name: "Style matching",
    description: "Match the document's existing style",
    instruction:
      "Match the existing styles and formatting of the document when adding new content.",
    enabled: true,
  },
  {
    id: "docx.i18n",
    name: "Multilingual fonts",
    description: "Use the correct font for non-Latin scripts",
    instruction:
      "Use the correct font for non-Latin scripts (for example Khmer OS Siemreap for Khmer text).",
    enabled: false,
  },
];

type UseSkillsStoreProps = {
  skills: Skill[];
  globalRules: Rule[];
  documentRules: Rule[];
  toggleSkill: (id: string) => void;
  addRule: (text: string, scope: "global" | "document") => void;
  removeRule: (id: string) => void;
  toggleRule: (id: string) => void;
  getActiveInstructions: () => string;
};

const createId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const loadGlobal = (): { skills?: Skill[]; rules?: Rule[] } => {
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
};

const persistGlobal = (skills: Skill[], rules: Rule[]) => {
  try {
    localStorage.setItem(GLOBAL_KEY, JSON.stringify({ skills, rules }));
  } catch {
    // ignore
  }
};

const loaded = loadGlobal();

const useSkillsStore = create<UseSkillsStoreProps>((set, get) => ({
  skills: loaded.skills?.length ? loaded.skills : DEFAULT_SKILLS,
  globalRules: loaded.rules ?? [],
  // Document-scoped rules live only for the current document session.
  documentRules: [],
  toggleSkill: (id) =>
    set((state) => {
      const skills = state.skills.map((skill) =>
        skill.id === id ? { ...skill, enabled: !skill.enabled } : skill
      );
      persistGlobal(skills, state.globalRules);
      return { skills };
    }),
  addRule: (text, scope) =>
    set((state) => {
      const rule: Rule = { id: createId(), text, scope, enabled: true };
      if (scope === "global") {
        const globalRules = [...state.globalRules, rule];
        persistGlobal(state.skills, globalRules);
        return { globalRules };
      }
      return { documentRules: [...state.documentRules, rule] };
    }),
  removeRule: (id) =>
    set((state) => {
      const globalRules = state.globalRules.filter((rule) => rule.id !== id);
      persistGlobal(state.skills, globalRules);
      return {
        globalRules,
        documentRules: state.documentRules.filter((rule) => rule.id !== id),
      };
    }),
  toggleRule: (id) =>
    set((state) => {
      const globalRules = state.globalRules.map((rule) =>
        rule.id === id ? { ...rule, enabled: !rule.enabled } : rule
      );
      persistGlobal(state.skills, globalRules);
      const documentRules = state.documentRules.map((rule) =>
        rule.id === id ? { ...rule, enabled: !rule.enabled } : rule
      );
      return { globalRules, documentRules };
    }),
  getActiveInstructions: () => {
    const state = get();
    const instructions = state.skills
      .filter((skill) => skill.enabled)
      .map((skill) => skill.instruction);
    const rules = [...state.globalRules, ...state.documentRules]
      .filter((rule) => rule.enabled)
      .map((rule) => rule.text);

    const parts: string[] = [];
    if (instructions.length)
      parts.push(`Skills:\n${instructions.map((i) => `- ${i}`).join("\n")}`);
    if (rules.length)
      parts.push(
        `Rules (you must always follow these):\n${rules.map((r) => `- ${r}`).join("\n")}`
      );
    return parts.join("\n\n");
  },
}));

export default useSkillsStore;
