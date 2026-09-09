"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ApproveRestaurantButton } from "@/components/admin/approve-restaurant-button";
import { formatDateTime } from "@/lib/utils/relative-time";
import { initials } from "@/lib/utils/format";
import type { PendingRestaurant } from "@/lib/data-access/admin-stats";

/** How many approvals show before "See more" reveals the rest. */
const PREVIEW = 4;

/**
 * The approval queue on the Orders page. Only the first few show up front so
 * the list never buries the orders below it; "See more" expands the rest.
 *
 * Renders the list and nothing else — no panel, no heading, no count chip. The
 * caller owns those, which is what stops the heading being stated twice when
 * this sits inside a `Section` that already names it. The avatar is initials
 * rather than a generic shop icon: forty identical storefront glyphs down a
 * column tell you nothing, and the initials at least differ per shop.
 */
export function PendingApprovals({ pending }: { pending: PendingRestaurant[] }) {
  const [expanded, setExpanded] = useState(false);

  if (pending.length === 0) return null;

  const visible = expanded ? pending : pending.slice(0, PREVIEW);
  const hidden = pending.length - visible.length;

  return (
    <div>
      <ul className="divide-y divide-[color:var(--c-divider-2)]">
        {visible.map((r) => (
          <li key={r.id} className="flex items-center gap-3 py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-[var(--c-r)] bg-accent-soft text-[11px] font-bold text-accent-ink">
              {initials(r.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-semibold text-ink">
                {r.name}
              </p>
              <p className="text-data truncate text-[11px] text-muted">
                /{r.slug} · applied {formatDateTime(r.createdAt)}
              </p>
            </div>
            <ApproveRestaurantButton id={r.id} name={r.name} variant="compact" />
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="press flex w-full items-center justify-center gap-1 border-t border-[color:var(--c-divider)] pt-2.5 text-[11.5px] font-semibold text-accent-ink"
        >
          See {hidden} more
          <ChevronDown className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
