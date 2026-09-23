import type { TMCPItem } from "@/lib/types";

// These identifiers are injected by the editor's plugin host when a
// `callCommand` body is evaluated in the document sandbox. They are ambient
// globals at that point, so they are only declared here for TypeScript.
declare const Api: {
  GetDocument: () => any;
  CreateParagraph: () => any;
  HexColor?: (hex: string) => unknown;
  CreateColorFromRGB?: (r: number, g: number, b: number) => unknown;
};
declare const scope: Record<string, unknown>;

type AscPlugin = {
  executeMethod: (
    name: string,
    args: unknown[],
    callback: (result: unknown) => void
  ) => void;
  callCommand: (
    func: () => unknown,
    isClose: boolean,
    isCalc: boolean,
    callback: (result: unknown) => void
  ) => void;
};

type AscHost = {
  Asc?: {
    plugin?: AscPlugin;
    scope?: Record<string, unknown>;
  };
};

const getPlugin = (): AscPlugin | undefined => {
  const plugin = (window as unknown as AscHost).Asc?.plugin;
  return plugin && typeof plugin.executeMethod === "function"
    ? plugin
    : undefined;
};

// The plugin object exists as soon as plugins.js loads, but executeMethod is
// only defined after the editor host completes the init handshake. Report the
// editor as available based on the plugin object so the tool list is correct
// from the first request; calls made before init simply return an error.
const isPluginPresent = (): boolean =>
  Boolean((window as unknown as AscHost).Asc?.plugin);

/**
 * Bridge that lets the agent read and modify the document that is currently
 * open in the editor. Available only when the plugin runs inside an editor
 * frame (i.e. `window.Asc.plugin` was initialized by the editor host).
 */
export class EditorDocumentTool {
  isAvailable = (): boolean => isPluginPresent();

  private callMethod = (
    name: string,
    args: unknown[] = []
  ): Promise<unknown> =>
    new Promise((resolve) => {
      const plugin = getPlugin();
      if (!plugin) return resolve({ error: "editor is not available" });
      plugin.executeMethod(name, args, (result) => resolve(result));
    });

  private callEditorCommand = (
    func: () => unknown,
    data: Record<string, unknown> = {}
  ): Promise<unknown> =>
    new Promise((resolve) => {
      const plugin = getPlugin();
      if (!plugin) return resolve({ error: "editor is not available" });
      const host = window as unknown as { Asc: { scope: Record<string, unknown> } };
      host.Asc.scope = data;
      plugin.callCommand(func, false, false, (result) => resolve(result));
    });

  getSelection = async () =>
    this.callMethod("GetSelectedText", [{ Numbering: false }]);

  getSelectionHtml = async () =>
    this.callMethod("GetSelectedContent", [{ type: "html" }]);

  replaceSelection = async (text: string) =>
    this.callMethod("ReplaceTextSmart", [[text]]);

  insertContent = async (
    text: string,
    style: Record<string, unknown> = {}
  ) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var p = Api.CreateParagraph();
      p.AddText(scope.text);
      if (typeof scope.bold === "boolean") p.SetBold(scope.bold);
      if (typeof scope.italic === "boolean") p.SetItalic(scope.italic);
      if (scope.color) {
        var c = scope.color;
        if (typeof c === "string" && typeof Api.HexColor === "function")
          c = Api.HexColor(c);
        p.SetColor(c);
      }
      if (scope.fontSize) p.SetFontSize(scope.fontSize);
      doc.InsertContent([p]);
      return true;
    }, { text, ...style });

  applyStyle = async (style: Record<string, unknown>) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var target = doc.GetRangeBySelect();
      var selected =
        target && typeof target.GetText === "function" ? target.GetText() : "";

      // Only style actual selected text. Reporting success on an empty
      // selection would make the model believe the formatting was applied.
      if (!selected) return false;

      if (typeof scope.bold === "boolean") target.SetBold(scope.bold);
      if (typeof scope.italic === "boolean") target.SetItalic(scope.italic);
      if (scope.color) {
        var c = scope.color;
        if (typeof c === "string" && typeof Api.HexColor === "function")
          c = Api.HexColor(c);
        target.SetColor(c);
      }
      if (scope.fontSize) target.SetFontSize(scope.fontSize);
      return true;
    }, style);

  clearDocument = async () =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var count =
        typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
      for (var i = count - 1; i >= 0; i--) {
        var el = doc.GetElement(i);
        if (el && typeof el.Delete === "function") el.Delete();
      }
      return true;
    });

  // Inserts rich HTML at the cursor. The editor parses semantic HTML into
  // real styles (headings, lists, tables, bold/italic), which is how a
  // designed document is produced.
  insertHtml = async (html: string) => this.callMethod("PasteHtml", [html]);

  // Returns the whole document as HTML so the agent can review its own output.
  getDocumentHtml = async () =>
    this.callMethod("ConvertDocument", ["html", true, false, false, false]);

  // Applies a named style (e.g. "Heading 1", "Title") to the selection or the
  // paragraph at the cursor. Use this to give headings a real style.
  setParagraphStyle = async (name: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var style = typeof doc.GetStyle === "function" ? doc.GetStyle(scope.name) : null;
      if (!style) return false;
      var target = doc.GetRangeBySelect();
      if (target && typeof target.SetStyle === "function") {
        target.SetStyle(style);
        return true;
      }
      var p =
        typeof doc.GetCurrentParagraph === "function"
          ? doc.GetCurrentParagraph()
          : null;
      if (!p) return false;
      p.SetStyle(style);
      return true;
    }, { name });

  // Aligns the current paragraph (left | center | right | justify).
  setAlignment = async (align: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var jc = scope.align === "justify" ? "both" : scope.align;
      var p =
        typeof doc.GetCurrentParagraph === "function"
          ? doc.GetCurrentParagraph()
          : null;
      if (p && typeof p.SetJc === "function") {
        p.SetJc(jc);
        return true;
      }
      return false;
    }, { align });

  // Sets the text color of the selection, or of the paragraph at the cursor.
  setTextColor = async (color: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var c = scope.color;
      if (typeof c === "string" && typeof Api.HexColor === "function")
        c = Api.HexColor(c);
      var target = doc.GetRangeBySelect();
      var selected =
        target && typeof target.GetText === "function" ? target.GetText() : "";
      if (selected && typeof target.SetColor === "function") {
        target.SetColor(c);
        return true;
      }
      var p =
        typeof doc.GetCurrentParagraph === "function"
          ? doc.GetCurrentParagraph()
          : null;
      if (p && typeof p.SetColor === "function") {
        p.SetColor(c);
        return true;
      }
      return false;
    }, { color });

  // Inserts a page break.
  insertPageBreak = async () =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var p = Api.CreateParagraph();
      if (typeof p.SetPageBreakBefore === "function") p.SetPageBreakBefore(true);
      doc.InsertContent([p]);
      return true;
    });

  // Applies a visual theme by restyling the document's Title and Heading
  // styles, so headings inserted as HTML inherit the accent color.
  applyTheme = async (accent: string, fontFamily?: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var names = ["Title", "Heading 1", "Heading 2", "Heading 3", "Heading 4"];
      var color = scope.accent;
      if (typeof color === "string" && typeof Api.HexColor === "function")
        color = Api.HexColor(color);

      var changed = 0;
      for (var i = 0; i < names.length; i++) {
        var style =
          typeof doc.GetStyle === "function" ? doc.GetStyle(names[i]) : null;
        if (!style || typeof style.GetTextPr !== "function") continue;
        var tp = style.GetTextPr();
        if (tp && typeof tp.SetColor === "function") {
          tp.SetColor(color);
          changed++;
        }
        if (scope.fontFamily && tp && typeof tp.SetFontFamily === "function") {
          tp.SetFontFamily(scope.fontFamily);
        }
      }
      return changed;
    }, { accent, fontFamily });

  // Deterministic rule enforcement: set the font used for a script across the
  // whole document so font rules are guaranteed, not just suggested.
  enforceFont = async (script: string, font: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var ranges = { khm: [0x1780, 0x17ff], lao: [0x0e80, 0x0eff] };
      var range = ranges[scope.script] || null;
      if (!range) return 0;

      var count =
        typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
      var changed = 0;

      for (var i = 0; i < count; i++) {
        var p = doc.GetElement(i);
        var runs =
          p && typeof p.GetElementsCount === "function"
            ? p.GetElementsCount()
            : 0;
        for (var j = 0; j < runs; j++) {
          var run = p.GetElement(j);
          if (!run || typeof run.GetText !== "function") continue;
          var text = run.GetText() || "";
          var hit = false;
          for (var k = 0; k < text.length; k++) {
            var code = text.charCodeAt(k);
            if (code >= range[0] && code <= range[1]) {
              hit = true;
              break;
            }
          }
          if (hit && typeof run.SetFontFamily === "function") {
            run.SetFontFamily(scope.font);
            changed++;
          }
        }
      }
      return changed;
    }, { script, font });

  // Inserts a dynamic table of contents (built from the document heading
  // styles, with page numbers and hyperlinks).
  insertTableOfContents = async () =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      if (typeof doc.AddTableOfContents !== "function") return false;
      doc.AddTableOfContents({
        ShowPageNums: true,
        RightAlgn: true,
        FormatAsLinks: true,
        LeaderType: "dot",
        BuildFrom: { OutlineLvls: 9 },
      });
      return true;
    });

  // Adds a caption (e.g. "Table 1", "Figure 2") to the paragraph at the cursor.
  addCaption = async (text: string, label: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var p =
        typeof doc.GetCurrentParagraph === "function"
          ? doc.GetCurrentParagraph()
          : null;
      if (!p || typeof p.AddCaption !== "function") return false;
      return p.AddCaption(scope.text || "", scope.label || "Table", false) !== false;
    }, { text, label });

  // Inserts an image (URL or base64) as its own paragraph, optionally centered.
  insertImage = async (
    src: string,
    width: number,
    height: number,
    align: string
  ) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var image = Api.CreateImage(scope.src, scope.width, scope.height);
      var p = Api.CreateParagraph();
      if (typeof p.AddDrawing === "function") p.AddDrawing(image);
      if (scope.align && typeof p.SetJc === "function") p.SetJc(scope.align);
      doc.InsertContent([p]);
      return true;
    }, { src, width, height, align: align === "justify" ? "center" : align });

  // Fits the target table to the page width or to its contents, optionally
  // centering it. tableIndex defaults to the last table.
  fitTable = async (mode: string, center: boolean, tableIndex?: number) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var tables =
        typeof doc.GetAllTables === "function" ? doc.GetAllTables() : [];
      if (!tables || !tables.length) return false;
      var idx =
        typeof scope.tableIndex === "number"
          ? scope.tableIndex
          : tables.length - 1;
      var table = tables[idx];
      if (!table) return false;

      if (scope.mode === "page") {
        if (typeof table.SetWidth === "function") table.SetWidth("percent", 100);
        if (typeof table.SetTableLayout === "function")
          table.SetTableLayout("autofit");
      } else if (scope.mode === "contents") {
        if (typeof table.SetTableLayout === "function")
          table.SetTableLayout("autofit");
      }
      if (scope.center && typeof table.SetJc === "function")
        table.SetJc("center");
      return true;
    }, { mode, center, tableIndex });

  // Sets paragraph spacing (before/after in points, line spacing multiplier).
  setParagraphSpacing = async (
    before?: number,
    after?: number,
    line?: number
  ) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var p =
        typeof doc.GetCurrentParagraph === "function"
          ? doc.GetCurrentParagraph()
          : null;
      if (!p) return false;
      if (typeof scope.before === "number" && p.SetSpacingBefore)
        p.SetSpacingBefore(scope.before);
      if (typeof scope.after === "number" && p.SetSpacingAfter)
        p.SetSpacingAfter(scope.after);
      if (typeof scope.line === "number" && p.SetSpacing)
        p.SetSpacing(scope.line);
      return true;
    }, { before, after, line });

  // Keeps the current paragraph with the next one (and keeps its lines
  // together) so headings are not orphaned at the bottom of a page.
  keepWithNext = async (enabled: boolean) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var p =
        typeof doc.GetCurrentParagraph === "function"
          ? doc.GetCurrentParagraph()
          : null;
      if (!p || typeof p.SetKeepNext !== "function") return false;
      p.SetKeepNext(!!scope.enabled);
      if (typeof p.SetKeepLines === "function") p.SetKeepLines(!!scope.enabled);
      return true;
    }, { enabled });

  // Sets the page margins (in points) for the document. The builder API works
  // in twips (1/1440 inch), so the values are converted.
  setPageMargins = async (
    left: number,
    top: number,
    right: number,
    bottom: number
  ) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var toTwips = function (pt) {
        return Math.round(pt * 20);
      };
      var l = toTwips(scope.left);
      var t = toTwips(scope.top);
      var r = toTwips(scope.right);
      var b = toTwips(scope.bottom);

      var sections =
        typeof doc.GetSections === "function" ? doc.GetSections() : null;

      if (sections && sections.length) {
        for (var i = 0; i < sections.length; i++) {
          if (typeof sections[i].SetPageMargins === "function")
            sections[i].SetPageMargins(l, t, r, b);
        }
        return true;
      }

      var section =
        typeof doc.GetFinalSection === "function"
          ? doc.GetFinalSection()
          : null;
      if (!section || typeof section.SetPageMargins !== "function") return false;
      section.SetPageMargins(l, t, r, b);
      return true;
    }, { left, top, right, bottom });

  getDocumentText = async () =>
    this.callEditorCommand(function () {
      return Api.GetDocument().GetText();
    });

  getStyles = async () =>
    this.callEditorCommand(function () {
      var all = Api.GetDocument().GetAllStyles() || {};
      var names = [];
      for (var k in all) {
        if (Object.prototype.hasOwnProperty.call(all, k)) {
          names.push(all[k].GetName ? all[k].GetName() : k);
        }
      }
      return names;
    });

  snapshotPage = async (page: number) =>
    this.callMethod("GetPageImage", [
      page,
      { maxSize: 1200, annotations: true, fields: true },
    ]);

  getTools = (): TMCPItem[] => {
    if (!this.isAvailable()) return [];
    return [
      {
        name: "get_selection",
        description:
          "Return the text currently selected in the open document.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_selection_html",
        description:
          "Return the HTML of the current selection, including formatting.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "replace_selection",
        description:
          "Replace the selected paragraph(s) in the open document with new text. Use this to rewrite, correct or improve the current selection in place.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Replacement text." },
          },
          required: ["text"],
        },
      },
      {
        name: "insert_content",
        description:
          "Insert a new paragraph with the given text at the cursor in the open document. Apply formatting (bold, italic, color, fontSize) in the same call - prefer this over a separate apply_style call.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            bold: { type: "boolean" },
            italic: { type: "boolean" },
            color: { type: "string", description: "Hex color, e.g. #1F3864" },
            fontSize: { type: "number" },
          },
          required: ["text"],
        },
      },
      {
        name: "apply_style",
        description:
          "Apply character formatting to the current selection, or to the paragraph at the cursor when nothing is selected.",
        inputSchema: {
          type: "object",
          properties: {
            bold: { type: "boolean" },
            italic: { type: "boolean" },
            color: { type: "string", description: "Hex color, e.g. #C00000" },
            fontSize: { type: "number" },
          },
        },
      },
      {
        name: "clear_document",
        description:
          "Delete all content from the open document. Use this to start over when the document needs to be rebuilt.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "insert_html",
        description:
          "Insert rich HTML at the cursor. PREFER THIS to build a designed document: use <h1>/<h2>/<h3> for headings, <p> for paragraphs, <strong>/<em>, <ul>/<ol><li> for lists, <blockquote>, and <table> (with <thead>/<tbody>/<tr>/<th>/<td>) for data. The editor converts it to real styles.",
        inputSchema: {
          type: "object",
          properties: {
            html: {
              type: "string",
              description: "An HTML fragment to insert.",
            },
          },
          required: ["html"],
        },
      },
      {
        name: "get_document_html",
        description:
          "Return the whole open document as HTML. Use this AFTER building content to review the structure and formatting, then fix anything that looks wrong.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "set_paragraph_style",
        description:
          'Apply a named paragraph style (e.g. "Heading 1", "Heading 2", "Title", "Quote") to the selection or the paragraph at the cursor. Use get_styles to list names.',
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      {
        name: "set_alignment",
        description: "Set the alignment of the current paragraph.",
        inputSchema: {
          type: "object",
          properties: {
            align: {
              type: "string",
              enum: ["left", "center", "right", "justify"],
            },
          },
          required: ["align"],
        },
      },
      {
        name: "set_text_color",
        description:
          "Set the text color (hex, e.g. #1F3864) of the selection, or of the paragraph at the cursor.",
        inputSchema: {
          type: "object",
          properties: { color: { type: "string" } },
          required: ["color"],
        },
      },
      {
        name: "insert_page_break",
        description: "Insert a page break at the cursor.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "enforce_font",
        description:
          "Deterministically set the font for a script across the whole document. script is 'khm' (Khmer) or 'lao' (Lao). Use this to satisfy font rules (e.g. Khmer OS Siemreap for Khmer).",
        inputSchema: {
          type: "object",
          properties: {
            script: { type: "string", enum: ["khm", "lao"] },
            font: { type: "string" },
          },
          required: ["script", "font"],
        },
      },
      {
        name: "apply_document_theme",
        description:
          "Give the document a consistent visual design by setting the accent color (and optional font) of the Title and Heading styles. Call this at the START of building a document, before inserting content, so headings inherit the design. Example accent: #1F3864.",
        inputSchema: {
          type: "object",
          properties: {
            accent: { type: "string", description: "Hex color, e.g. #1F3864" },
            fontFamily: { type: "string" },
          },
          required: ["accent"],
        },
      },
      {
        name: "insert_table_of_contents",
        description:
          "Insert a DYNAMIC table of contents (built from the document's Heading styles, with page numbers and links). Insert it after the title block once the headings exist. Requires content to use real headings (h1/h2/h3).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "add_caption",
        description:
          'Add a numbered caption (e.g. "Table 3", "Figure 1") to the paragraph at the cursor - use it under tables and images.',
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Caption text." },
            label: {
              type: "string",
              description: 'Caption label, e.g. "Table" or "Figure".',
            },
          },
          required: ["text", "label"],
        },
      },
      {
        name: "insert_image",
        description:
          "Insert an image (URL or data URI) as its own paragraph. Provide width/height in points and an alignment.",
        inputSchema: {
          type: "object",
          properties: {
            src: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
            align: {
              type: "string",
              enum: ["left", "center", "right"],
            },
          },
          required: ["src", "width", "height"],
        },
      },
      {
        name: "fit_table",
        description:
          'Adjust a table to the page: mode "page" stretches it to the full page width (use for wide data tables), mode "contents" shrinks it to fit its contents (use for small tables). Set center=true to center it.',
        inputSchema: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["page", "contents"] },
            center: { type: "boolean" },
            tableIndex: {
              type: "number",
              description: "0-based table index; defaults to the last table.",
            },
          },
          required: ["mode"],
        },
      },
      {
        name: "set_paragraph_spacing",
        description:
          "Set spacing for the paragraph at the cursor: before/after in points and line spacing multiplier. Use consistent spacing instead of blank paragraphs to control empty space.",
        inputSchema: {
          type: "object",
          properties: {
            before: { type: "number" },
            after: { type: "number" },
            line: { type: "number" },
          },
        },
      },
      {
        name: "keep_with_next",
        description:
          "Keep the paragraph at the cursor with the following paragraph (and keep its lines together). Use on headings and captions so they are not orphaned at the bottom of a page.",
        inputSchema: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
      {
        name: "set_page_margins",
        description:
          "Set the page margins in POINTS (left, top, right, bottom) for the document. Typical values: 56 pt (2 cm) or 72 pt (1 inch).",
        inputSchema: {
          type: "object",
          properties: {
            left: { type: "number" },
            top: { type: "number" },
            right: { type: "number" },
            bottom: { type: "number" },
          },
          required: ["left", "top", "right", "bottom"],
        },
      },
      {
        name: "get_document_text",
        description: "Return the full plain text of the open document.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_styles",
        description:
          "Return the names of all styles available in the open document.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snapshot_page",
        description:
          "Return a PNG snapshot (data URL) of a page. Works for PDF documents.",
        inputSchema: {
          type: "object",
          properties: { page: { type: "number" } },
        },
      },
    ];
  };

  callTools = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<string> => {
    let result: unknown;
    switch (name) {
      case "get_selection":
        result = await this.getSelection();
        break;
      case "get_selection_html":
        result = await this.getSelectionHtml();
        break;
      case "replace_selection":
        result = await this.replaceSelection(String(args.text ?? ""));
        break;
      case "insert_content":
        result = await this.insertContent(String(args.text ?? ""), args);
        break;
      case "apply_style":
        result = await this.applyStyle(args);
        break;
      case "clear_document":
        result = await this.clearDocument();
        break;
      case "insert_html":
        result = await this.insertHtml(String(args.html ?? ""));
        break;
      case "get_document_html":
        result = await this.getDocumentHtml();
        break;
      case "set_paragraph_style":
        result = await this.setParagraphStyle(String(args.name ?? ""));
        break;
      case "set_alignment":
        result = await this.setAlignment(String(args.align ?? "left"));
        break;
      case "set_text_color":
        result = await this.setTextColor(String(args.color ?? ""));
        break;
      case "insert_page_break":
        result = await this.insertPageBreak();
        break;
      case "enforce_font":
        result = await this.enforceFont(
          String(args.script ?? ""),
          String(args.font ?? "")
        );
        break;
      case "apply_document_theme":
        result = await this.applyTheme(
          String(args.accent ?? ""),
          args.fontFamily ? String(args.fontFamily) : undefined
        );
        break;
      case "insert_table_of_contents":
        result = await this.insertTableOfContents();
        break;
      case "add_caption":
        result = await this.addCaption(
          String(args.text ?? ""),
          String(args.label ?? "Table")
        );
        break;
      case "insert_image":
        result = await this.insertImage(
          String(args.src ?? ""),
          Number(args.width ?? 400),
          Number(args.height ?? 300),
          String(args.align ?? "center")
        );
        break;
      case "fit_table":
        result = await this.fitTable(
          String(args.mode ?? "contents"),
          Boolean(args.center),
          typeof args.tableIndex === "number" ? args.tableIndex : undefined
        );
        break;
      case "set_paragraph_spacing":
        result = await this.setParagraphSpacing(
          typeof args.before === "number" ? args.before : undefined,
          typeof args.after === "number" ? args.after : undefined,
          typeof args.line === "number" ? args.line : undefined
        );
        break;
      case "keep_with_next":
        result = await this.keepWithNext(Boolean(args.enabled));
        break;
      case "set_page_margins":
        result = await this.setPageMargins(
          Number(args.left ?? 56),
          Number(args.top ?? 56),
          Number(args.right ?? 56),
          Number(args.bottom ?? 56)
        );
        break;
      case "get_document_text":
        result = await this.getDocumentText();
        break;
      case "get_styles":
        result = await this.getStyles();
        break;
      case "snapshot_page":
        result = await this.snapshotPage(Number(args.page ?? 0));
        break;
      default:
        result = { error: `unknown editor tool: ${name}` };
    }
    return typeof result === "string" ? result : JSON.stringify(result);
  };
}
