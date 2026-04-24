export const LOCALE_STORAGE_KEY = "qw-locale";
export const LOCALE_COOKIE_KEY = "qw-locale";

export type Locale = "en" | "ko";

export function normalizeLocale(value: unknown): Locale {
  return value === "ko" ? "ko" : "en";
}

export function detectBrowserLocale(): Locale {
  if (typeof window === "undefined") return "en";

  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored) return normalizeLocale(stored);
  } catch {}

  return window.navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}
