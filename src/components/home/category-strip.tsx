"use client";

import Link from "next/link";
import { CategoryIcon } from "./category-icon";
import type { Category } from "@/types";
import { categoryLabel } from "@/lib/taxonomy";
import { useLang } from "@/components/providers/lang-provider";

/**
 * The Home cuisine strip.
 *
 * Categories are passed in rather than read from the module, because each
 * tile's picture can be replaced by an operator and only a server component can
 * resolve that — see `lib/categories.ts`. Nothing here decides what a tile shows;
 * it lays them out.
 */
export function CategoryStrip({ categories }: Readonly<{ categories: Category[] }>) {
  const { lang } = useLang();
  return (
    <div className="no-scrollbar flex gap-2 overflow-x-auto px-4">
      {categories.map((c) => (
        <Link
          key={c.id}
          href={`/search?category=${c.id}`}
          className="press flex w-[68px] shrink-0 flex-col items-center gap-1.5"
        >
          <span className="block size-16 shrink-0">
            <CategoryIcon
              id={c.id}
              image={c.image}
              tint={c.tint}
              emoji={c.emoji}
              label={categoryLabel(lang, c)}
            />
          </span>
          <span className="line-clamp-2 w-full text-center text-[12px] font-semibold leading-tight text-ink">
            {categoryLabel(lang, c)}
          </span>
        </Link>
      ))}
    </div>
  );
}
