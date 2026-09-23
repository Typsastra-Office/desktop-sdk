import useContextStore from "@/store/useContextStore";

const ComposerContextChips = () => {
  const { items, removeContext } = useContextStore();

  if (!items.length) return null;

  return (
    <div className="flex flex-row flex-wrap gap-[8px]">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex max-w-[220px] items-center gap-[6px] rounded-[6px] border px-[8px] py-[4px] text-[12px] text-[var(--text-secondary)]"
        >
          <span className="font-medium">@{item.label}</span>
          <span className="truncate opacity-70">
            {item.text.slice(0, 60)}
          </span>
          <button
            type="button"
            className="cursor-pointer px-[2px] leading-none"
            onClick={() => removeContext(item.id)}
            aria-label="Remove context"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};

export { ComposerContextChips };
