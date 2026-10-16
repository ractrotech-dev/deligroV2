"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useT } from "@/components/providers/lang-provider";

export function ProfileSubpage({
  title,
  children,
}: Readonly<{
  title: string;
  children: React.ReactNode;
}>) {
  const t = useT();
  return (
    <div className="px-4 pb-8 pt-5">
      <header className="mb-5 flex items-center gap-3">
        <Link
          href="/profile"
          aria-label={t("Back to profile", "प्रोफ़ाइल पर वापस")}
          className="press grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="text-[22px] font-extrabold tracking-tight">{title}</h1>
      </header>
      {children}
    </div>
  );
}
