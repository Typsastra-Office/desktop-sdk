/**
 * Agent document feedback — findings engine.
 *
 * Pure, renderer-independent logic that turns a structural document model
 * (collected from the editor) into source-linked findings. Kept free of editor
 * APIs so it can be unit tested. See docs/agent-doc-snapshot.md.
 */

export type Severity = "blocking" | "advisory";

export type Finding = {
  code: string;
  severity: Severity;
  nodeId: string;
  message: string;
  evidence?: unknown;
};

export type RunModel = {
  text: string;
  font?: string | null;
  size?: number | null;
  color?: string | null;
  bold?: boolean;
  italic?: boolean;
  /** Run formatting differs from its paragraph style. */
  direct?: boolean;
};

export type ParagraphGeometry = {
  absPage: number;
  pagesCount?: number;
  linesCount?: number;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
};

export type TableGeometry = {
  pagesCount?: number;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
};

export type PageGeometry = {
  width: number;
  height: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  contentWidth?: number;
  contentHeight?: number;
};

export type BoxGeometry = {
  distance?: number;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
};

export type ParagraphElement = {
  kind: "paragraph";
  index: number;
  /** Stable node id, e.g. "paragraph:<paraId>"; falls back to kind:index. */
  id?: string;
  style: string;
  text: string;
  numbering: boolean;
  runs: RunModel[];
  /** Page geometry from the editor engine (phase 1). */
  geometry?: ParagraphGeometry;
};

export type TableElement = {
  kind: "table";
  index: number;
  id?: string;
  rows: number;
  cols: number;
  headerShaded: boolean;
  caption: string | null;
  geometry?: TableGeometry;
};

export type ImageElement = {
  kind: "image";
  index: number;
  id?: string;
  caption: string | null;
};

export type TocElement = {
  kind: "toc";
  index: number;
  id?: string;
};

export type DocElement =
  | ParagraphElement
  | TableElement
  | ImageElement
  | TocElement;

export type DocModel = {
  elements: DocElement[];
  stylesDefined: string[];
  stylesUsed: string[];
  page?: PageGeometry;
  header?: BoxGeometry;
  footer?: BoxGeometry;
};

export const nodeIdOf = (e: DocElement): string =>
  e.id ?? `${e.kind}:${e.index}`;

const HEADING_RE = /^Heading ([1-9])$/;
const MANUAL_NUMBER_RE = /^\s*\d+(?:\.\d+)*[.)]\s+/;
const CAPTION_RE = /^(Table|Figure)\s+\d+\./i;

/**
 * Returns objective, source-linked findings for a document model. Ordering is
 * stable so results can be diffed between runs.
 */
export const computeFindings = (model: DocModel): Finding[] => {
  const findings: Finding[] = [];
  const els = model.elements ?? [];

  const headingCount = els.filter(
    (e): e is ParagraphElement =>
      e.kind === "paragraph" && HEADING_RE.test(e.style)
  ).length;

  for (const e of els) {
    if (e.kind !== "paragraph") continue;

    // Automatic numbering plus a manually typed number. GetText includes the
    // automatic number prefix ("1.\tIntro"), so strip that first and only a
    // manually typed number remains.
    if (HEADING_RE.test(e.style) && e.numbering) {
      const stripped = e.text.replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, "");
      if (MANUAL_NUMBER_RE.test(stripped)) {
        findings.push({
          code: "DOUBLE_NUMBERING",
          severity: "blocking",
          nodeId: nodeIdOf(e),
          message: `Heading has automatic numbering and a manual number: "${stripped.slice(0, 60)}"`,
          evidence: { text: e.text.slice(0, 80) },
        });
      }
    }

    // Direct formatting that overrides the named style.
    if ((e.runs ?? []).some((r) => r.direct)) {
      findings.push({
        code: "DIRECT_FORMAT_OVERRIDE",
        severity: "advisory",
        nodeId: nodeIdOf(e),
        message: `Text uses direct formatting that overrides the "${e.style}" style`,
      });
    }
  }

  // A Heading 1 with no content before the next Heading 1.
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (e.kind !== "paragraph" || e.style !== "Heading 1") continue;

    let hasContent = false;
    for (let j = i + 1; j < els.length; j++) {
      const nx = els[j];
      if (nx.kind === "paragraph" && nx.style === "Heading 1") break;
      if (nx.kind === "table") {
        hasContent = true;
        break;
      }
      if (nx.kind === "paragraph" && nx.text.trim()) {
        hasContent = true;
        break;
      }
    }

    if (!hasContent) {
      findings.push({
        code: "EMPTY_SECTION",
        severity: "blocking",
        nodeId: nodeIdOf(e),
        message: `Section "${e.text.slice(0, 50)}" has no content`,
      });
    }
  }

  // Heading levels should not skip (e.g. Heading 1 -> Heading 3).
  let lastLevel = 0;
  for (const e of els) {
    if (e.kind !== "paragraph") continue;
    const m = HEADING_RE.exec(e.style);
    if (!m) continue;
    const level = parseInt(m[1], 10);
    if (lastLevel > 0 && level > lastLevel + 1) {
      findings.push({
        code: "HEADING_LEVEL_SKIP",
        severity: "advisory",
        nodeId: nodeIdOf(e),
        message: `Heading level jumps from ${lastLevel} to ${level}: "${e.text.slice(0, 50)}"`,
      });
    }
    lastLevel = level;
  }

  // A heading that ends a page: its next content starts on a later page.
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (e.kind !== "paragraph" || !HEADING_RE.test(e.style) || !e.geometry)
      continue;

    let nextPage: number | undefined;
    for (let j = i + 1; j < els.length; j++) {
      const nx = els[j];
      if (nx.kind === "toc") continue;
      if (nx.kind === "paragraph" && HEADING_RE.test(nx.style)) {
        nextPage = nx.geometry?.absPage;
        break;
      }
      if (nx.kind === "paragraph" && nx.text.trim()) {
        nextPage = nx.geometry?.absPage;
        break;
      }
      if (nx.kind === "table") break;
    }

    if (typeof nextPage === "number" && nextPage > e.geometry.absPage) {
      findings.push({
        code: "ORPHAN_HEADING",
        severity: "advisory",
        nodeId: nodeIdOf(e),
        message: `Heading ends page ${e.geometry.absPage + 1}; its content starts on page ${nextPage + 1}`,
      });
    }
  }

  // Table wider than the text column (geometry, phase 1).
  if (model.page && typeof model.page.contentWidth === "number") {
    const maxRight = model.page.marginLeft + model.page.contentWidth;
    for (const e of els) {
      if (e.kind !== "table" || !e.geometry) continue;
      if (
        typeof e.geometry.right === "number" &&
        e.geometry.right > maxRight + 0.5
      ) {
        findings.push({
          code: "TABLE_WIDTH_OVERFLOW",
          severity: "advisory",
          nodeId: nodeIdOf(e),
          message: `Table extends ${(e.geometry.right - maxRight).toFixed(1)}mm past the text column`,
        });
      }
    }
  }

  // Content past the bottom of the text area (geometry, phase 1).
  if (model.page && typeof model.page.contentHeight === "number") {
    const maxBottom = model.page.marginTop + model.page.contentHeight;
    for (const e of els) {
      const g =
        e.kind === "table" || e.kind === "paragraph" ? e.geometry : undefined;
      if (!g || typeof g.bottom !== "number") continue;
      if (g.bottom > maxBottom + 1) {
        findings.push({
          code: "PAGE_OVERFLOW",
          severity: "advisory",
          nodeId: nodeIdOf(e),
          message: `Content extends past the text area (${g.bottom.toFixed(1)}mm > ${maxBottom.toFixed(1)}mm)`,
        });
      }
    }
  }

  // Header / footer overlapping the body (geometry, phase 1).
  if (model.page) {
    const h = model.header;
    if (h) {
      if (
        typeof h.bottom === "number" &&
        h.bottom > model.page.marginTop + 0.5
      ) {
        findings.push({
          code: "HEADER_OVERLAP",
          severity: "advisory",
          nodeId: "header",
          message: `Header extends into the body (${h.bottom.toFixed(1)}mm > top margin ${model.page.marginTop.toFixed(1)}mm)`,
        });
      }
      if (typeof h.top === "number" && h.top < -0.5) {
        findings.push({
          code: "HEADER_CLIPPED",
          severity: "advisory",
          nodeId: "header",
          message: `Header starts above the page top (${h.top.toFixed(1)}mm)`,
        });
      }
    }
    const f = model.footer;
    if (f && typeof f.top === "number") {
      const limit = model.page.height - model.page.marginBottom;
      if (f.top < limit - 0.5) {
        findings.push({
          code: "FOOTER_OVERLAP",
          severity: "advisory",
          nodeId: "footer",
          message: `Footer extends into the body (${f.top.toFixed(1)}mm < ${limit.toFixed(1)}mm)`,
        });
      }
    }
  }

  // Tables and images without a caption.
  for (const e of els) {
    if (e.kind !== "table" && e.kind !== "image") continue;
    if (!e.caption || !CAPTION_RE.test(e.caption)) {
      findings.push({
        code: "MISSING_CAPTION",
        severity: "advisory",
        nodeId: nodeIdOf(e),
        message: `${e.kind === "table" ? "Table" : "Figure"} has no caption`,
      });
    }
  }

  // Several headings but no table of contents.
  const hasToc = els.some((e) => e.kind === "toc");
  if (headingCount >= 3 && !hasToc) {
    findings.push({
      code: "TOC_MISSING",
      severity: "advisory",
      nodeId: "document",
      message: "Document has multiple headings but no table of contents",
    });
  }

  return findings;
};

export type FindingSummary = {
  total: number;
  blocking: number;
  advisory: number;
  byCode: Record<string, number>;
};

export const summarizeFindings = (findings: Finding[]): FindingSummary => ({
  total: findings.length,
  blocking: findings.filter((f) => f.severity === "blocking").length,
  advisory: findings.filter((f) => f.severity === "advisory").length,
  byCode: findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.code] = (acc[f.code] ?? 0) + 1;
    return acc;
  }, {}),
});

export const blockingFindings = (findings: Finding[]): Finding[] =>
  findings.filter((f) => f.severity === "blocking");
