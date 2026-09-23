import { create } from "zustand";
import { SKILL_FILES } from "@/skills";

const GLOBAL_KEY = "ai-agent-skills-global";

export type Skill = {
  id: string;
  name: string;
  description: string;
  /** The markdown body of the SKILL.md file - this is sent to the provider. */
  instruction: string;
  enabled: boolean;
};

export type Rule = {
  id: string;
  text: string;
  scope: "global" | "document";
  enabled: boolean;
};

// Skills are authored as markdown files (src/skills/<id>/SKILL.md). The body of
// each file is what is sent to the provider, so a skill can be written and
// reviewed like documentation instead of being hardcoded here.
const DEFAULT_SKILLS: Skill[] = SKILL_FILES.map((file) => ({
  id: file.id,
  name: file.name,
  description: file.description,
  instruction: file.body,
  enabled: file.defaultEnabled,
}));

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

// Keep the latest markdown from the SKILL.md files (so edits apply) while
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
    const skillBodies = state.skills
      .filter((skill) => skill.enabled)
      .map((skill) => skill.instruction);
    const rules = [...state.globalRules, ...state.documentRules]
      .filter((rule) => rule.enabled)
      .map((rule) => rule.text);

    const parts: string[] = [];

    if (skillBodies.length) {
      parts.push(skillBodies.join("\n\n---\n\n"));
    }

    if (rules.length) {
      parts.push(
        `# Rules (you must always follow these)\n${rules
          .map((rule) => `- ${rule}`)
          .join("\n")}`
      );
    }

    return parts.join("\n\n");
  },
}));

export default useSkillsStore;
