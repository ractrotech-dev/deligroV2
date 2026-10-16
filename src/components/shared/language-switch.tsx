"use client";

import { useLang } from "@/components/providers/lang-provider";
import type { Lang } from "@/lib/i18n/lang";
import { cn } from "@/lib/utils/cn";

// Each option is written in its own script, so someone who reads only one of
// them can still find theirs.
const OPTIONS: { lang: Lang; label: string }[] = [
  { lang: "en", label: "English" },
  { lang: "hi", label: "हिंदी" },
];

/** English / हिंदी. Used in Profile and on the login screen. */
export function LanguageSwitch({ className }: Readonly<{ className?: string }>) {
  const { lang, setLang, t } = useLang();

  return (
    <div
      role="radiogroup"
      aria-label={t("Language", "भाषा")}
      className={cn("inline-flex rounded-full border border-line bg-surface p-1", className)}
    >
      {OPTIONS.map((o) => {
        const active = o.lang === lang;
        return (
          <button
            key={o.lang}
            type="button"
            role="radio"
            aria-checked={active}
            lang={o.lang}
            onClick={() => (active ? undefined : setLang(o.lang))}
            className={cn(
              "press min-w-[84px] rounded-full px-4 py-2 text-sm font-bold transition-colors",
              active ? "bg-accent text-white" : "text-muted"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
