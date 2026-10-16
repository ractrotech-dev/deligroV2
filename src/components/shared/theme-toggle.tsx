"use client";

import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { useUI } from "@/stores/ui-store";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

export function ThemeToggle({ className }: Readonly<{ className?: string }>) {
  const theme = useUI((s) => s.theme);
  const hydrated = useUI((s) => s.hydrated);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const initTheme = useUI((s) => s.initTheme);
  const t = useT();

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  const isDark = theme === "dark";

  return (
    <button
      onClick={toggleTheme}
      aria-label={
        isDark
          ? t("Switch to light mode", "लाइट मोड चालू करें")
          : t("Switch to dark mode", "डार्क मोड चालू करें")
      }
      className={cn(
        "press grid size-10 place-items-center rounded-full border border-line bg-surface text-ink",
        className,
      )}
    >
      {/* render neutral until hydrated to avoid mismatch */}
      {hydrated ? (
        isDark ? (
          <Sun className="size-[18px]" />
        ) : (
          <Moon className="size-[18px]" />
        )
      ) : (
        <Moon className="size-[18px] opacity-0" />
      )}
    </button>
  );
}
