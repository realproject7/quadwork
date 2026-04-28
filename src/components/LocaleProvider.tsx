"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { detectBrowserLocale, LOCALE_COOKIE_KEY, LOCALE_STORAGE_KEY, type Locale, normalizeLocale } from "@/lib/locale";

interface LocaleContextValue {
  hydrated: boolean;
  locale: Locale;
  setLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    setLocaleState(detectBrowserLocale());
    setHydrated(true);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {}
    try {
      document.cookie = `${LOCALE_COOKIE_KEY}=${locale}; path=/; max-age=31536000; samesite=lax`;
    } catch {}
  }, [locale]);

  const value = useMemo<LocaleContextValue>(() => ({
    hydrated,
    locale,
    setLocale: (next) => setLocaleState(normalizeLocale(next)),
  }), [hydrated, locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used within LocaleProvider");
  return value;
}
