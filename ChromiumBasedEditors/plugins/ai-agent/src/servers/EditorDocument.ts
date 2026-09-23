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
