export const opencodeInfo = {
  name: "OpenCode Zen",
  baseUrl: "https://opencode.ai/zen/v1",
  // OpenAI chat/completions compatible models (see https://opencode.ai/docs/zen).
  // Empty filter would show every model returned by /models, including models
  // served through /responses or /messages which the OpenAI SDK cannot call.
  modelFilters: [
    "big-pickle",
    "mimo-v2.5-free",
    "ling-3.0-flash-fin-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "glm-5.3-flash",
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    "kimi-k2.5",
  ] as string[],
  modelNames: {} as Record<string, string>,
  // Used when the /models endpoint is unavailable.
  fallbackModels: [
    "big-pickle",
    "mimo-v2.5-free",
    "ling-3.0-flash-fin-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "glm-5.3-flash",
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    "kimi-k2.5",
  ] as string[],
};
