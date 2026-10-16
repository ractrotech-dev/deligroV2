"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_LANG, langCookie, translator, type Lang, type T } from "@/lib/i18n/lang";

type LangState = { lang: Lang; t: T; setLang: (lang: Lang) => void };

// Outside a provider (an operator screen reusing a customer component) the
// text is English, and there is nothing to switch.
const LangContext = createContext<LangState>({
  lang: DEFAULT_LANG,
  t: translator(DEFAULT_LANG),
  setLang: () => {},
});

/**
 * `initial` comes from the cookie, read on the server (lib/i18n/server.ts), so
 * the first paint is already in the right language.
 */
export function LangProvider({ initial, children }: Readonly<{ initial: Lang; children: React.ReactNode }>) {
  const [lang, setLangState] = useState<Lang>(initial);
  const router = useRouter();

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback(
    (next: Lang) => {
      document.cookie = langCookie(next);
      setLangState(next);
      // Server components read the cookie; re-render them in the new language.
      router.refresh();
    },
    [router]
  );

  const value = useMemo(() => ({ lang, t: translator(lang), setLang }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangState {
  return useContext(LangContext);
}

/** `const t = useT(); t("Home", "होम")` */
export function useT(): T {
  return useContext(LangContext).t;
}
