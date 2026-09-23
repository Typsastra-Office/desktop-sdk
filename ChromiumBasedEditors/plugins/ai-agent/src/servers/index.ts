import type { TMCPItem } from "@/lib/types";
import { CustomServers } from "./CustomServers";
import { DesktopEditorTool } from "./DesktopEditor";
import { EditorDocumentTool } from "./EditorDocument";
import { WebSearch, type WebSearchData } from "./WebSearch";

const ALLOW_ALWAYS_TOOLS = "allowAlwaysTools";

class Servers {
  desktopEditorTool: DesktopEditorTool;
  editorDocumentTool: EditorDocumentTool;
  customServers: CustomServers;
  webSearch: WebSearch;

  allowAlways: string[];

  constructor() {
    this.desktopEditorTool = new DesktopEditorTool();
    this.editorDocumentTool = new EditorDocumentTool();
    this.customServers = new CustomServers();
    this.webSearch = new WebSearch();

    this.allowAlways =
      localStorage.getItem(ALLOW_ALWAYS_TOOLS)?.split(",") ?? [];
  }

  checkAllowAlways = (type: string, name: string) => {
    if (type === "web-search") {
      return true;
    }

    // In-document editing tools are internal and safe: reading and editing the
    // active document should not require per-call approval.
    if (type === "editor") {
      return true;
    }

    if (this.allowAlways.includes(`${type}_${name}`)) {
      return true;
    }

    return false;
  };

  setAllowAlways = (value: boolean, type: string, name: string) => {
    if (type === "web-search") {
      return;
    }

    if (value) {
      this.allowAlways.push(`${type}_${name}`);
    } else {
      this.allowAlways = this.allowAlways.filter(
        (tool) => tool !== `${type}_${name}`
      );
    }

    localStorage.setItem(ALLOW_ALWAYS_TOOLS, this.allowAlways.join(","));
  };

  getTools = async () => {
    const [
      desktopEditorTools,
      editorDocumentTools,
      webSearchTools,
      customServersTools,
    ] = await Promise.all([
      this.desktopEditorTool.getTools(),
      this.editorDocumentTool.getTools(),
      this.webSearch.getTools(),
      this.customServers.getTools(),
    ]);

    // The agent must never create or open documents, and must not wipe the
    // document and rebuild it - it edits what is already there. clear_document
    // is exposed deliberately (start-over / recovery), but only for a clean
    // restart at the beginning of a task.
    const hiddenTools = [
      "generate_docx",
      "generate_form",
      "generate_pptx",
      "file_opener",
      "form_field_filler",
    ];

    const items: Record<string, TMCPItem[]> = {
      "desktop-editor": desktopEditorTools.filter(
        (tool) => !hiddenTools.includes(tool.name)
      ),
      "web-search": webSearchTools,
      ...customServersTools,
    };

    if (editorDocumentTools.length) {
      items.editor = editorDocumentTools;
    }

    return items;
  };

  callTools = async (
    type: string,
    name: string,
    args: Record<string, unknown>
  ) => {
    if (type === "desktop-editor") {
      return this.desktopEditorTool.callTools(name, args);
    }

    if (type === "editor") {
      return this.editorDocumentTool.callTools(name, args);
    }

    if (type === "web-search") {
      return await this.webSearch.callTools(name, args);
    }

    // Call MCP server tool
    return await this.customServers.callToolFromMCP(type, name, args);
  };

  getServerType = (name: string) => {
    if (name.includes("desktop-editor_")) {
      return "desktop-editor";
    }

    if (name.includes("web-search_")) {
      return "web-search";
    }

    if (name.includes("editor_")) {
      return "editor";
    }
    return this.customServers.getServerType(name);
  };

  setCustomServers = (servers: {
    mcpServers: Record<string, Record<string, unknown>>;
  }) => {
    this.customServers.setCustomServers(servers);
  };

  startCustomServers = () => {
    this.customServers.startCustomServers();
  };

  restartCustomServer = (type: string) => {
    this.customServers.restartCustomServer(type);
  };

  deleteCustomServer = (type: string) => {
    this.customServers.deleteCustomServer(type);
  };

  getCustomServers = () => {
    return this.customServers.customServers;
  };

  getCustomServersStoped = () => {
    return this.customServers.stoppedCustomServers;
  };

  getCustomServersLogs = () => {
    return this.customServers.customServersLogs;
  };

  setWebSearchData = (data: WebSearchData) => {
    this.webSearch.setWebSearchData(data);
  };

  getWebSearchData = () => {
    return this.webSearch.getWebSearchData();
  };

  getWebSearchEnabled = () => {
    return this.webSearch.getWebSearchEnabled();
  };
}

const servers = new Servers();

export default servers;
