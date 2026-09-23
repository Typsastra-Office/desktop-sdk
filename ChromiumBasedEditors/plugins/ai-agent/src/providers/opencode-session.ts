/**
 * OpenCode (Zen / Go) requires a stable `x-opencode-session` header on every
 * request so the gateway can route and cache prompts. The value must be stable
 * for a conversation; we keep one per plugin session in localStorage.
 */
const SESSION_STORAGE_KEY = "opencode-session-id";

let cachedSessionId: string | undefined;

export const getOpenCodeSessionId = (): string => {
  if (cachedSessionId) return cachedSessionId;

  try {
    if (typeof localStorage !== "undefined") {
      const existing = localStorage.getItem(SESSION_STORAGE_KEY);
      if (existing) {
        cachedSessionId = existing;
        return existing;
      }
    }
  } catch {
    // localStorage unavailable - fall through to generating a new id
  }

  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  cachedSessionId = generated;

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SESSION_STORAGE_KEY, generated);
    }
  } catch {
    // ignore
  }

  return generated;
};
