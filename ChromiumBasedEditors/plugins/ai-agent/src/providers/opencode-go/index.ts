import type { Model } from "@/lib/types";
import OpenAI from "openai";
import type { TData } from "../base";
import { createDesktopProxyFetch } from "../desktop-proxy";
import { OpenAIProvider } from "../openai";
import { opencodeGoInfo } from "./info";

/**
 * OpenCode Go provider - an OpenAI-compatible endpoint
 * (https://opencode.ai/zen/go/v1) for the low-cost Go subscription.
 */
class OpenCodeGoProvider extends OpenAIProvider {
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

  getName = (): string => opencodeGoInfo.name;

  getBaseUrl = (): string => opencodeGoInfo.baseUrl;

  private toModel = (id: string): Model => ({
    id,
    name: opencodeGoInfo.modelNames[id] || id,
    provider: "opencode-go" as const,
    reasoning: /deepseek|glm|kimi|qwen|minimax|mimo/i.test(id),
  });

  getProviderModels = async (data: TData): Promise<Model[]> => {
    try {
      const client = this.createClient(
        data.apiKey,
        data.url || opencodeGoInfo.baseUrl
      );
      const response = await client.models.list();
      const ids = response.data.map((model) => model.id);
      const filtered = opencodeGoInfo.modelFilters.length
        ? ids.filter((id) => opencodeGoInfo.modelFilters.includes(id))
        : ids;

      if (filtered.length) return filtered.map(this.toModel);
    } catch (error) {
      console.error("Failed to fetch OpenCode Go models:", error);
    }

    return opencodeGoInfo.fallbackModels.map(this.toModel);
  };
}

const opencodeGoProvider = new OpenCodeGoProvider();

export { OpenCodeGoProvider, opencodeGoProvider };
