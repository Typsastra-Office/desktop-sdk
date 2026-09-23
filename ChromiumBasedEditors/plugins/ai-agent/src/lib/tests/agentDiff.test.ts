import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../agentDiff";
import { diffSnapshots, summarizeDiff } from "../agentDiff";
import type { DocElement, Finding } from "../agentFindings";

const finding = (code: string, nodeId: string): Finding => ({
  code,
  severity: "blocking",
  nodeId,
  message: code,
});

const para = (index: number, text: string): DocElement => ({
  kind: "paragraph",
  index,
  style: "Normal",
  text,
  numbering: false,
  runs: [{ text, font: "Calibri", size: 11, color: "#000000" }],
});

const snap = (findings: Finding[], nodes: DocElement[]): AgentSnapshot => ({
  schema: "tysastra.agent.doc/1.0",
  findings,
  nodes,
});

describe("diffSnapshots", () => {
  it("returns an empty diff for identical snapshots", () => {
    const s = snap([finding("TOC_MISSING", "document")], [para(0, "a")]);
    const d = diffSnapshots(s, s);
    expect(d.newFindings).toEqual([]);
    expect(d.clearedFindings).toEqual([]);
    expect(d.addedNodes).toEqual([]);
    expect(d.changedNodes).toEqual([]);
    expect(d.unchangedNodes).toBe(1);
  });

  it("detects new and cleared findings", () => {
    const before = snap([finding("TOC_MISSING", "document")], [para(0, "a")]);
    const after = snap(
      [finding("DOUBLE_NUMBERING", "paragraph:0")],
      [para(0, "a")]
    );
    const d = diffSnapshots(before, after);
    expect(d.newFindings.map((f) => f.code)).toEqual(["DOUBLE_NUMBERING"]);
    expect(d.clearedFindings.map((f) => f.code)).toEqual(["TOC_MISSING"]);
  });

  it("detects a changed node by fingerprint", () => {
    const before = snap([], [para(0, "old")]);
    const after = snap([], [para(0, "new")]);
    const d = diffSnapshots(before, after);
    expect(d.changedNodes).toEqual(["paragraph:0"]);
  });

  it("detects added and removed nodes", () => {
    const before = snap([], [para(0, "a"), para(1, "b")]);
    const after = snap([], [para(0, "a"), para(2, "c")]);
    const d = diffSnapshots(before, after);
    expect(d.addedNodes).toEqual(["paragraph:2"]);
    expect(d.removedNodes).toEqual(["paragraph:1"]);
  });

  it("summarizes counts", () => {
    const before = snap([finding("A", "document")], [para(0, "a")]);
    const after = snap([], [para(0, "b")]);
    const summary = summarizeDiff(diffSnapshots(before, after));
    expect(summary.clearedFindings).toBe(1);
    expect(summary.changedNodes).toBe(1);
  });
});
