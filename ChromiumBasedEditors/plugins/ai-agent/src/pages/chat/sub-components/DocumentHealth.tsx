import type { Finding } from "@/lib/agentFindings";
import client from "@/servers";
import useFeedbackStore from "@/store/useFeedbackStore";

const severityClass: Record<string, string> = {
  blocking: "text-[#c0392b]",
  advisory: "text-[#b7791f]",
};

/**
 * Compact "Document health" strip: the source-linked findings from the agent
 * feedback snapshot. Clicking "Go" selects the offending node in the editor.
 */
export const DocumentHealth = () => {
  const findings = useFeedbackStore((s) => s.findings);
  const diff = useFeedbackStore((s) => s.diff);
  if (!findings.length) return null;

  const blocking = findings.filter((f) => f.severity === "blocking").length;

  const go = (finding: Finding) => {
    client
      .callTools("editor", "select_node", { nodeId: finding.nodeId })
      .catch(() => {});
  };

  return (
    <div className="mx-auto w-full max-w-[var(--thread-max-width)] px-[var(--thread-padding-x)] pb-2">
      <div className="rounded-lg border border-black/10 bg-black/[0.03] p-3 dark:border-white/10 dark:bg-white/[0.04]">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
          <span>Document health</span>
          <span className="text-[11px] font-normal opacity-70">
            {blocking} blocking · {findings.length - blocking} advisory
          </span>
          {diff ? (
            <span className="text-[11px] font-normal opacity-70">
              · {diff.clearedFindings} fixed · {diff.newFindings} new
            </span>
          ) : null}
        </div>
        <ul className="flex flex-col gap-1">
          {findings.map((f, i) => (
            <li
              key={`${f.code}-${f.nodeId}-${i}`}
              className="flex items-start gap-2 text-[12px]"
            >
              <span
                className={`shrink-0 font-medium ${severityClass[f.severity] ?? ""}`}
              >
                {f.severity}
              </span>
              <span className="shrink-0 opacity-70">{f.code}</span>
              <span className="min-w-0 flex-1 truncate" title={f.message}>
                {f.message}
              </span>
              <button
                type="button"
                className="shrink-0 underline opacity-70 hover:opacity-100"
                onClick={() => go(f)}
              >
                Go
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
