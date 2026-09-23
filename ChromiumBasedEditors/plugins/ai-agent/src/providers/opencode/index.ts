import type { Model } from "@/lib/types";
import OpenAI from "openai";
import type { TData } from "../base";
import { createDesktopProxyFetch } from "../desktop-proxy";
import { OpenAIProvider } from "../openai";
import { opencodeInfo } from "./info";

/**
 * OpenCode Zen provider - an OpenAI-compatible endpoint
 * (https://opencode.ai/zen/v1) that serves curated coding models.
 */
class OpenCodeProvider extends OpenAIProvider {
  // opencode.ai does not send CORS headers, so route requests through the
  // desktop editor's onlyoffice-proxy scheme.
  protected createClient(apiKey?: string, baseURL?: string): OpenAI {
    return new OpenAI({
      apiKey,
      baseURL,
      dangerouslyAllowBrowser: true,
      fetch: createDesktopProxyFetch(),
    });
  }

  getName = (): string => opencodeInfo.name;

  getBaseUrl = (): string => opencodeInfo.baseUrl;

  private toModel = (id: string): Model => ({
    id,
    name: opencodeInfo.modelNames[id] || id,
    provider: "opencode" as const,
    reasoning: /deepseek|glm|kimi|qwen|minimax|mimo/i.test(id),
  });

  getProviderModels = async (data: TData): Promise<Model[]> => {
    try {
      const client = this.createClient(
        data.apiKey,
        data.url || opencodeInfo.baseUrl
      );
      const response = await client.models.list();
      const ids = response.data.map((model) => model.id);
      const filtered = opencodeInfo.modelFilters.length
        ? ids.filter((id) => opencodeInfo.modelFilters.includes(id))
        : ids;

      if (filtered.length) return filtered.map(this.toModel);
    } catch (error) {
      console.error("Failed to fetch OpenCode Zen models:", error);
    }

    return opencodeInfo.fallbackModels.map(this.toModel);
  };
}

const opencodeProvider = new OpenCodeProvider();

export { OpenCodeProvider, opencodeProvider };
