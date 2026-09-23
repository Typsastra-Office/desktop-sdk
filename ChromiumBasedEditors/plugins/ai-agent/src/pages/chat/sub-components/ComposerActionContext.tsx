import { useEffect } from "react";
import { DropdownMenu } from "@/components/dropdown";
import {
  type EditorReferenceKind,
  fetchEditorReference,
} from "@/lib/editorReference";
import useContextStore from "@/store/useContextStore";

const REFERENCES: { kind: EditorReferenceKind; label: string }[] = [
  { kind: "selection", label: "Selection" },
  { kind: "paragraph", label: "Paragraph" },
  { kind: "document", label: "Document" },
  { kind: "styles", label: "Styles" },
];

const ComposerActionContext = () => {
  const { addContext } = useContextStore();

  // Selection captured from the editor's context menu ("Add to AI chat").
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      if (detail?.text) addContext("selection", "Selection", detail.text);
    };

    window.addEventListener("ai-agent-add-context", handler);
    return () => window.removeEventListener("ai-agent-add-context", handler);
  }, [addContext]);

  const items = REFERENCES.map((reference) => ({
    text: `@${reference.label}`,
    onClick: async () => {
      const text = await fetchEditorReference(reference.kind);
      if (text) addContext(reference.kind, reference.label, text);
    },
  }));

  return (
    <DropdownMenu
      trigger={
        <span
          data-testid="context-button"
          className="cursor-pointer px-[6px] text-[14px] leading-[16px] text-[var(--text-secondary)] hover:text-[var(--text-normal)]"
        >
          @
        </span>
      }
      items={items}
      onOpenChange={() => {}}
    />
  );
};

export { ComposerActionContext };
