import { describe, expect, it } from "vitest";
import {
  blockingFindings,
  computeFindings,
  type DocModel,
  type ParagraphElement,
  summarizeFindings,
} from "../agentFindings";

const heading = (
  index: number,
  text: string,
  numbering = true,
  style = "Heading 1"
): ParagraphElement => ({
  kind: "paragraph",
  index,
  style,
  text,
  numbering,
  runs: [{ text, font: "Calibri", size: 18, color: "#1b4965", direct: false }],
});

const body = (index: number, text: string): ParagraphElement => ({
  kind: "paragraph",
  index,
  style: "Normal",
  text,
  numbering: false,
  runs: [{ text, font: "Calibri", size: 11, color: "#20303c", direct: false }],
});

describe("computeFindings", () => {
  it("returns nothing for a clean document", () => {
    const model: DocModel = {
      stylesDefined: ["Normal", "Heading 1"],
      stylesUsed: ["Normal", "Heading 1"],
      elements: [
        { kind: "toc", index: 0 },
        heading(1, "Introduction"),
        body(2, "Real content."),
        heading(3, "Causes"),
        body(4, "More content."),
        heading(5, "Impacts"),
        body(6, "Even more."),
        {
          kind: "table",
          index: 7,
          rows: 3,
          cols: 2,
          headerShaded: true,
          caption: "Table 1. Data.",
        },
      ],
    };

    expect(computeFindings(model)).toEqual([]);
  });

  it("flags DOUBLE_NUMBERING when a numbered heading also has a manual number", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      // GetText includes the automatic prefix ("1.\t") before the manual number.
      elements: [heading(0, "1.\t1. Introduction"), body(1, "Text.")],
    };

    const findings = computeFindings(model);
    expect(findings.map((f) => f.code)).toContain("DOUBLE_NUMBERING");
    expect(findings[0].severity).toBe("blocking");
    expect(findings[0].nodeId).toBe("paragraph:0");
  });

  it("does not flag a numbered heading whose text has no manual number", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      // "2.\t" is the automatic number; "Empty Section" is the heading text.
      elements: [heading(0, "2.\tEmpty Section"), body(1, "Text.")],
    };
    expect(computeFindings(model).map((f) => f.code)).not.toContain(
      "DOUBLE_NUMBERING"
    );
  });

  it("flags EMPTY_SECTION for a heading with no content", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [heading(0, "Empty"), heading(1, "Next"), body(2, "Text.")],
    };
    const findings = computeFindings(model);
    expect(findings.map((f) => f.code)).toContain("EMPTY_SECTION");
    expect(findings[0].severity).toBe("blocking");
  });

  it("flags DIRECT_FORMAT_OVERRIDE (advisory)", () => {
    const p = heading(0, "Title");
    p.runs = [{ text: "Title", font: "Times New Roman", direct: true }];
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [p, body(1, "Text.")],
    };
    const findings = computeFindings(model);
    expect(findings.map((f) => f.code)).toContain("DIRECT_FORMAT_OVERRIDE");
    expect(findings[0].severity).toBe("advisory");
  });

  it("flags MISSING_CAPTION for tables and images", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [
        { kind: "table", index: 0, rows: 2, cols: 2, headerShaded: true, caption: null },
        { kind: "image", index: 1, caption: null },
      ],
    };
    const codes = computeFindings(model).map((f) => f.code);
    expect(codes.filter((c) => c === "MISSING_CAPTION")).toHaveLength(2);
  });

  it("flags TOC_MISSING when there are headings but no TOC", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [
        heading(0, "One"),
        body(1, "a"),
        heading(2, "Two"),
        body(3, "b"),
        heading(4, "Three"),
        body(5, "c"),
      ],
    };
    expect(computeFindings(model).map((f) => f.code)).toContain("TOC_MISSING");
  });

  it("flags HEADING_LEVEL_SKIP when heading levels jump", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [
        heading(0, "One", true, "Heading 1"),
        body(1, "a"),
        heading(2, "Deep", true, "Heading 3"),
        body(3, "b"),
      ],
    };
    expect(computeFindings(model).map((f) => f.code)).toContain(
      "HEADING_LEVEL_SKIP"
    );
  });

  it("uses a stable id for the finding nodeId when present", () => {
    const p = heading(0, "1.\t1. Intro");
    p.id = "paragraph:1763520491";
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [p, body(1, "x")],
    };
    expect(computeFindings(model)[0].nodeId).toBe("paragraph:1763520491");
  });

  it("flags ORPHAN_HEADING when a heading ends a page", () => {
    const h = heading(0, "Intro");
    h.geometry = { absPage: 0 };
    const b = body(1, "text");
    b.geometry = { absPage: 1 };
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [h, b],
    };
    expect(computeFindings(model).map((f) => f.code)).toContain(
      "ORPHAN_HEADING"
    );
  });

  it("does not flag ORPHAN_HEADING when the heading shares the page", () => {
    const h = heading(0, "Intro");
    h.geometry = { absPage: 0 };
    const b = body(1, "text");
    b.geometry = { absPage: 0 };
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [h, b],
    };
    expect(computeFindings(model).map((f) => f.code)).not.toContain(
      "ORPHAN_HEADING"
    );
  });

  it("flags TABLE_WIDTH_OVERFLOW when a table exceeds the text column", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      page: {
        width: 210,
        height: 297,
        marginLeft: 25.4,
        marginRight: 25.4,
        marginTop: 25.4,
        marginBottom: 25.4,
        contentWidth: 159.2,
        contentHeight: 246.2,
      },
      elements: [
        {
          kind: "table",
          index: 0,
          rows: 2,
          cols: 2,
          headerShaded: true,
          caption: "Table 1. x",
          geometry: { right: 200 },
        },
      ],
    };
    expect(computeFindings(model).map((f) => f.code)).toContain(
      "TABLE_WIDTH_OVERFLOW"
    );
  });

  it("does not flag a table that fits the text column", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      page: {
        width: 210,
        height: 297,
        marginLeft: 25.4,
        marginRight: 25.4,
        marginTop: 25.4,
        marginBottom: 25.4,
        contentWidth: 159.2,
        contentHeight: 246.2,
      },
      elements: [
        {
          kind: "table",
          index: 0,
          rows: 2,
          cols: 2,
          headerShaded: true,
          caption: "Table 1. x",
          geometry: { right: 180 },
        },
      ],
    };
    expect(computeFindings(model).map((f) => f.code)).not.toContain(
      "TABLE_WIDTH_OVERFLOW"
    );
  });

  it("summarizes by severity and code", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [heading(0, "1.\t1. Intro"), heading(1, "2.\tEmpty"), body(2, "x")],
    };
    const summary = summarizeFindings(computeFindings(model));
    expect(summary.blocking).toBeGreaterThanOrEqual(1);
    expect(summary.total).toBe(summary.blocking + summary.advisory);
    expect(summary.byCode.DOUBLE_NUMBERING).toBe(1);
  });

  it("filters blocking findings", () => {
    const model: DocModel = {
      stylesDefined: [],
      stylesUsed: [],
      elements: [heading(0, "1.\t1. Intro"), body(1, "x")],
    };
    const findings = computeFindings(model);
    expect(blockingFindings(findings).every((f) => f.severity === "blocking")).toBe(
      true
    );
  });
});
