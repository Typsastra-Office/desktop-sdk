export const opencodeGoInfo = {
  name: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  // OpenAI chat/completions compatible models (see https://opencode.ai/docs/go).
  modelFilters: [
    "hy4-preview",
    "deepseek-v4-flash-vision-exp",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
  ] as string[],
  modelNames: {} as Record<string, string>,
  // Used when the /models endpoint is unavailable.
  fallbackModels: [
    "hy4-preview",
    "deepseek-v4-flash-vision-exp",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
  ] as string[],
};
