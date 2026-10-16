import Link from "next/link";
import { ApproveRestaurantButton } from "@/components/admin/approve-restaurant-button";
import type { PendingRestaurant } from "@/lib/data-access/admin-stats";
import { formatWaited, initials } from "@/lib/utils/format";

/**
 * "Vendors waiting to go live" — the approval queue as a decision list rather
 * than a link to one. This is the redesign's fix for the clumsy approvals
 * flow: the common case (a shop that has been waiting three days and just
 * needs a yes) is now one click from the dashboard, with no navigation.
 *
 * Oldest first, because a queue worked newest-first is a queue with a tail
 * nobody ever reaches.
 *
 * There is deliberately no Reject here. `restaurants` models approval as a
 * boolean, so the only "no" this schema can express is deletion — and wiring a
 * one-click destructive action into a dashboard card is not a rejection flow,
 * it is an accident waiting to happen. Review opens the vendor, where the
 * suspend and delete controls live behind their own confirmations.
 */
export function ApprovalQueue({
  pending,
  limit = 4,
}: Readonly<{
  pending: PendingRestaurant[];
  limit?: number;
}>) {
  if (!pending.length) {
    return (
      <p className="rounded-lg bg-surface-2 px-3.5 py-6 text-center text-[13px] text-muted">
        Queue is clear — no shops waiting on you.
      </p>
    );
  }

  const shown = [...pending]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);

  return (
    <ul>
      {shown.map((r) => (
        <li
          key={r.id}
          className="flex items-center gap-3 border-b border-[color:var(--c-divider)] py-2.5 last:border-b-0"
        >
          <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-accent-soft text-[11px] font-bold text-accent-ink">
            {initials(r.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold text-ink">
              {r.name}
            </span>
            <span className="text-data block truncate text-[11px] text-muted">
              {formatWaited(r.createdAt)} waiting · /{r.slug}
            </span>
          </span>
          <Link
            href={`/admin/vendors/${r.id}?tab=overview`}
            className="c-btn-quiet press shrink-0"
          >
            Review
          </Link>
          <ApproveRestaurantButton id={r.id} name={r.name} variant="compact" />
        </li>
      ))}
    </ul>
  );
}
