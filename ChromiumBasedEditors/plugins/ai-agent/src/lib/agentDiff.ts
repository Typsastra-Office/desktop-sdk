/**
 * Agent document feedback — snapshot diff.
 *
 * Pure, renderer-independent comparison of two feedback snapshots, keyed by
 * finding identity (`code:nodeId`) and node identity (`kind:index`). The findings
 * diff is robust; the node diff is index-based until durable ids land, so
 * structural insertions can appear as changes.
 */

import type { DocElement, Finding } from "./agentFindings";
import { nodeIdOf } from "./agentFindings";

export type AgentSnapshot = {
  schema: string;
  findings: Finding[];
  nodes: DocElement[];
};

export type SnapshotDiff = {
  newFindings: Finding[];
  clearedFindings: Finding[];
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];
  unchangedNodes: number;
};

const findingKey = (f: Finding) => `${f.code}:${f.nodeId}`;
const nodeKey = (n: DocElement) => nodeIdOf(n);

const nodeFingerprint = (n: DocElement): string => {
  switch (n.kind) {
    case "paragraph":
      return JSON.stringify({
        s: n.style,
        t: n.text,
        num: n.numbering,
        r: n.runs.map((x) => [
          x.text,
          x.font,
          x.size,
          x.color,
          x.bold,
          x.italic,
          x.direct,
        ]),
      });
    case "table":
      return JSON.stringify({
        rows: n.rows,
        cols: n.cols,
        h: n.headerShaded,
        c: n.caption,
      });
    case "image":
      return JSON.stringify({ c: n.caption });
    case "toc":
      return "toc";
  }
};

export const diffSnapshots = (
  before: AgentSnapshot,
  after: AgentSnapshot
): SnapshotDiff => {
  const beforeFindings = new Set(before.findings.map(findingKey));
  const afterFindings = new Set(after.findings.map(findingKey));

  const newFindings = after.findings.filter(
    (f) => !beforeFindings.has(findingKey(f))
  );
  const clearedFindings = before.findings.filter(
    (f) => !afterFindings.has(findingKey(f))
  );

  const beforeNodes = new Map(before.nodes.map((n) => [nodeKey(n), n]));
  const afterNodes = new Map(after.nodes.map((n) => [nodeKey(n), n]));

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const changedNodes: string[] = [];
  let unchangedNodes = 0;

  for (const [key, node] of afterNodes) {
    const prev = beforeNodes.get(key);
    if (!prev) addedNodes.push(key);
    else if (nodeFingerprint(prev) !== nodeFingerprint(node))
      changedNodes.push(key);
    else unchangedNodes++;
  }
  for (const key of beforeNodes.keys()) {
    if (!afterNodes.has(key)) removedNodes.push(key);
  }

  return {
    newFindings,
    clearedFindings,
    addedNodes,
    removedNodes,
    changedNodes,
    unchangedNodes,
  };
};

export const summarizeDiff = (d: SnapshotDiff) => ({
  newFindings: d.newFindings.length,
  clearedFindings: d.clearedFindings.length,
  addedNodes: d.addedNodes.length,
  removedNodes: d.removedNodes.length,
  changedNodes: d.changedNodes.length,
  unchangedNodes: d.unchangedNodes,
});
