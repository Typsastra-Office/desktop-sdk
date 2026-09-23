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
    name: "Report / documentation building",
    description: "Build complete, designed, professional documents",
    instruction:
      "When asked to build a report, template, proposal or any document, follow this workflow. " +
      "1) Call apply_document_theme FIRST with a professional accent color (#1F3864 unless the user specifies one) so the heading styles are styled. " +
      "2) Insert a title block: an <h1> title, a one-line subtitle, and an author/date/organisation line. " +
      "3) Build the body with real headings using insert_html: <h2> for sections and <h3> for subsections only. Never fake a heading with bold text - the heading styles drive the outline and the table of contents. " +
      "4) Write 2-3 sentences or more of realistic sample content under every section; never leave a section empty. " +
      "5) After the title block and before the first section, call insert_table_of_contents to add a DYNAMIC table of contents (generated from the headings) - do not hand-write a list of section names. Put a page break before the first section so the TOC is on the title page. " +
      "6) Tables: give every data table a <thead> header row. Call fit_table mode 'page' to stretch wide tables (many columns) to the page width, or mode 'contents' with center=true for small tables. Add a caption under each table via add_caption with label 'Table'. " +
      "7) Images: insert relevant figures with insert_image (about 400-500 pt wide, centered) near the text that references them, and add a caption via add_caption with label 'Figure'. " +
      "8) Control whitespace: call keep_with_next(true) on every heading and caption so they are not orphaned at the bottom of a page; use set_paragraph_spacing for consistent heading spacing (e.g. before 12, after 6) instead of inserting blank paragraphs; never use more than one empty paragraph in a row; use insert_page_break only between major sections, not mid-section. " +
      "9) Keep a consistent look: the same heading levels, table styling and spacing throughout, with page margins around 56 pt (set_page_margins) unless the user asks otherwise. " +
      "10) When finished, call get_document_html and review: every section has content, headings are hierarchical, tables fit and are captioned, the TOC is present and there are no large empty gaps. Fix anything wrong before you answer.",
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
