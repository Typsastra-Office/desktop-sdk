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
      "When asked to build a report, template or document, ALWAYS: (1) call apply_document_theme first with a professional accent color (use #1F3864 unless the user gives one) so headings are styled; (2) start with a title block (an <h1> title, a one-line subtitle, and an author/date line); (3) use <h2> section headings and <h3> subheadings; (4) give every data <table> a header row and borders; (5) use <ul>/<ol> lists where appropriate; (6) write 2-3 sentences of realistic sample content under every section. Never output plain, unstyled text.",
    enabled: true,
  },
  {
    id: "docx.design",
    name: "Visual design",
    description: "Consistent accent color, headings and typography",
    instruction:
      "Give documents a consistent visual design: apply a single accent color via apply_document_theme, keep a clear heading hierarchy, and use tables and lists for structure instead of long plain paragraphs.",
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

// Keep the latest default instruction text (so improvements apply) while
// preserving the user's enabled/disabled choices.
const mergeSkills = (stored?: Skill[]): Skill[] =>
  DEFAULT_SKILLS.map((def) => {
    const saved = stored?.find((skill) => skill.id === def.id);
    return saved ? { ...def, enabled: saved.enabled } : def;
  });

const useSkillsStore = create<UseSkillsStoreProps>((set, get) => ({
  skills: mergeSkills(loaded.skills),
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
