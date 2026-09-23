# Agent Document Snapshot (`tysastra.agent.doc`)

The feedback contract the agent uses to *observe* the open document and verify
its own edits. Emitted by the editor from its live model — no PDF, raster, or
file round-trip. Phase 0 emits structure and provenance (no page geometry yet).

## Envelope

```jsonc
{
  "schema": "tysastra.agent.doc/1.0",
  "coverage": {
    "pagination": "absent",          // unknown | partial | complete | absent
    "text_geometry": "absent",
    "resolved_typography": "partial",
    "table_geometry": "partial",
    "drawing_appearance": "absent",
    "header_footer": "absent"
  },
  "summary": { "total": 0, "blocking": 0, "advisory": 0, "byCode": {} },
  "findings": [ /* Finding */ ],
  "nodes": [ /* Node, bounded */ ]
}
```

Consumers must ignore unknown fields within a compatible major version.

## Node

A bounded, structural view keyed by `nodeId`. Paragraphs use the editor's
durable paragraph id: `paragraph:<paraId>` (from `ApiParagraph.GetParaId()`,
which survives edits), falling back to `paragraph:<index>`. Tables and other
nodes use `<kind>:<index>`.

```jsonc
// paragraph
{ "kind": "paragraph", "index": 4, "style": "Heading 1", "text": "1.\tSummary",
  "numbering": true,
  "runs": [ { "text": "Summary", "font": "Calibri", "size": 18,
              "color": "#1b4965", "bold": true, "italic": false,
              "direct": false } ] }

// table
{ "kind": "table", "index": 5, "rows": 5, "cols": 3,
  "headerShaded": true, "caption": "Table 1. Main greenhouse gases." }

// image
{ "kind": "image", "index": 9, "caption": "Figure 1. Decadal anomaly." }

// table of contents
{ "kind": "toc", "index": 2 }
```

`direct` marks a run whose font/size/colour differs from its paragraph style
(i.e. direct formatting overriding the style).

## Finding

```jsonc
{ "code": "DOUBLE_NUMBERING", "severity": "blocking",
  "nodeId": "paragraph:6", "message": "...", "evidence": { } }
```

Severity is `blocking` or `advisory`. Every finding carries the `nodeId` of the
offending node so the agent can act on it directly.

## Finding codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `DOUBLE_NUMBERING` | blocking | automatic numbering plus a manual number in the heading text |
| `EMPTY_SECTION` | blocking | a Heading 1 with no content before the next Heading 1 |
| `DIRECT_FORMAT_OVERRIDE` | advisory | run formatting differs from the named style |
| `MISSING_CAPTION` | advisory | a table or image has no caption |
| `TOC_MISSING` | advisory | several headings but no table of contents |
| `HEADING_LEVEL_SKIP` | advisory | heading levels jump (e.g. Heading 1 -> Heading 3) |
| `ORPHAN_HEADING` | advisory | a heading ends a page; its content starts on the next page |
| `STYLE_UNUSED` | advisory | a defined style that no content uses |

Phase 1 adds geometry: paragraphs may carry
`geometry = { absPage, pagesCount, linesCount, top, bottom, left, right }`
(measurements in mm) from the editor engine; `coverage.pagination` /
`coverage.text_geometry` become `partial` when present.

Phase 1 adds geometry-based codes: `PAGE_OVERFLOW`, `COLUMN_OVERFLOW`,
`HEADER_OVERLAP`, `HEADER_CLIPPED`, `TABLE_WIDTH_OVERFLOW`, `CELL_TEXT_CLIPPED`,
`ORPHAN_HEADING`, `WIDOW_LINE`, `FONT_SUBSTITUTED`.

## Tool

`get_document_feedback({ scope?, detail?, includeGeometry? })` returns the
envelope above. The orchestration also calls it internally after edits to decide
whether a repair pass is needed (findings-driven review).

## Diff (phase 2)

`diff(before, after)` returns `{ addedNodes, removedNodes, changedNodes,
newFindings, clearedFindings }`, keyed by `nodeId`.
