// Editor-only references that can be added to the chat with "@".
declare const Api: { GetDocument: () => any };

export type EditorReferenceKind =
  | "selection"
  | "paragraph"
  | "document"
  | "styles";

type AscPlugin = {
  callCommand: (
    func: () => unknown,
    isClose: boolean,
    isCalc: boolean,
    callback: (result: unknown) => void
  ) => void;
  executeMethod: (
    name: string,
    args: unknown[],
    callback: (result: unknown) => void
  ) => void;
};

const getPlugin = (): AscPlugin | undefined =>
  (window as unknown as { Asc?: { plugin?: AscPlugin } }).Asc?.plugin;

const runCommand = (func: () => unknown): Promise<string> =>
  new Promise((resolve) => {
    const plugin = getPlugin();
    if (!plugin?.callCommand) return resolve("");
    plugin.callCommand(func, false, false, (result) =>
      resolve(
        typeof result === "string"
          ? result
          : result == null
            ? ""
            : JSON.stringify(result)
      )
    );
  });

export const fetchEditorReference = (
  kind: EditorReferenceKind
): Promise<string> => {
  const plugin = getPlugin();

  switch (kind) {
    case "selection":
      if (!plugin?.executeMethod) return Promise.resolve("");
      return new Promise((resolve) =>
        plugin.executeMethod(
          "GetSelectedText",
          [{ Numbering: false }],
          (result) => resolve((result as string) || "")
        )
      );
    case "paragraph":
      return runCommand(function () {
        var doc = Api.GetDocument();
        var p =
          typeof doc.GetCurrentParagraph === "function"
            ? doc.GetCurrentParagraph()
            : null;
        return p && typeof p.GetText === "function" ? p.GetText() : "";
      });
    case "document":
      return runCommand(function () {
        return Api.GetDocument().GetText();
      });
    case "styles":
      return runCommand(function () {
        var all = Api.GetDocument().GetAllStyles() || {};
        var names = [];
        for (var key in all) {
          if (Object.prototype.hasOwnProperty.call(all, key)) {
            names.push(all[key].GetName ? all[key].GetName() : key);
          }
        }
        return names.join(", ");
      });
    default:
      return Promise.resolve("");
  }
};
