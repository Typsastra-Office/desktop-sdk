/**
 * The desktop editor blocks cross-origin HTTP requests unless the remote
 * endpoint sends CORS headers. Most LLM APIs do, but some (e.g. opencode.ai)
 * do not, which makes direct SDK calls fail with "Failed to fetch".
 *
 * Inside an editor plugin frame the desktop app exposes the
 * `onlyoffice-proxy://` scheme, which performs the request natively and adds
 * permissive CORS headers. This helper returns a fetch implementation that
 * rewrites absolute http(s) URLs through that scheme, and is a no-op anywhere
 * else (web / tests).
 */
const isDesktopPluginFrame = (): boolean => {
  return (
    typeof location !== "undefined" && location.protocol === "onlyoffice:"
  );
};

const urlToString = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

export const createDesktopProxyFetch = (): typeof fetch => {
  const proxiedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlToString(input);

    if (isDesktopPluginFrame() && /^https?:\/\//i.test(url)) {
      return fetch(`onlyoffice-proxy://${url}`, init);
    }

    return fetch(input as RequestInfo, init);
  };

  return proxiedFetch as typeof fetch;
};
