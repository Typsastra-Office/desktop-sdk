import { ComboBox } from "@/components/combo-box";
import useModelsStore, { type ReasoningEffort } from "@/store/useModelsStore";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

const ComposerActionEffort = () => {
  const { reasoningEffort, setReasoningEffort } = useModelsStore();

  const items = EFFORTS.map((effort) => ({
    text: EFFORT_LABELS[effort],
    id: effort,
    onClick: () => setReasoningEffort(effort),
    checked: reasoningEffort === effort,
  }));

  return (
    <ComboBox
      value={EFFORT_LABELS[reasoningEffort]}
      items={items}
      withoutBg
      data-testid="effort-selector"
    />
  );
};

export { ComposerActionEffort };
