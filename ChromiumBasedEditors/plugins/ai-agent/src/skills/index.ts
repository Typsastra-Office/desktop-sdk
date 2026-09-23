import documentation from "./documentation/SKILL.md?raw";
import editing from "./editing/SKILL.md?raw";
import multilingual from "./multilingual/SKILL.md?raw";

/**
 * A skill is authored as a markdown file (`SKILL.md`) with YAML frontmatter.
 * The markdown body is exactly what gets sent to the provider as part of the
 * system prompt, so skills can be written and reviewed like documentation.
 */
export type SkillFile = {
  id: string;
  name: string;
  description: string;
  body: string;
  defaultEnabled: boolean;
};

type Frontmatter = {
  name?: string;
  description?: string;
  "default-enabled"?: string;
};

const parseFrontmatter = (raw: string): { meta: Frontmatter; body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) return { meta: {}, body: raw.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }

  return { meta: meta as Frontmatter, body: match[2].trim() };
};

const toSkillFile = (
  id: string,
  raw: string,
  fallbackName: string
): SkillFile => {
  const { meta, body } = parseFrontmatter(raw);

  return {
    id,
    name: meta.name ?? fallbackName,
    description: meta.description ?? "",
    body,
    defaultEnabled: meta["default-enabled"] !== "false",
  };
};

export const SKILL_FILES: SkillFile[] = [
  toSkillFile("docx.report", documentation, "Report and documentation building"),
  toSkillFile("docx.editing", editing, "Editing and rewriting"),
  toSkillFile("docx.i18n", multilingual, "Multilingual documents"),
];
