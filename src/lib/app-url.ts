export const DEFAULT_PRODUCTION_APP_URL = "https://station.savykids.com";

export function resolveAppUrl(requestUrl?: string): string {
  const envUrl = process.env.APP_URL || process.env.VITE_APP_URL;
  if (envUrl && !envUrl.includes("localhost")) {
    return envUrl.replace(/\/+$/, "");
  }

  if (requestUrl) {
    try {
      const parsed = new URL(requestUrl);
      if (!parsed.hostname.includes("localhost") && !parsed.hostname.includes("127.0.0.1")) {
        return parsed.origin.replace(/\/+$/, "");
      }
    } catch {
      // ignore
    }
  }

  return DEFAULT_PRODUCTION_APP_URL;
}
