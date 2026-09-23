import {
  computeFindings,
  summarizeFindings,
  type DocElement,
  type DocModel,
} from "@/lib/agentFindings";
import {
  diffSnapshots,
  summarizeDiff,
  type AgentSnapshot,
} from "@/lib/agentDiff";
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
  // Accent color of the active theme, remembered so newly inserted headings can
  // be colored (HTML paste forces a black run color that overrides the style).
  private themeAccent?: string;

  // Feedback snapshots for get_document_diff: current is the last snapshot,
  // previous is the one before it.
  private previousSnapshot?: AgentSnapshot;
  private currentSnapshot?: AgentSnapshot;

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
  // Inserts rich HTML at the cursor, then recolors any headings to match the
  // active theme (HTML paste forces a direct black run color).
  insertHtml = async (html: string) => {
    // The editor's HTML paste drops <br>, which merges intended line breaks
    // (an address, a signature block) onto one line. Turn them into paragraph
    // breaks first so the line structure survives.
    const normalized = String(html).replace(/<br\s*\/?>/gi, "</p><p>");
    const result = await this.callMethod("PasteHtml", [normalized]);

    // Make the named styles authoritative over the paste's direct formatting.
    await this.conformToStyles();

    return result;
  };

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

  // Applies a visual theme: restyle the Title/Heading styles AND recolor the
  // runs of existing heading paragraphs (HTML paste writes a direct black run
  // color that overrides the style, so the style alone is not enough).
  applyTheme = async (accent: string, fontFamily?: string) => {
    this.themeAccent = accent;

    return this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var names = [
        "Title",
        "Heading 1",
        "Heading 2",
        "Heading 3",
        "Heading 4",
        "Heading 5",
        "Heading 6",
        "Heading 7",
        "Heading 8",
        "Heading 9",
      ];
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
        // Write the modified properties back (GetTextPr returns a copy).
        if (typeof style.SetTextPr === "function") style.SetTextPr(tp);
      }

      var total =
        typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
      for (var k = 0; k < total; k++) {
        var p = doc.GetElement(k);
        var st = p && typeof p.GetStyle === "function" ? p.GetStyle() : null;
        var name = st && typeof st.GetName === "function" ? st.GetName() : "";
        if (!name || !/^(Title|Heading [1-9])$/.test(name)) continue;
        var runs = typeof p.GetElementsCount === "function" ? p.GetElementsCount() : 0;
        for (var r = 0; r < runs; r++) {
          var run = p.GetElement(r);
          if (run && typeof run.SetColor === "function") {
            run.SetColor(color);
            changed++;
          }
        }
      }

      return changed;
    }, { accent, fontFamily });
  };

  // Colors the runs of heading paragraphs with the given accent. Used after
  // inserting HTML so new headings match the theme.
  colorHeadings = async (accent: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var color = scope.accent;
      if (typeof color === "string" && typeof Api.HexColor === "function")
        color = Api.HexColor(color);

      var changed = 0;
      var total =
        typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
      for (var k = 0; k < total; k++) {
        var p = doc.GetElement(k);
        var st = p && typeof p.GetStyle === "function" ? p.GetStyle() : null;
        var name = st && typeof st.GetName === "function" ? st.GetName() : "";
        if (!name || !/^(Title|Heading [1-9])$/.test(name)) continue;
        var runs = typeof p.GetElementsCount === "function" ? p.GetElementsCount() : 0;
        for (var r = 0; r < runs; r++) {
          var run = p.GetElement(r);
          if (run && typeof run.SetColor === "function") {
            run.SetColor(color);
            changed++;
          }
        }
      }
      return changed;
    }, { accent });

  // Copies each paragraph style's font, size and colour onto its runs. The
  // editor attaches direct formatting on paste (which overrides the named
  // styles), so this makes the styles authoritative without styling each piece
  // of content in the HTML.
  conformToStyles = async () =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      if (typeof doc.GetStyle !== "function") return 0;
      var cache: Record<string, unknown> = {};
      function textPrFor(name: string) {
        if (cache[name] !== undefined) return cache[name];
        var s = doc.GetStyle(name);
        cache[name] = s && typeof s.GetTextPr === "function" ? s.GetTextPr() : null;
        return cache[name];
      }
      function hexOf(tp: any) {
        if (!tp || typeof tp.GetColor !== "function") return null;
        var c = tp.GetColor();
        if (!c) return null;
        var r: number | undefined;
        var g: number | undefined;
        var b: number | undefined;
        if (typeof c.GetRGB === "function") {
          var o = c.GetRGB();
          if (o) {
            r = o.r;
            g = o.g;
            b = o.b;
          }
        } else if (typeof c.value === "number") {
          var v = c.value;
          r = (v >> 16) & 255;
          g = (v >> 8) & 255;
          b = v & 255;
        }
        if (r === undefined || g === undefined || b === undefined) return null;
        var h2 = function (x: number) {
          var s = x.toString(16);
          return s.length < 2 ? "0" + s : s;
        };
        return "#" + h2(r) + h2(g) + h2(b);
      }

      var n = doc.GetElementsCount ? doc.GetElementsCount() : 0;
      var changed = 0;
      for (var i = 0; i < n; i++) {
        var p = doc.GetElement(i);
        var st = p && typeof p.GetStyle === "function" ? p.GetStyle() : null;
        var name = st && typeof st.GetName === "function" ? st.GetName() : "";
        if (!name) name = "Normal";
        var tp: any = textPrFor(name);
        if (!tp) continue;
        var hexColor = hexOf(tp);
        var fam =
          typeof tp.GetFontFamily === "function"
            ? tp.GetFontFamily("ascii")
            : null;
        var size =
          typeof tp.GetFontSize === "function" ? Number(tp.GetFontSize()) : 0;

        var runs = p.GetElementsCount ? p.GetElementsCount() : 0;
        for (var r = 0; r < runs; r++) {
          var run: any = p.GetElement(r);
          if (!run) continue;
          if (run.GetClassType && run.GetClassType() !== "run") continue;
          if (hexColor && typeof run.SetColor === "function") {
            run.SetColor(Api.HexColor(hexColor));
            changed++;
          }
          if (fam && typeof run.SetFontFamily === "function")
            run.SetFontFamily(fam);
          if (size && typeof run.SetFontSize === "function")
            run.SetFontSize(size);
        }
      }
      return changed;
    });

  // Find and replace text across the document. Use this to repair merged or
  // duplicated text without rebuilding.
  findAndReplace = async (search: string, replace: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      if (typeof doc.SearchAndReplace !== "function") return false;
      return (
        doc.SearchAndReplace({
          searchString: scope.search,
          replaceString: scope.replace,
          matchCase: true,
        }) !== false
      );
    }, { search, replace });

  // Replace the whole text of the paragraph at the given 0-based index. Use
  // get_document_html to find the index of a problematic paragraph.
  setParagraphText = async (index: number, text: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      if (typeof doc.GetElement !== "function") return false;
      var p = doc.GetElement(scope.index);
      if (!p || typeof p.SetText !== "function") return false;
      p.SetText(scope.text);
      return true;
    }, { index, text });

  // Inserts a new paragraph after the paragraph at the given index, optionally
  // with a named style. Use this to split merged paragraphs (e.g. a heading
  // stuck to the previous paragraph).
  insertParagraphAfter = async (
    index: number,
    text: string,
    styleName?: string
  ) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      if (typeof doc.GetElement !== "function") return false;
      var p = doc.GetElement(scope.index);
      if (!p || typeof p.InsertParagraph !== "function") return false;

      var np = Api.CreateParagraph();
      if (scope.style && typeof doc.GetStyle === "function") {
        var st = doc.GetStyle(scope.style);
        if (st && typeof np.SetStyle === "function") np.SetStyle(st);
      }
      np.AddText(scope.text);
      p.InsertParagraph(np, "after", true);
      return true;
    }, { index, text, style: styleName });

  // Applies Word's built-in multilevel numbering to the heading styles so
  // section numbers ("1", "1.1", "1.1.1") are automatic and update when
  // headings move. Do NOT type numbers into the heading text when using this.
  numberHeadings = async () =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();

      // The global Api.CreateNumbering is the presentation bullet factory; the
      // document-level factory returns a multilevel ApiNumbering whose levels
      // can be customised ("%1", "%1.%2", ...).
      var numbering =
        typeof doc.CreateNumbering === "function"
          ? doc.CreateNumbering("numbered")
          : null;
      if (!numbering || typeof numbering.GetLevel !== "function") {
        numbering =
          typeof Api.CreateNumbering === "function"
            ? Api.CreateNumbering("numbered")
            : null;
      }
      if (!numbering || typeof numbering.GetLevel !== "function") return 0;

      var formats = ["%1.", "%1.%2", "%1.%2.%3", "%1.%2.%3.%4"];
      for (var lvl = 0; lvl < formats.length; lvl++) {
        var level = numbering.GetLevel(lvl);
        if (level && typeof level.SetCustomType === "function") {
          level.SetCustomType("decimal", formats[lvl], "left");
        }
      }

      var total =
        typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
      var applied = 0;
      for (var i = 0; i < total; i++) {
        var p = doc.GetElement(i);
        var st = p && typeof p.GetStyle === "function" ? p.GetStyle() : null;
        var name = st && typeof st.GetName === "function" ? st.GetName() : "";
        var match = /^Heading ([1-9])$/.exec(name);
        if (!match) continue;
        var idx = parseInt(match[1], 10) - 1;
        if (idx >= formats.length) continue;

        // Remove any manually typed number ("1.", "2.3)") so the automatic
        // numbering does not double up (e.g. "1.1 1. Introduction").
        var raw = typeof p.GetText === "function" ? p.GetText() : "";
        var stripped = raw.replace(/^\s*\d+(?:\.\d+)*[.)]\s+/, "");
        if (stripped && stripped !== raw && typeof p.SetText === "function") {
          p.SetText(stripped.trim());
        }

        var lvlObj = numbering.GetLevel(idx);
        if (lvlObj && typeof p.SetNumbering === "function") {
          p.SetNumbering(lvlObj);
          applied++;
        }
      }
      return applied;
    });

  // Adds a "Page X of Y" page-number field to the document footer.
  addPageNumbers = async () =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var sections =
        typeof doc.GetSections === "function" ? doc.GetSections() : null;
      if (!sections || !sections.length) return false;

      var section = sections[0];
      if (typeof section.GetFooter !== "function") return false;
      var footer = section.GetFooter("default", true);
      if (!footer) return false;

      var p = Api.CreateParagraph();
      if (typeof p.SetJc === "function") p.SetJc("center");
      if (typeof p.AddText === "function") p.AddText("Page ");
      if (typeof p.AddPageNumber === "function") p.AddPageNumber();
      if (typeof p.AddText === "function") p.AddText(" of ");
      if (typeof p.AddPagesCount === "function") p.AddPagesCount();

      footer.Push(p);
      return true;
    });

  // One-shot document setup: theme (named styles) + page margins + footer page
  // numbers, in a single editor call so the agent does not need three rounds.
  setupDocument = async (accent: string, fontFamily?: string, marginsPt?: number) => {
    this.themeAccent = accent;
    return this.callEditorCommand(
      function () {
        var doc = Api.GetDocument();
        var font = scope.fontFamily ? String(scope.fontFamily) : undefined;
        var accent = String(scope.accent || "#1B4965");
        var gray = "#5A6B7B";
        // Define the whole style set once. Content then only uses these styles
        // (semantic HTML / named styles), so it does not need per-item styling.
        var defs: Array<Record<string, unknown>> = [
          { name: "Normal", size: 11, color: "#20303C" },
          { name: "Title", size: 28, color: accent, bold: true, after: 6 },
          { name: "Subtitle", size: 14, color: gray, italic: true, after: 12 },
          { name: "Heading 1", size: 18, color: accent, bold: true, before: 16, after: 6, keep: true },
          { name: "Heading 2", size: 15, color: accent, bold: true, before: 12, after: 4, keep: true },
          { name: "Heading 3", size: 13, color: accent, bold: true, before: 10, after: 4, keep: true },
          { name: "Heading 4", size: 12, color: accent, bold: true, before: 8, after: 3, keep: true },
          { name: "Heading 5", size: 11.5, color: accent, bold: true, keep: true },
          { name: "Heading 6", size: 11, color: accent, bold: true, keep: true },
          { name: "Heading 7", size: 11, color: accent, bold: true },
          { name: "Heading 8", size: 11, color: accent, bold: true },
          { name: "Heading 9", size: 11, color: accent, bold: true },
          { name: "Quote", size: 11, color: gray, italic: true },
          { name: "Caption", size: 9, color: gray, italic: true, before: 2, after: 10 },
        ];

        for (var di = 0; di < defs.length; di++) {
          var def = defs[di];
          var style =
            typeof doc.GetStyle === "function"
              ? doc.GetStyle(String(def.name))
              : null;
          if (!style) continue;

          if (typeof style.GetTextPr === "function") {
            var tp = style.GetTextPr();
            if (tp && typeof tp.SetColor === "function")
              tp.SetColor(Api.HexColor(String(def.color)));
            if (font && tp && typeof tp.SetFontFamily === "function")
              tp.SetFontFamily(font);
            if (def.size && tp && typeof tp.SetFontSize === "function")
              tp.SetFontSize(Number(def.size));
            if (typeof def.bold === "boolean" && tp && typeof tp.SetBold === "function")
              tp.SetBold(Boolean(def.bold));
            if (typeof def.italic === "boolean" && tp && typeof tp.SetItalic === "function")
              tp.SetItalic(Boolean(def.italic));
            // GetTextPr returns a copy, so it must be written back.
            if (typeof style.SetTextPr === "function") style.SetTextPr(tp);
          }

          if (typeof style.GetParaPr === "function") {
            var pp = style.GetParaPr();
            if (pp) {
              if (typeof def.before === "number" && pp.SetSpacingBefore)
                pp.SetSpacingBefore(Number(def.before));
              if (typeof def.after === "number" && pp.SetSpacingAfter)
                pp.SetSpacingAfter(Number(def.after));
              if (def.keep && pp.SetKeepNext) pp.SetKeepNext(true);
              if (def.keep && pp.SetKeepLines) pp.SetKeepLines(true);
              if (typeof style.SetParaPr === "function") style.SetParaPr(pp);
            }
          }
        }

        var sections =
          typeof doc.GetSections === "function" ? doc.GetSections() : null;

        if (typeof scope.marginsPt === "number" && sections && sections.length) {
          var tw = Math.round(scope.marginsPt * 20);
          for (var s = 0; s < sections.length; s++) {
            if (typeof sections[s].SetPageMargins === "function")
              sections[s].SetPageMargins(tw, tw, tw, tw);
          }
        }

        if (sections && sections.length) {
          var section = sections[0];
          if (typeof section.GetFooter === "function") {
            var footer = section.GetFooter("default", true);
            if (footer) {
              // Keep one base paragraph and reuse it so page numbers do not
              // stack on repeated calls.
              var fguard = 0;
              while (
                typeof footer.RemoveElement === "function" &&
                typeof footer.GetElementsCount === "function" &&
                footer.GetElementsCount() > 1 &&
                fguard < 100
              ) {
                footer.RemoveElement(footer.GetElementsCount() - 1);
                fguard++;
              }
              var fp =
                typeof footer.GetElementsCount === "function" &&
                footer.GetElementsCount() >= 1
                  ? footer.GetElement(0)
                  : Api.CreateParagraph();
              if (
                typeof footer.GetElementsCount === "function" &&
                footer.GetElementsCount() < 1
              )
                footer.Push(fp);
              if (typeof fp.SetText === "function") fp.SetText("");
              if (typeof fp.SetJc === "function") fp.SetJc("center");
              if (typeof fp.AddText === "function") fp.AddText("Page ");
              if (typeof fp.AddPageNumber === "function") fp.AddPageNumber();
              if (typeof fp.AddText === "function") fp.AddText(" of ");
              if (typeof fp.AddPagesCount === "function") fp.AddPagesCount();
            }
          }
        }
        return true;
      },
      { accent, fontFamily, marginsPt }
    );
  };

  // Inserts a title block using the real Title/Subtitle styles, so the document
  // title is not part of the numbered heading sequence.
  insertTitle = async (title: string, subtitle: string, meta: string) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var getStyle = function (n) {
        return typeof doc.GetStyle === "function" ? doc.GetStyle(n) : null;
      };

      var p1 = Api.CreateParagraph();
      p1.AddText(scope.title);
      var ts = getStyle("Title");
      if (ts && typeof p1.SetStyle === "function") p1.SetStyle(ts);
      doc.InsertContent([p1]);

      if (scope.subtitle) {
        var p2 = Api.CreateParagraph();
        p2.AddText(scope.subtitle);
        var ss = getStyle("Subtitle");
        if (ss && typeof p2.SetStyle === "function") p2.SetStyle(ss);
        else if (typeof p2.SetItalic === "function") p2.SetItalic(true);
        doc.InsertContent([p2]);
      }

      if (scope.meta) {
        var p3 = Api.CreateParagraph();
        p3.AddText(scope.meta);
        doc.InsertContent([p3]);
      }
      return true;
    }, { title, subtitle, meta });

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
  // The builder takes EMU (1 pt = 12700 EMU); passing points produced a
  // near-zero-size, invisible image, so the conversion and a verification are
  // done here.
  insertImage = async (
    src: string,
    width: number,
    height: number,
    align: string
  ) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var emuPerPt = 12700;
      var before =
        typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;

      var image = Api.CreateImage(
        scope.src,
        scope.width * emuPerPt,
        scope.height * emuPerPt
      );
      if (!image) return false;

      var p = Api.CreateParagraph();
      if (typeof p.AddDrawing !== "function" || !p.AddDrawing(image))
        return false;
      if (scope.align && typeof p.SetJc === "function") p.SetJc(scope.align);
      doc.InsertContent([p]);

      var after =
        typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
      return after > before;
    }, { src, width, height, align: align === "justify" ? "center" : align });

  // Inserts a real chart. chartType: bar | line | pie | area | scatter.
  // series is an array of numeric series; seriesNames/catNames are labels.
  insertChart = async (
    chartType: string,
    series: number[][],
    seriesNames: string[],
    catNames: string[],
    title: string,
    width: number,
    height: number
  ) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      if (typeof Api.CreateChart !== "function") return false;
      var emuPerPt = 12700;

      // Map friendly names to the chart types this build actually registers.
      var typeMap: Record<string, string> = {
        bar: "bar",
        column: "bar",
        line: "line3D",
        line3d: "line3D",
        area: "area",
        pie: "pie",
        doughnut: "doughnut",
        scatter: "scatter",
      };
      var chartType =
        typeMap[String(scope.chartType || "bar").toLowerCase()] || "bar";

      var chart = Api.CreateChart(
        chartType,
        scope.series,
        scope.seriesNames,
        scope.catNames,
        scope.width * emuPerPt,
        scope.height * emuPerPt,
        24
      );
      if (!chart) return false;
      if (scope.title && typeof chart.SetTitle === "function")
        chart.SetTitle(scope.title, 14, true);

      var p = Api.CreateParagraph();
      if (typeof p.AddDrawing !== "function" || !p.AddDrawing(chart))
        return false;
      if (typeof p.SetJc === "function") p.SetJc("center");
      doc.InsertContent([p]);
      return true;
    }, { chartType, series, seriesNames, catNames, title, width, height });

  // Applies a design to a table: a shaded header row, optional banded rows and
  // bottom borders, with contrasting header text. Defaults to the last table.
  styleTable = async (opts: {
    tableIndex?: number;
    headerFill?: string;
    headerTextColor?: string;
    bandFill?: string;
    bandRows?: boolean;
    borders?: boolean;
    columnWidths?: number[];
    emphasizeLastRows?: number;
    totalFill?: string;
  }) =>
    this.callEditorCommand(function () {
      function hexRgb(hex: string) {
        var h = String(hex || "").replace("#", "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [
          parseInt(h.substr(0, 2), 16) || 0,
          parseInt(h.substr(2, 2), 16) || 0,
          parseInt(h.substr(4, 2), 16) || 0,
        ];
      }
      function setRuns(
        container: any,
        colorHex?: string,
        size?: number,
        bold?: boolean,
        italic?: boolean
      ) {
        var kind = container.GetClassType ? container.GetClassType() : "";
        if (kind === "paragraph") {
          var runs = container.GetElementsCount ? container.GetElementsCount() : 0;
          for (var r = 0; r < runs; r++) {
            var run = container.GetElement(r);
            if (!run) continue;
            if (colorHex && run.SetColor) run.SetColor(Api.HexColor(colorHex));
            if (size && run.SetFontSize) run.SetFontSize(size);
            if (typeof bold === "boolean" && run.SetBold) run.SetBold(bold);
            if (typeof italic === "boolean" && run.SetItalic) run.SetItalic(italic);
          }
          return;
        }
        var n = container.GetElementsCount ? container.GetElementsCount() : 0;
        for (var i = 0; i < n; i++)
          setRuns(container.GetElement(i), colorHex, size, bold, italic);
      }

      var doc = Api.GetDocument();
      var tables =
        typeof doc.GetAllTables === "function" ? doc.GetAllTables() : [];
      if (!tables.length) return false;
      var idx =
        typeof scope.tableIndex === "number" ? scope.tableIndex : tables.length - 1;
      var t = tables[idx];
      if (!t) return false;

      var hf = hexRgb(String(scope.headerFill || "#1B4965"));
      var htx = String(scope.headerTextColor || "#FFFFFF");
      var bf = hexRgb(String(scope.bandFill || "#F2F6FA"));
      var rows = t.GetRowsCount();
      var cols = t.GetRow(0).GetCellsCount();

      t.GetRow(0).SetTableHeader(true);
      for (var c = 0; c < cols; c++) {
        var hc = t.GetCell(0, c);
        hc.SetShd("clear", hf[0], hf[1], hf[2]);
        hc.SetCellMarginTop(70);
        hc.SetCellMarginBottom(70);
        hc.SetCellMarginLeft(120);
        hc.SetCellMarginRight(120);
        setRuns(hc.GetContent(), htx, undefined, true, false);
      }
      var emph =
        typeof scope.emphasizeLastRows === "number"
          ? scope.emphasizeLastRows
          : 0;
      var emphStart = rows - emph;
      var tf = hexRgb(String(scope.totalFill || "#D6E4F0"));

      for (var r = 1; r < rows; r++) {
        for (var cc = 0; cc < cols; cc++) {
          var bc = t.GetCell(r, cc);
          if (r >= emphStart) {
            bc.SetShd("clear", tf[0], tf[1], tf[2]);
          } else if (scope.bandRows && r % 2 === 0) {
            bc.SetShd("clear", bf[0], bf[1], bf[2]);
          }
          bc.SetCellMarginTop(50);
          bc.SetCellMarginBottom(50);
          bc.SetCellMarginLeft(120);
          bc.SetCellMarginRight(120);
          if (scope.borders !== false)
            bc.SetCellBorderBottom("single", 4, 0, 205, 216, 226);
          setRuns(bc.GetContent(), "#20303C", undefined, r >= emphStart, false);
        }
      }

      // Optional per-column widths (array of percentages), applied to every
      // cell in the column so narrow columns (Qty/Unit) stay readable.
      if (Array.isArray(scope.columnWidths)) {
        var widths = scope.columnWidths as unknown[];
        for (var cw = 0; cw < cols && cw < widths.length; cw++) {
          var pct = Number(widths[cw]);
          if (!pct) continue;
          for (var rw = 0; rw < rows; rw++) {
            var wcell = t.GetCell(rw, cw);
            if (wcell && typeof wcell.SetWidth === "function")
              wcell.SetWidth("percent", pct);
          }
        }
      }
      return true;
    }, { ...opts });

  // Inserts a full-width shaded title banner (cover) with a white title and
  // subtitle, plus an optional meta line underneath.
  insertBanner = async (
    title: string,
    subtitle: string,
    meta: string,
    accent: string
  ) => {
    await this.callMethod("PasteHtml", [
      "<table><tbody><tr><td><p>" +
        title +
        "</p><p>" +
        (subtitle || "") +
        "</p></td></tr></tbody></table>",
    ]);
    return this.callEditorCommand(function () {
      function hexRgb(hex: string) {
        var h = String(hex || "").replace("#", "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [
          parseInt(h.substr(0, 2), 16) || 0,
          parseInt(h.substr(2, 2), 16) || 0,
          parseInt(h.substr(4, 2), 16) || 0,
        ];
      }
      function setRuns(
        container: any,
        colorHex?: string,
        size?: number,
        bold?: boolean,
        italic?: boolean
      ) {
        var kind = container.GetClassType ? container.GetClassType() : "";
        if (kind === "paragraph") {
          var runs = container.GetElementsCount ? container.GetElementsCount() : 0;
          for (var r = 0; r < runs; r++) {
            var run = container.GetElement(r);
            if (!run) continue;
            if (colorHex && run.SetColor) run.SetColor(Api.HexColor(colorHex));
            if (size && run.SetFontSize) run.SetFontSize(size);
            if (typeof bold === "boolean" && run.SetBold) run.SetBold(bold);
            if (typeof italic === "boolean" && run.SetItalic) run.SetItalic(italic);
          }
          return;
        }
        var n = container.GetElementsCount ? container.GetElementsCount() : 0;
        for (var i = 0; i < n; i++)
          setRuns(container.GetElement(i), colorHex, size, bold, italic);
      }

      var doc = Api.GetDocument();
      var tables = doc.GetAllTables();
      var t = tables[tables.length - 1];
      var cell = t.GetCell(0, 0);
      var ac = hexRgb(String(scope.accent || "#1B4965"));
      cell.SetShd("clear", ac[0], ac[1], ac[2]);
      if (cell.SetWidth) cell.SetWidth("percent", 100);
      cell.SetCellMarginTop(360);
      cell.SetCellMarginBottom(360);
      cell.SetCellMarginLeft(280);
      cell.SetCellMarginRight(280);
      cell.SetCellBorderTop("single", 12, 0, ac[0], ac[1], ac[2]);
      cell.SetCellBorderBottom("single", 12, 0, ac[0], ac[1], ac[2]);
      cell.SetCellBorderLeft("single", 12, 0, ac[0], ac[1], ac[2]);
      cell.SetCellBorderRight("single", 12, 0, ac[0], ac[1], ac[2]);
      var content = cell.GetContent();
      var pc = content.GetElementsCount();
      for (var pi = 0; pi < pc; pi++) {
        var para = content.GetElement(pi);
        if (para.SetJc) para.SetJc("center");
        setRuns(para, "#FFFFFF", pi === 0 ? 30 : 13, pi === 0, pi === 1);
      }
      if (scope.meta) {
        var mp = Api.CreateParagraph();
        mp.AddText(String(scope.meta));
        if (mp.SetJc) mp.SetJc("center");
        var runs = mp.GetElementsCount();
        for (var r = 0; r < runs; r++) {
          var run = mp.GetElement(r);
          if (run && run.SetColor) {
            run.SetColor(Api.HexColor("#5A6B7B"));
            run.SetFontSize(11);
            run.SetItalic(true);
          }
        }
        doc.InsertContent([mp]);
      }
      var t2 = doc.GetAllTables();
      var tb = t2[t2.length - 1];
      if (tb && tb.SetWidth) tb.SetWidth("percent", 100);
      return true;
    }, { accent, meta });
  };

  // Inserts a shaded callout box with a thick accent bar on the left.
  insertCallout = async (text: string, accent: string) => {
    await this.callMethod("PasteHtml", [
      "<table><tbody><tr><td><p>" + text + "</p></td></tr></tbody></table>",
    ]);
    return this.callEditorCommand(function () {
      function hexRgb(hex: string) {
        var h = String(hex || "").replace("#", "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [
          parseInt(h.substr(0, 2), 16) || 0,
          parseInt(h.substr(2, 2), 16) || 0,
          parseInt(h.substr(4, 2), 16) || 0,
        ];
      }
      function setRuns(container: any, colorHex?: string, size?: number) {
        var kind = container.GetClassType ? container.GetClassType() : "";
        if (kind === "paragraph") {
          var runs = container.GetElementsCount ? container.GetElementsCount() : 0;
          for (var r = 0; r < runs; r++) {
            var run = container.GetElement(r);
            if (!run) continue;
            if (colorHex && run.SetColor) run.SetColor(Api.HexColor(colorHex));
            if (size && run.SetFontSize) run.SetFontSize(size);
          }
          return;
        }
        var n = container.GetElementsCount ? container.GetElementsCount() : 0;
        for (var i = 0; i < n; i++) setRuns(container.GetElement(i), colorHex, size);
      }

      var doc = Api.GetDocument();
      var tables = doc.GetAllTables();
      var t = tables[tables.length - 1];
      var cell = t.GetCell(0, 0);
      var ac = hexRgb(String(scope.accent || "#1B4965"));
      var li = hexRgb("#E4EEF6");
      cell.SetShd("clear", li[0], li[1], li[2]);
      cell.SetCellMarginTop(180);
      cell.SetCellMarginBottom(180);
      cell.SetCellMarginLeft(240);
      cell.SetCellMarginRight(200);
      cell.SetCellBorderLeft("single", 30, 0, ac[0], ac[1], ac[2]);
      setRuns(cell.GetContent(), "#20303C", 11);
      return true;
    }, { accent });
  };

  // Adds (or replaces) a small header line that repeats on every page.
  // Adds (or replaces) the running header. `text` may contain newlines to
  // build a multi-line letterhead; the first line is bold by default.
  setHeader = async (text: string, align?: string, boldFirst?: boolean) =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var sections =
        typeof doc.GetSections === "function" ? doc.GetSections() : null;
      if (!sections || !sections.length) return false;
      var section = sections[0];
      if (typeof section.GetHeader !== "function") return false;
      var header = section.GetHeader("default", true);
      if (!header) return false;

      // A header always keeps at least one paragraph, so trim to a single base
      // paragraph, reuse it for the first line, then append the rest.
      var guard = 0;
      while (
        typeof header.RemoveElement === "function" &&
        typeof header.GetElementsCount === "function" &&
        header.GetElementsCount() > 1 &&
        guard < 100
      ) {
        header.RemoveElement(header.GetElementsCount() - 1);
        guard++;
      }

      var lines = String(scope.text || "").split(/\r?\n/);
      var jc =
        scope.align === "center"
          ? "center"
          : scope.align === "right"
            ? "right"
            : "left";
      var bold = scope.boldFirst !== false;
      var first =
        typeof header.GetElementsCount === "function" &&
        header.GetElementsCount() >= 1
          ? header.GetElement(0)
          : null;
      if (!first) {
        first = Api.CreateParagraph();
        header.Push(first);
      }

      var added = 0;
      for (var i = 0; i < lines.length; i++) {
        var p = i === 0 ? first : Api.CreateParagraph();
        if (typeof p.SetText === "function") p.SetText(lines[i]);
        else p.AddText(lines[i]);
        if (p.SetJc) p.SetJc(jc);
        var runs = p.GetElementsCount ? p.GetElementsCount() : 0;
        for (var r = 0; r < runs; r++) {
          var run = p.GetElement(r);
          if (run && run.SetColor) {
            run.SetColor(Api.HexColor("#5A6B7B"));
            run.SetFontSize(bold && i === 0 ? 9 : 8);
            if (bold && i === 0 && run.SetBold) run.SetBold(true);
          }
        }
        if (i > 0) header.Push(p);
        added++;
      }
      return added > 0;
    }, { text, align, boldFirst });

  // Rebuilds every table-of-contents field from the current headings.
  updateTableOfContents = async () =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      return typeof doc.UpdateAllTOC === "function"
        ? doc.UpdateAllTOC(false)
        : false;
    });

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

  // Compact, bounded structural view of the document for self-review: one line
  // per paragraph (index + style + short text) and table shapes. Cheaper and
  // more reliable than re-reading the whole HTML.
  getDocumentOutline = async () =>
    this.callEditorCommand(function () {
      var doc = Api.GetDocument();
      var total =
        typeof doc.GetElementsCount === "function" ? doc.GetElementsCount() : 0;
      var items = [];
      var headings = 0;
      var words = 0;

      for (var i = 0; i < total; i++) {
        var el = doc.GetElement(i);
        if (!el) continue;
        var cls = typeof el.GetClassType === "function" ? el.GetClassType() : "";
        var st = typeof el.GetStyle === "function" ? el.GetStyle() : null;
        var style = st && typeof st.GetName === "function" ? st.GetName() : "";
        var text =
          typeof el.GetText === "function"
            ? String(el.GetText()).replace(/[\r\n\t]+/g, " ").trim()
            : "";

        if (cls === "table") {
          var rows = typeof el.GetRowsCount === "function" ? el.GetRowsCount() : -1;
          var cells = typeof el.GetCellsCount === "function" ? el.GetCellsCount() : -1;
          items.push({
            i: i,
            type: "table",
            rows: rows,
            cells: cells,
            text: text.slice(0, 90),
          });
          continue;
        }

        if (style && /^(Title|Heading [1-9])$/.test(style)) headings++;
        words += text ? text.split(/\s+/).length : 0;
        items.push({
          i: i,
          style: style || "Normal",
          text: text.slice(0, 90),
        });
      }

      return JSON.stringify({
        paragraphs: total,
        headings: headings,
        tables: typeof doc.GetAllTables === "function" ? doc.GetAllTables().length : -1,
        images: typeof doc.GetAllImages === "function" ? doc.GetAllImages().length : -1,
        charts: typeof doc.GetAllCharts === "function" ? doc.GetAllCharts().length : -1,
        words: words,
        outline: items,
      });
    });

  // Builds the agent feedback snapshot: structure, provenance and findings.
  // See docs/agent-doc-snapshot.md. Geometry is a later phase.
  getAgentSnapshot = async () => {
    const raw = await this.callEditorCommand(function () {
      function hexOf(c: any) {
        if (!c) return null;
        var r: number | undefined;
        var g: number | undefined;
        var b: number | undefined;
        if (typeof c.GetRGB === "function") {
          var o = c.GetRGB();
          if (o) {
            r = o.r;
            g = o.g;
            b = o.b;
          }
        } else if (typeof c.value === "number") {
          var v = c.value;
          r = (v >> 16) & 255;
          g = (v >> 8) & 255;
          b = v & 255;
        }
        if (r === undefined || g === undefined || b === undefined) return null;
        function h2(x: number) {
          var s = x.toString(16);
          return s.length < 2 ? "0" + s : s;
        }
        return "#" + h2(r) + h2(g) + h2(b);
      }

      var doc = Api.GetDocument();
      var styleCache: Record<string, any> = {};
      function styleInfo(name: string) {
        if (styleCache[name]) return styleCache[name];
        var s = doc.GetStyle ? doc.GetStyle(name) : null;
        var tp = s && s.GetTextPr ? s.GetTextPr() : null;
        var info = {
          font: tp && tp.GetFontFamily ? tp.GetFontFamily("ascii") : null,
          size: tp && tp.GetFontSize ? tp.GetFontSize() : null,
          color: tp && tp.GetColor ? hexOf(tp.GetColor()) : null,
        };
        styleCache[name] = info;
        return info;
      }

      var elements: any[] = [];
      var stylesUsed: Record<string, boolean> = {};
      var n = doc.GetElementsCount ? doc.GetElementsCount() : 0;

      for (var i = 0; i < n; i++) {
        var el = doc.GetElement(i);
        if (!el) continue;
        var cls = el.GetClassType ? el.GetClassType() : "";

        if (cls === "table") {
          var rows = el.GetRowsCount ? el.GetRowsCount() : 0;
          var cols = 0;
          try {
            cols =
              el.GetRow(0) && el.GetRow(0).GetCellsCount
                ? el.GetRow(0).GetCellsCount()
                : 0;
          } catch (e) {
            cols = 0;
          }
          var headerShaded = false;
          try {
            var boldCells = 0;
            for (var c = 0; c < cols; c++) {
              var cell = el.GetCell(0, c);
              var cont = cell && cell.GetContent ? cell.GetContent() : null;
              var pc =
                cont && cont.GetElementsCount ? cont.GetElementsCount() : 0;
              var bold = false;
              for (var pi = 0; pi < pc; pi++) {
                var para = cont.GetElement(pi);
                var rc =
                  para && para.GetElementsCount ? para.GetElementsCount() : 0;
                for (var ri = 0; ri < rc; ri++) {
                  var rn = para.GetElement(ri);
                  if (rn && rn.GetBold && rn.GetBold()) bold = true;
                }
              }
              if (bold) boldCells++;
            }
            headerShaded = cols > 0 && boldCells >= cols;
          } catch (e) {
            headerShaded = false;
          }
          elements.push({
            kind: "table",
            index: i,
            id: "table:" + i,
            rows: rows,
            cols: cols,
            headerShaded: headerShaded,
            caption: null,
          });
          continue;
        }

        if (cls === "blockLvlSdt") {
          elements.push({ kind: "toc", index: i, id: "toc:" + i });
          continue;
        }

        if (cls === "image" || cls === "drawing") {
          elements.push({ kind: "image", index: i, id: "image:" + i, caption: null });
          continue;
        }

        var st = el.GetStyle ? el.GetStyle() : null;
        var style = st && st.GetName ? st.GetName() : "";
        if (!style) style = "Normal";
        stylesUsed[style] = true;
        var text = el.GetText
          ? String(el.GetText()).replace(/[\r\n\t]+/g, " ").trim()
          : "";
        var numbering = false;
        try {
          numbering = !!(el.GetNumbering && el.GetNumbering());
        } catch (e) {
          numbering = false;
        }

        var si = styleInfo(style);
        var paraId = null;
        try {
          if (typeof el.GetParaId === "function") paraId = el.GetParaId();
        } catch (e) {
          paraId = null;
        }
        var runs: any[] = [];
        var rcount = el.GetElementsCount ? el.GetElementsCount() : 0;
        for (var k = 0; k < rcount; k++) {
          var run = el.GetElement(k);
          if (!run || !run.GetClassType || run.GetClassType() !== "run")
            continue;
          var font = run.GetFontFamily ? run.GetFontFamily("ascii") : null;
          var size = run.GetFontSize ? run.GetFontSize() : null;
          var color = run.GetColor ? hexOf(run.GetColor()) : null;
          var direct = false;
          if (font && si.font && font !== si.font) direct = true;
          if (size && si.size && Number(size) !== Number(si.size)) direct = true;
          if (color && si.color && color !== si.color) direct = true;
          runs.push({
            text: run.GetText ? String(run.GetText()) : "",
            font: font,
            size: size,
            color: color,
            bold: run.GetBold ? !!run.GetBold() : undefined,
            italic: run.GetItalic ? !!run.GetItalic() : undefined,
            direct: direct,
          });
        }
        elements.push({
          kind: "paragraph",
          index: i,
          id: "paragraph:" + (paraId !== null && paraId !== undefined ? paraId : i),
          style: style,
          text: text,
          numbering: numbering,
          runs: runs,
        });
      }

      // Attach captions: a following paragraph starting with "Table N."/"Figure N.".
      for (var j = 0; j < elements.length - 1; j++) {
        var cur = elements[j];
        var nx = elements[j + 1];
        if (
          (cur.kind === "table" || cur.kind === "image") &&
          nx.kind === "paragraph" &&
          /^(Table|Figure)\s+\d+\./i.test(nx.text)
        ) {
          cur.caption = nx.text;
        }
      }

      var stylesDefined: string[] = [];
      try {
        var all = doc.GetAllStyles ? doc.GetAllStyles() : {};
        for (var key in all) {
          if (Object.prototype.hasOwnProperty.call(all, key)) {
            stylesDefined.push(all[key].GetName ? all[key].GetName() : key);
          }
        }
      } catch (e) {
        stylesDefined = [];
      }

      return JSON.stringify({
        elements: elements,
        stylesDefined: stylesDefined,
        stylesUsed: Object.keys(stylesUsed),
      });
    });

    let model: DocModel;
    try {
      model =
        typeof raw === "string" ? (JSON.parse(raw) as DocModel) : (raw as DocModel);
    } catch {
      return JSON.stringify({
        schema: "tysastra.agent.doc/1.0",
        error: "snapshot failed",
      });
    }

    // Merge engine geometry (page/bounds) by paraId, when the engine exposes it.
    let geometryAvailable = false;
    try {
      const geoRaw = await this.callMethod("GetAgentDocumentSnapshot", []);
      const geo =
        typeof geoRaw === "string"
          ? (JSON.parse(geoRaw) as {
              paragraphs?: Array<Record<string, unknown>>;
            })
          : (geoRaw as { paragraphs?: Array<Record<string, unknown>> });
      if (geo && Array.isArray(geo.paragraphs)) {
        const byId = new Map<number, Record<string, unknown>>();
        for (const g of geo.paragraphs) {
          if (g && g.paraId !== null && g.paraId !== undefined)
            byId.set(Number(g.paraId), g);
        }
        for (const el of model.elements) {
          if (el.kind !== "paragraph" || !el.id) continue;
          const pid = Number(String(el.id).split(":")[1]);
          const g = byId.get(pid);
          if (g) {
            el.geometry = {
              absPage: Number(g.absPage ?? 0),
              pagesCount:
                g.pagesCount === undefined ? undefined : Number(g.pagesCount),
              linesCount:
                g.linesCount === undefined ? undefined : Number(g.linesCount),
              top: g.top === undefined ? undefined : Number(g.top),
              bottom: g.bottom === undefined ? undefined : Number(g.bottom),
              left: g.left === undefined ? undefined : Number(g.left),
              right: g.right === undefined ? undefined : Number(g.right),
            };
            geometryAvailable = true;
          }
        }
      }
    } catch {
      // geometry not available (older engine); skip
    }

    const findings = computeFindings(model);
    const nodes = (model.elements ?? []).slice(0, 200) as DocElement[];

    // Rotate snapshots so get_document_diff can report what changed since the
    // previous feedback call.
    this.previousSnapshot = this.currentSnapshot;
    this.currentSnapshot = { schema: "tysastra.agent.doc/1.0", findings, nodes };

    return JSON.stringify({
      schema: "tysastra.agent.doc/1.0",
      coverage: {
        pagination: geometryAvailable ? "partial" : "absent",
        text_geometry: geometryAvailable ? "partial" : "absent",
        resolved_typography: "partial",
        table_geometry: "absent",
        drawing_appearance: "absent",
        header_footer: "absent",
      },
      summary: summarizeFindings(findings),
      findings,
      nodes,
    });
  };

  // Compares the two most recent feedback snapshots (from get_document_feedback)
  // so the agent can see what its edits changed and which findings cleared.
  getDocumentDiff = async () => {
    if (!this.previousSnapshot || !this.currentSnapshot) {
      return JSON.stringify({
        schema: "tysastra.agent.doc/1.0",
        note: "No previous snapshot. Call get_document_feedback, make changes, then call get_document_diff.",
      });
    }
    const diff = diffSnapshots(this.previousSnapshot, this.currentSnapshot);
    return JSON.stringify({
      schema: "tysastra.agent.doc/1.0",
      summary: summarizeDiff(diff),
      newFindings: diff.newFindings,
      clearedFindings: diff.clearedFindings,
      addedNodes: diff.addedNodes,
      removedNodes: diff.removedNodes,
      changedNodes: diff.changedNodes,
    });
  };

  // Selects (and scrolls to) the node referenced by a finding's nodeId, e.g.
  // "paragraph:5" or "table:3".
  selectNode = async (nodeId: string) =>
    this.callEditorCommand(function () {
      var parts = String(scope.nodeId || "").split(":");
      var kind = parts[0];
      var val = parts[1];
      var doc = Api.GetDocument();
      var el = null;

      if (kind === "paragraph") {
        var want = Number(val);
        var n = doc.GetElementsCount ? doc.GetElementsCount() : 0;
        for (var i = 0; i < n; i++) {
          var cand = doc.GetElement(i);
          if (!cand || typeof cand.GetParaId !== "function") continue;
          if (cand.GetParaId() === want) {
            el = cand;
            break;
          }
        }
      }
      if (!el) {
        var idx = parseInt(val, 10);
        if (!isNaN(idx) && typeof doc.GetElement === "function")
          el = doc.GetElement(idx);
      }
      if (el && typeof el.Select === "function") {
        el.Select();
        return true;
      }
      return false;
    }, { nodeId });

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
          "Give the document a consistent visual design by setting the accent color (and optional font) of the Title and Heading 1-9 styles. Call this at the START of building a document, before inserting content, so headings inherit the design. Editing the named styles means the author can keep writing and get the same look. Example accent: #1F3864.",
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
        name: "setup_document",
        description:
          "PREFERRED start-of-document call (replaces apply_document_theme + set_page_margins + add_page_numbers): sets the accent color on the named styles (Title, Subtitle, Heading 1-9), sets page margins, and adds footer page numbers in ONE call. Use it once before inserting content.",
        inputSchema: {
          type: "object",
          properties: {
            accent: { type: "string", description: "Hex color, e.g. #1F3864" },
            fontFamily: { type: "string" },
            marginsPt: { type: "number", description: "Margin in points, e.g. 56" },
          },
          required: ["accent"],
        },
      },
      {
        name: "insert_title",
        description:
          "Insert the document title block using the real Title/Subtitle styles (title, optional subtitle, optional author/date line). Use this for the document title instead of an <h1>, so the title is NOT counted as heading 1 and is not numbered.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            subtitle: { type: "string" },
            meta: { type: "string", description: "Author / organisation / date line." },
          },
          required: ["title"],
        },
      },
      {
        name: "insert_banner",
        description:
          "Insert a full-width shaded title banner (a designed cover) with a large white title, a subtitle and an optional meta line below (author/date/reference). Use it for a polished first page instead of a plain heading.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            subtitle: { type: "string" },
            meta: { type: "string" },
            accent: { type: "string", description: "Hex color, e.g. #1B4965" },
          },
          required: ["title"],
        },
      },
      {
        name: "insert_callout",
        description:
          "Insert a shaded callout box with a thick accent bar on the left, for a key insight, note or recommendation. Text may include simple HTML such as <strong>Key insight:</strong> ...",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            accent: { type: "string", description: "Hex color, e.g. #1B4965" },
          },
          required: ["text"],
        },
      },
      {
        name: "number_headings",
        description:
          "Turn on automatic section numbering for headings (1, 1.1, 1.1.1). Numbers are generated by the editor and stay correct when headings are added, moved or deleted, so do NOT type numbers into heading text. Call once after the headings exist.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "add_page_numbers",
        description:
          "Add a centered 'Page X of Y' number field to the document footer. Call this for every document you produce.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "insert_table_of_contents",
        description:
          "Insert a DYNAMIC table of contents (built from the document's Heading styles, with page numbers and links). Insert it after the title block once the headings exist. Requires content to use real headings (h1/h2/h3). If you inserted it too early, call update_table_of_contents to fill it.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "update_table_of_contents",
        description:
          "Rebuild/refresh every table of contents in the document from the current headings (use after editing headings if the TOC looks empty or out of date).",
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
          "Insert an image (URL or data URI) as its own paragraph. Provide width/height in points and an alignment. Note: remote URLs may fail to load; for data visuals prefer insert_chart.",
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
        name: "insert_chart",
        description:
          "Insert a real, editable chart (a plot) with a title. Use this for any data visualisation. chartType: bar | line | pie | area | scatter. series is an array of numeric arrays (one per series); seriesNames and catNames are the labels.",
        inputSchema: {
          type: "object",
          properties: {
            chartType: {
              type: "string",
              enum: ["bar", "line", "pie", "area", "scatter"],
            },
            series: {
              type: "array",
              items: { type: "array", items: { type: "number" } },
            },
            seriesNames: { type: "array", items: { type: "string" } },
            catNames: { type: "array", items: { type: "string" } },
            title: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["chartType", "series", "seriesNames", "catNames"],
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
        name: "style_table",
        description:
          "Apply a design to a table (defaults to the last table): a shaded header row with contrasting text, optional banded rows and bottom borders. Call it once per table after inserting the table. Defaults: headerFill #1B4965, headerTextColor #FFFFFF, bandRows true, borders true.",
        inputSchema: {
          type: "object",
          properties: {
            tableIndex: {
              type: "number",
              description: "0-based table index; defaults to the last table.",
            },
            headerFill: { type: "string", description: "Hex color of the header row." },
            headerTextColor: { type: "string", description: "Hex text color for the header row." },
            bandFill: { type: "string", description: "Hex color for the shaded (even) rows." },
            bandRows: { type: "boolean" },
            borders: { type: "boolean" },
            columnWidths: {
              type: "array",
              items: { type: "number" },
              description:
                "Optional per-column widths as percentages (e.g. [6,44,8,8,17,17]) so narrow columns stay readable.",
            },
            emphasizeLastRows: {
              type: "number",
              description:
                "Shade and bold the last N rows (e.g. 3 for Total/VAT/Grand Total).",
            },
            totalFill: {
              type: "string",
              description: "Hex fill for the emphasized rows (default #D6E4F0).",
            },
          },
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
        name: "set_header",
        description:
          "Set the running header that repeats on every page. `text` may contain newlines to build a multi-line letterhead (company name, address, contact); the first line is bold by default. Replaces any existing header.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Header text; use \\n for multiple lines." },
            align: { type: "string", enum: ["left", "center", "right"] },
            boldFirst: { type: "boolean", description: "Bold the first line (default true)." },
          },
          required: ["text"],
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
        name: "get_document_feedback",
        description:
          "Return the document feedback snapshot: structure + style provenance + source-linked findings (schema tysastra.agent.doc). USE THIS to verify your work: each finding has a code, severity (blocking|advisory), a nodeId and a message. Fix every blocking finding by its nodeId, then call it again. Phase 0 covers structure/provenance findings (double numbering, direct-format override, empty section, missing caption, missing TOC); geometry findings come later.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "select_node",
        description:
          "Select and scroll to a document node by its finding nodeId (e.g. \"paragraph:5\" or \"table:3\").",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: { type: "string", description: "e.g. paragraph:5 or table:3" },
          },
          required: ["nodeId"],
        },
      },
      {
        name: "get_document_diff",
        description:
          "Compare the two most recent get_document_feedback snapshots and return what changed: newFindings, clearedFindings, and node add/remove/change counts. Use it after edits to confirm your changes fixed findings and did not introduce new ones.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_document_outline",
        description:
          "Return a compact, bounded structural outline of the document (paragraph index, style, short text, table shape, counts). USE THIS for self-review instead of get_document_html: it is smaller, complete, and reliable.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "find_and_replace",
        description:
          "Find and replace text in the document. Use it to repair merged or duplicated text without rebuilding.",
        inputSchema: {
          type: "object",
          properties: {
            search: { type: "string" },
            replace: { type: "string" },
          },
          required: ["search", "replace"],
        },
      },
      {
        name: "set_paragraph_text",
        description:
          "Replace the entire text of the paragraph at a 0-based index (order matches get_document_html / get_document_text).",
        inputSchema: {
          type: "object",
          properties: {
            index: { type: "number" },
            text: { type: "string" },
          },
          required: ["index", "text"],
        },
      },
      {
        name: "insert_paragraph_after",
        description:
          'Insert a new paragraph after the paragraph at a 0-based index, optionally with a named style (e.g. "Heading 2"). Use to split merged paragraphs and restore headings.',
        inputSchema: {
          type: "object",
          properties: {
            index: { type: "number" },
            text: { type: "string" },
            style: { type: "string" },
          },
          required: ["index", "text"],
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
      case "setup_document":
        result = await this.setupDocument(
          String(args.accent ?? ""),
          args.fontFamily ? String(args.fontFamily) : undefined,
          typeof args.marginsPt === "number" ? args.marginsPt : undefined
        );
        break;
      case "insert_title":
        result = await this.insertTitle(
          String(args.title ?? ""),
          String(args.subtitle ?? ""),
          String(args.meta ?? "")
        );
        break;
      case "insert_banner":
        result = await this.insertBanner(
          String(args.title ?? ""),
          String(args.subtitle ?? ""),
          String(args.meta ?? ""),
          String(args.accent ?? "")
        );
        break;
      case "insert_callout":
        result = await this.insertCallout(
          String(args.text ?? ""),
          String(args.accent ?? "")
        );
        break;
      case "number_headings":
        result = await this.numberHeadings();
        break;
      case "add_page_numbers":
        result = await this.addPageNumbers();
        break;
      case "insert_table_of_contents":
        result = await this.insertTableOfContents();
        break;
      case "update_table_of_contents":
        result = await this.updateTableOfContents();
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
      case "insert_chart":
        result = await this.insertChart(
          String(args.chartType ?? "bar"),
          Array.isArray(args.series) ? (args.series as number[][]) : [],
          Array.isArray(args.seriesNames) ? (args.seriesNames as string[]) : [],
          Array.isArray(args.catNames) ? (args.catNames as string[]) : [],
          String(args.title ?? ""),
          Number(args.width ?? 420),
          Number(args.height ?? 260)
        );
        break;
      case "fit_table":
        result = await this.fitTable(
          String(args.mode ?? "contents"),
          Boolean(args.center),
          typeof args.tableIndex === "number" ? args.tableIndex : undefined
        );
        break;
      case "style_table":
        result = await this.styleTable({
          tableIndex:
            typeof args.tableIndex === "number" ? args.tableIndex : undefined,
          headerFill: args.headerFill ? String(args.headerFill) : undefined,
          headerTextColor: args.headerTextColor
            ? String(args.headerTextColor)
            : undefined,
          bandFill: args.bandFill ? String(args.bandFill) : undefined,
          bandRows: typeof args.bandRows === "boolean" ? args.bandRows : undefined,
          borders: typeof args.borders === "boolean" ? args.borders : undefined,
          columnWidths: Array.isArray(args.columnWidths)
            ? (args.columnWidths as number[])
            : undefined,
          emphasizeLastRows:
            typeof args.emphasizeLastRows === "number"
              ? args.emphasizeLastRows
              : undefined,
          totalFill: args.totalFill ? String(args.totalFill) : undefined,
        });
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
      case "set_header":
        result = await this.setHeader(
          String(args.text ?? ""),
          args.align ? String(args.align) : undefined,
          typeof args.boldFirst === "boolean" ? args.boldFirst : undefined
        );
        break;
      case "find_and_replace":
        result = await this.findAndReplace(
          String(args.search ?? ""),
          String(args.replace ?? "")
        );
        break;
      case "set_paragraph_text":
        result = await this.setParagraphText(
          Number(args.index ?? 0),
          String(args.text ?? "")
        );
        break;
      case "insert_paragraph_after":
        result = await this.insertParagraphAfter(
          Number(args.index ?? 0),
          String(args.text ?? ""),
          args.style ? String(args.style) : undefined
        );
        break;
      case "get_document_text":
        result = await this.getDocumentText();
        break;
      case "get_styles":
        result = await this.getStyles();
        break;
      case "get_document_outline":
        result = await this.getDocumentOutline();
        break;
      case "get_document_feedback":
        result = await this.getAgentSnapshot();
        break;
      case "get_document_diff":
        result = await this.getDocumentDiff();
        break;
      case "select_node":
        result = await this.selectNode(String(args.nodeId ?? ""));
        break;
      default:
        result = { error: `unknown editor tool: ${name}` };
    }
    return typeof result === "string" ? result : JSON.stringify(result);
  };
}
