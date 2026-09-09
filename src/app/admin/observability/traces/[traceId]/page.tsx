import Link from "next/link";
import { Route } from "lucide-react";
import { AdminHero, EmptyState, Panel } from "@/components/admin/admin-ui";
import { AttrGrid, LevelTag, StackViewer, ms } from "@/components/admin/obs-ui";
import { getTrace } from "@/lib/obs/read";
import { cn } from "@/lib/utils/cn";

/**
 * Observability → one trace.
 *
 * The end-to-end view: checkout → Razorpay order → webhook → settle → dispatch
 * → push, as one story in the order it happened. Ascending in time, unlike
 * every other list in this section, because a trace is read forwards.
 *
 * The waterfall is offsets from the first event, drawn as bars. It is not a
 * true span tree — this platform is a monolith calling three HTTP providers and
 * a database, so there is no distributed span hierarchy to reconstruct, and
 * drawing one would imply a structure that does not exist. What it does show,
 * accurately, is where the time went.
 *
 * The webhook leg is here at all because `settlePayment` rejoins the customer's
 * original trace through `payments.provider_order_id` — Razorpay carries no
 * header of ours, so the join is a real column rather than a guess.
 */
export const dynamic = "force-dynamic";

export default async function TracePage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  const events = (await getTrace(traceId)).data;

  if (events.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <AdminHero
          backHref="/admin/observability/logs"
          backLabel="Logs"
          title="Trace"
          subtitle={traceId}
        />
        <EmptyState
          icon={Route}
          title="Nothing recorded for this trace"
          description="Either the id is wrong, or its events have passed the 14-day raw retention window. Aggregate counts survive that; individual events do not."
        />
      </div>
    );
  }

  const start = new Date(events[0].occurredAt).getTime();
  const end = events.reduce((max, e) => {
    const t = new Date(e.occurredAt).getTime() + (e.durationMs ?? 0);
    return Math.max(max, t);
  }, start);
  // A zero-width span would divide by zero and draw nothing. One millisecond of
  // floor keeps a single-event trace rendering as a full-width bar, which is
  // the honest picture of "it all happened at once".
  const span = Math.max(1, end - start);

  const orders = [...new Set(events.map((e) => e.orderId).filter(Boolean))];
  const failed = events.filter((e) => e.level === "error" || e.level === "fatal");

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        backHref="/admin/observability/logs"
        backLabel="Logs"
        title="Trace"
        subtitle={traceId}
        tag={`${events.length} events · ${ms(span)}`}
        badge={
          failed.length ? (
            <span className="rounded border border-deal/30 bg-deal-soft px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-deal">
              {failed.length} failed
            </span>
          ) : null
        }
      />

      {orders.length ? (
        <p className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink">
          Touches{" "}
          {orders.map((id, i) => (
            <span key={id}>
              {i > 0 ? ", " : ""}
              <Link
                href={`/admin/orders/${id}`}
                className="text-data underline underline-offset-2"
              >
                order {id!.slice(0, 8).toUpperCase()}
              </Link>
            </span>
          ))}
          .
        </p>
      ) : null}

      <Panel
        title="Waterfall"
        subtitle="Offsets from the first event. Not a span tree — this is a monolith, so there is no distributed hierarchy to draw."
      >
        <ol className="flex flex-col">
          {events.map((e, i) => {
            const at = new Date(e.occurredAt).getTime();
            const offsetPct = ((at - start) / span) * 100;
            const widthPct = Math.max(0.8, ((e.durationMs ?? 0) / span) * 100);
            const bad = e.level === "error" || e.level === "fatal";
            return (
              <li
                key={e.id}
                className="border-b border-line/60 py-2 last:border-0"
              >
                <div className="flex items-baseline gap-2">
                  <LevelTag level={e.level} />
                  <span className="text-data w-[62px] shrink-0 text-[11px] tabular-nums text-muted">
                    +{ms(at - start)}
                  </span>
                  <span className="text-data w-[132px] shrink-0 truncate text-[11.5px] text-muted">
                    {e.source}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {e.message}
                  </span>
                  <span className="text-data w-[56px] shrink-0 text-right text-[11.5px] tabular-nums text-muted">
                    {ms(e.durationMs)}
                  </span>
                </div>

                <div className="mt-1.5 h-[6px] w-full overflow-hidden rounded-full bg-[var(--line)]/50">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      bad ? "bg-deal" : e.provider ? "bg-blue" : "bg-ink/60"
                    )}
                    style={{
                      marginLeft: `${Math.min(99, offsetPct)}%`,
                      width: `${Math.min(100 - Math.min(99, offsetPct), widthPct)}%`,
                    }}
                  />
                </div>

                {i === events.length - 1 || bad ? null : null}

                {bad || Object.keys(e.attrs).length ? (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer list-none text-[11.5px] text-muted underline underline-offset-2">
                      Details
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                      {Object.keys(e.attrs).length ? (
                        <AttrGrid attrs={e.attrs} />
                      ) : null}
                      {e.stack ? <StackViewer stack={e.stack} /> : null}
                    </div>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Panel>
    </div>
  );
}
