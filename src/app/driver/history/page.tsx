import Link from "next/link";
import { ClipboardList, MapPin, Store } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth";
import { getDriverHistory } from "@/lib/data-access/driver-orders";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR } from "@/lib/utils/format";

/**
 * Everything this rider has delivered, newest first.
 *
 * Platform: the courier phone shell, like the rest of /driver.
 *
 * Real rows only. There is no demo array behind this and there deliberately
 * never will be: `driver/page.tsx` carries a long comment about the time
 * fabricated jobs and a fabricated ₹640 of earnings were shown to real riders,
 * and a history of deliveries somebody never made is the same mistake with a
 * longer memory. With no backend this renders the empty state.
 *
 * Paged by cursor rather than page number — see `getDriverHistory` for why a
 * list that grows at the top cannot be offset-paged. The "Load older" control
 * is a plain link carrying the cursor, so the screen needs no client state and
 * the back button behaves.
 */
export const dynamic = "force-dynamic";

/** Day heading: "Today", "Yesterday", else "Tue, 9 Sep". */
function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    // Only once the year stops being obvious — a rider scrolling back through
    // last season does not want to read "2026" on every heading.
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function DriverHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
}) {
  // The layout gates this too. Repeated because a Server Component is reachable
  // on its own, and because `profile.id` below IS the authorization for the
  // query — it must come from the session, never from the URL.
  const profile = await requireRole("driver");
  const { before } = await searchParams;

  if (!isSupabaseConfigured) {
    return (
      <EmptyState
        className="mt-10"
        icon={<ClipboardList className="size-7" />}
        title="No deliveries yet"
        description="Your finished deliveries will be listed here."
      />
    );
  }

  const { items, nextCursor } = await getDriverHistory(profile.id, {
    cursor: before ?? null,
  });

  if (items.length === 0) {
    return (
      <EmptyState
        className="mt-10"
        icon={<ClipboardList className="size-7" />}
        title={before ? "Nothing older" : "No deliveries yet"}
        description={
          before
            ? "You've reached the end of your history."
            : "Once you complete a delivery it will show up here, with the shop, the drop and what the order came to."
        }
        action={
          before ? (
            <Link href="/driver/history">
              <Button>Back to the top</Button>
            </Link>
          ) : (
            <Link href="/driver">
              <Button>Find a job</Button>
            </Link>
          )
        }
      />
    );
  }

  // Grouped in the render rather than the query: the page is at most 20 rows,
  // and asking Postgres to bucket by local calendar day would mean pinning a
  // timezone in SQL that the browser is about to reinterpret anyway.
  const now = new Date();
  const groups: { label: string; items: typeof items }[] = [];
  for (const item of items) {
    const label = dayLabel(item.deliveredAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-label">Delivery history</p>
        <h1 className="mt-0.5 text-xl font-extrabold tracking-tight">
          {before ? "Older deliveries" : "What you've delivered"}
        </h1>
      </header>

      {groups.map((group) => (
        <section key={group.label} className="space-y-2">
          <p className="text-label px-0.5">{group.label}</p>
          <div className="card divide-y divide-[color:var(--line)] overflow-hidden p-0">
            {group.items.map((item) => (
              <article key={item.orderId} className="flex items-start gap-3 p-3.5">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                  <Store className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[15px] font-semibold">
                      {item.restaurantName}
                    </p>
                    <span className="text-data shrink-0 text-xs text-muted">
                      {timeLabel(item.deliveredAt)}
                    </span>
                  </div>
                  {item.dropArea ? (
                    <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted">
                      <MapPin className="size-3 shrink-0" />
                      {item.dropArea}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted">
                    {item.itemCount} {item.itemCount === 1 ? "item" : "items"}
                    {" · "}
                    <span className="text-data font-semibold text-ink">
                      {formatINR(item.total)}
                    </span>{" "}
                    order value
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      {nextCursor ? (
        <Link
          href={`/driver/history?before=${encodeURIComponent(nextCursor)}`}
          className="block"
        >
          <Button variant="outline" className="w-full">
            Load older
          </Button>
        </Link>
      ) : (
        <p className="pb-1 text-center text-xs text-muted">
          That&apos;s everything.
        </p>
      )}
    </div>
  );
}
