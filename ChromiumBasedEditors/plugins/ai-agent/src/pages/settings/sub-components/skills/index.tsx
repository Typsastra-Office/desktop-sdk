import { useState } from "react";
import useSkillsStore from "@/store/useSkillsStore";

const Skills = () => {
  const {
    skills,
    globalRules,
    documentRules,
    toggleSkill,
    addRule,
    removeRule,
    toggleRule,
  } = useSkillsStore();

  const [text, setText] = useState("");
  const [scope, setScope] = useState<"global" | "document">("global");

  const rules = [...globalRules, ...documentRules];

  const onAdd = () => {
    const value = text.trim();
    if (!value) return;
    addRule(value, scope);
    setText("");
  };

  return (
    <div className="flex flex-col gap-[16px] select-none">
      <div>
        <h3 className="font-bold text-[20px] leading-[28px] text-[var(--settings-header-color)]">
          Skills
        </h3>
        <p className="text-[14px] leading-[20px] text-[var(--settings-description-color)] mt-[4px]">
          Capabilities the agent always follows when editing the document.
        </p>
      </div>

      <div className="flex flex-col gap-[8px]">
        {skills.map((skill) => (
          <label
            key={skill.id}
            className="flex items-start gap-[8px] text-[14px] leading-[20px] text-[var(--text-normal)] cursor-pointer"
          >
            <input
              type="checkbox"
              checked={skill.enabled}
              onChange={() => toggleSkill(skill.id)}
            />
            <span>
              <span className="font-medium">{skill.name}</span> —{" "}
              <span className="text-[var(--settings-description-color)]">
                {skill.description}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-[8px]">
        <h3 className="font-bold text-[16px] leading-[24px] text-[var(--settings-header-color)]">
          Custom rules
        </h3>
        <p className="text-[14px] leading-[20px] text-[var(--settings-description-color)]">
          Additional rules on top of the skills, applied globally or only to the
          current document.
        </p>

        {rules.length ? (
          <div className="flex flex-col gap-[6px]">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-[8px] text-[13px] leading-[18px] text-[var(--text-normal)]"
              >
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => toggleRule(rule.id)}
                />
                <span className="flex-1">{rule.text}</span>
                <span className="text-[11px] opacity-60">{rule.scope}</span>
                <button
                  type="button"
                  className="cursor-pointer px-[4px]"
                  onClick={() => removeRule(rule.id)}
                  aria-label="Remove rule"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="e.g. Only use Khmer OS Siemreap font for Khmer script"
          className="min-h-[64px] w-full rounded-[4px] border p-[8px] text-[13px] text-[var(--input-color)] bg-[var(--input-background-color)] border-[var(--input-border-color)]"
        />

        <div className="flex items-center gap-[8px]">
          <select
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as "global" | "document")
            }
            className="h-[32px] rounded-[4px] border px-[8px] text-[13px] text-[var(--input-color)] bg-[var(--input-background-color)] border-[var(--input-border-color)]"
          >
            <option value="global">Global</option>
            <option value="document">This document</option>
          </select>
          <button
            type="button"
            onClick={onAdd}
            className="h-[32px] cursor-pointer rounded-[4px] bg-[var(--chat-composer-action-send-background-color)] px-[12px] text-[13px] text-[var(--text-normal)]"
          >
            Add rule
          </button>
        </div>
      </div>
    </div>
  );
};

export { Skills };
