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

  insertContent = async (text: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var p = Api.CreateParagraph();
      p.AddText(scope.text);
      doc.InsertContent([p]);
      return true;
    }, { text });

  applyStyle = async (style: Record<string, unknown>) =>
    this.callEditorCommand(function () {
      var range = Api.GetDocument().GetRangeBySelect();
      if (!range) return false;
      if (typeof scope.bold === "boolean") range.SetBold(scope.bold);
      if (typeof scope.italic === "boolean") range.SetItalic(scope.italic);
      if (scope.color) {
        var col = scope.color;
        if (typeof col === "string") {
          if (typeof Api.HexColor === "function") col = Api.HexColor(col);
        }
        range.SetColor(col);
      }
      if (scope.fontSize) range.SetFontSize(scope.fontSize);
      return true;
    }, style);

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
          "Insert a new paragraph with the given text at the cursor in the open document.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        name: "apply_style",
        description:
          "Apply character formatting to the current selection in the open document.",
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
        result = await this.insertContent(String(args.text ?? ""));
        break;
      case "apply_style":
        result = await this.applyStyle(args);
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
