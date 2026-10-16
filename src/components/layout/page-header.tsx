"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

export function PageHeader({
  title,
  subtitle,
  right,
  transparent,
  className,
}: Readonly<{
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  transparent?: boolean;
  className?: string;
}>) {
  const router = useRouter();
  const t = useT();
  return (
    <header
      className={cn(
        // top-0, not top-[--status-h]: sticky offsets are measured from where
        // .app-scroll's content starts, and its padding-top already clears the
        // status bar. Offsetting again parks the header a status-bar's height
        // too low and the feed shows through the gap above it.
        "sticky top-0 z-20 flex items-center gap-3 px-4 py-3",
        transparent ? "bg-transparent" : "glass",
        className,
      )}
    >
      <button
        onClick={() => router.back()}
        aria-label={t("Go back", "वापस जाएं")}
        className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink"
      >
        <ChevronLeft className="size-5" />
      </button>
      <div className="min-w-0 flex-1">
        {title ? (
          <h1 className="truncate text-[16px] font-extrabold leading-tight tracking-tight">
            {title}
          </h1>
        ) : null}
        {subtitle ? (
          <p className="truncate text-xs text-muted">{subtitle}</p>
        ) : null}
      </div>
      {right}
    </header>
  );
}
