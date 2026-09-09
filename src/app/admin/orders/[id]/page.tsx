import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  Fact,
  FactList,
  FinancialBreakdown,
  PageHeader,
  Panel,
  Section,
  SectionCol,
  SectionRow,
  StatusBadge,
  Timeline,
  type Stage,
  type StageState,
} from "@/components/admin/console";
import { ORDER_STATUS, STATUS_TONE } from "@/components/admin/order-status";
import { OrderIntervention } from "@/components/admin/order-intervention";
import { formatINR } from "@/lib/utils/format";
import { formatDateTime } from "@/lib/utils/relative-time";
import {
  getAdminOrderDetail,
  type AdminOrderDetail,
} from "@/lib/data-access/admin-orders";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Order · Admin · Deligro" };

/**
 * Admin → one order.
 *
 * The lifecycle is the subject of this screen, so it is drawn first and drawn
 * whole: one timeline from "placed" to "delivered", rather than the two
 * separate stage lists this page used to carry — an order lifecycle in one
 * panel and a delivery lifecycle in another, four panels apart, which left the
 * reader interleaving two sets of timestamps by eye to answer "so where is it".
 *
 * Everything else is context for that: who and where on the right, what was
 * ordered and what it cost below, and the intervention controls last, where a
 * destructive action is not the first thing under the cursor.
 *
 * ## Unknown is not the same as un-reached
 *
 * This deployment may predate migrations 0025 (payment columns) and 0026
 * (lifecycle stamps). Where it does, the stage says "not recorded by this
 * database" instead of "not yet" — because concluding that a kitchen never
 * accepted an order it did accept is exactly the mistake a row of blanks
 * invites. `AdminOrderDetail` carries `lifecycleKnown` and `paymentKnown` for
 * this, and both are honoured here.
 */
export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // No demo fallback. The seed rows in ADMIN_ORDERS have no ids and no line
  // items, so a fabricated detail screen here would be a mock of the one screen
  // whose entire job is to be the record of what actually happened.
  if (!isSupabaseConfigured) notFound();

  const order = await getAdminOrderDetail(id);
  if (!order) notFound();

  const stage = ORDER_STATUS[order.status];
  const late = order.lateByMinutes !== null;

  return (
    <>
      <PageHeader
        title={order.code}
        description={`Placed ${order.placedAt}${
          order.restaurant ? ` · ${order.restaurant.name}` : ""
        }`}
        back={{ href: "/admin/orders", label: "Orders" }}
        status={
          <>
            <StatusBadge tone={STATUS_TONE[order.status]}>
              {stage.label}
            </StatusBadge>
            {late ? (
              <StatusBadge tone="red">{order.lateByMinutes} min late</StatusBadge>
            ) : null}
          </>
        }
        actions={
          <div className="text-right">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
              Order total
            </p>
            <p className="text-data mt-1 text-[22px] font-bold leading-none tracking-[-0.025em] tabular-nums">
              {formatINR(order.total)}
            </p>
          </div>
        }
      />

      <SectionRow>
        <SectionCol grow={1.2} basis={320}>
          <Section
            flush
            title="Progress"
            meta={
              order.lifecycleKnown
                ? "stamped by the database on each transition"
                : "partly unrecorded"
            }
          >
            <Timeline stages={lifecycle(order)} />
          </Section>
        </SectionCol>

        <SectionCol basis={280}>
          <Section flush title="Who and where">
            <FactList>
              <Fact label="Customer">
                {order.customer ? (
                  <Link
                    href={`/admin/customers/${order.customer.id}`}
                    className="font-medium text-ink hover:text-accent-ink hover:underline"
                  >
                    {order.customer.name}
                  </Link>
                ) : (
                  <span className="text-muted">Profile removed</span>
                )}
              </Fact>

              <Fact label="Phone">
                {order.customer?.phone ? (
                  <a
                    href={`tel:${order.customer.phone}`}
                    className="text-data hover:text-accent-ink"
                  >
                    {order.customer.phone}
                  </a>
                ) : (
                  <span className="text-muted">None on file</span>
                )}
              </Fact>

              <Fact label="Vendor">
                {order.restaurant ? (
                  <Link
                    href={`/admin/vendors/${order.restaurant.id}`}
                    className="font-medium text-ink hover:text-accent-ink hover:underline"
                  >
                    {order.restaurant.name}
                  </Link>
                ) : (
                  <span className="text-muted">No longer listed</span>
                )}
              </Fact>

              <Fact label="Delivering to">
                {order.address.line || order.address.label ? (
                  <span>
                    {order.address.label ? (
                      <span className="font-medium">
                        {order.address.label}
                        {order.address.line ? " · " : ""}
                      </span>
                    ) : null}
                    {order.address.line}
                  </span>
                ) : (
                  <span className="text-muted">No address recorded</span>
                )}
              </Fact>

              <Fact label="Rider">
                {order.delivery?.rider?.name ? (
                  <span>
                    {order.delivery.rider.name}
                    {order.delivery.rider.phone ? (
                      <a
                        href={`tel:${order.delivery.rider.phone}`}
                        className="text-data ml-1.5 text-muted hover:text-accent-ink"
                      >
                        {order.delivery.rider.phone}
                      </a>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-[color:var(--c-ink-amber)]">
                    Not assigned
                  </span>
                )}
              </Fact>

              <Fact label="Payment">
                {!order.paymentKnown ? (
                  <span className="text-muted">Cash (pre-0025 database)</span>
                ) : (
                  <span>
                    {order.paymentMethod === "online"
                      ? "Online"
                      : order.paymentMethod === "cod"
                        ? "Cash on delivery"
                        : "Not recorded"}
                    {order.paymentStatus ? (
                      <span
                        className={
                          order.paymentStatus === "paid"
                            ? "ml-1.5 font-semibold text-green"
                            : order.paymentStatus === "failed"
                              ? "ml-1.5 font-semibold text-deal"
                              : "ml-1.5 font-semibold text-[color:var(--c-ink-amber)]"
                        }
                      >
                        {order.paymentStatus}
                      </span>
                    ) : null}
                  </span>
                )}
              </Fact>

              {/* Whether the map the customer watched was real. A delivery row
                  written before 0026 cannot answer, and calling it "estimated"
                  there would be as much of a guess as the dot itself was. */}
              {order.delivery ? (
                <Fact label="Rider position">
                  {!order.delivery.locationSourceKnown ? (
                    <span className="text-muted">Not recorded</span>
                  ) : order.delivery.locationSource === "gps" ? (
                    "Reported by the courier's device"
                  ) : (
                    <span className="text-[color:var(--c-ink-amber)]">
                      Estimated — no device fix reported
                    </span>
                  )}
                </Fact>
              ) : null}
            </FactList>
          </Section>
        </SectionCol>
      </SectionRow>

      <SectionRow>
        <SectionCol grow={1.4} basis={340}>
          <Section
            flush
            title="Items"
            meta={`${order.items.length} line${order.items.length === 1 ? "" : "s"}`}
          >
            {order.items.length === 0 ? (
              <p className="c-empty">
                No line items recorded against this order.
              </p>
            ) : (
              <ul className="divide-y divide-[color:var(--c-divider-2)]">
                {order.items.map((item, i) => (
                  <li
                    key={`${item.name}-${i}`}
                    className="flex items-start justify-between gap-4 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-ink">
                        {item.name}
                      </p>
                      <p className="text-data text-[11px] text-muted">
                        {item.qty} × {formatINR(item.price)}
                      </p>
                    </div>
                    <p className="text-data shrink-0 text-[12.5px] font-semibold tabular-nums">
                      {formatINR(item.qty * item.price)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </SectionCol>

        <SectionCol basis={260}>
          <Section flush title="What the customer paid">
            <FinancialBreakdown
              lines={[
                { label: "Subtotal", value: formatINR(order.subtotal) },
                { label: "Delivery fee", value: formatINR(order.deliveryFee) },
                { label: "Tax", value: formatINR(order.taxAmount) },
                {
                  label: "Tip",
                  // Null means the column does not exist on this database,
                  // which is not the same as a customer who left nothing.
                  value: order.tip === null ? "—" : formatINR(order.tip),
                  note:
                    order.tip === null
                      ? "Not recorded by this database"
                      : undefined,
                },
              ]}
              total={{ label: "Total", value: formatINR(order.total) }}
            />
          </Section>
        </SectionCol>
      </SectionRow>

      <Panel
        title="Intervene"
        description="Admin-only. The customer is notified of whatever you do here."
        className="admin-measure"
      >
        <OrderIntervention
          orderId={order.id}
          dbStatus={order.dbStatus}
          refundable={
            order.paymentMethod === "online" && order.paymentStatus === "paid"
          }
        />
      </Panel>
    </>
  );
}

/**
 * The order's whole life as one list, kitchen and delivery interleaved in the
 * order they actually happen.
 *
 * The two lifecycles are stored separately — `orders` carries accepted/ready
 * (0026) and `deliveries` carries assigned/picked-up/delivered — and this is
 * the only place they are stitched together. The page used to render them as
 * two stage lists four panels apart, which left the reader interleaving two
 * sets of timestamps by eye to answer "so where is it".
 *
 * ## Reached-ness comes from the status, not from the timestamps
 *
 * This is the important part. A stage is done because the order has *moved
 * past* it, which `orders.status` states directly and which is true on every
 * deployment. Reading it off the timestamp instead makes every stage look
 * un-reached on a database that predates the migration which added the stamp —
 * so a delivered order rendered as "Delivered · not yet", and an operator
 * checking whether a kitchen ever accepted an order would have concluded it
 * had not. The stamps are used for one thing only: saying *when*. Where a stage
 * is done and its stamp is missing, it says so.
 *
 * Cancellation replaces the tail rather than appending to it: a cancelled order
 * did not go on to be delivered, and leaving three grey "not yet" rows under it
 * implies it is still waiting for a rider.
 */
function lifecycle(order: AdminOrderDetail): Stage[] {
  const at = (v: string | null | undefined) => (v ? formatDateTime(v) : null);

  /** How far the order has got. The index each stage below is measured against. */
  const REACHED: Record<AdminOrderDetail["status"], number> = {
    PLACED: 0,
    KITCHEN: 1,
    READY: 2,
    ON_THE_WAY: 4,
    DELIVERED: 5,
    // Never used — a cancelled order returns early below — but the record is
    // exhaustive so a new status cannot silently default to "placed".
    CANCELLED: 0,
  };
  const reached = REACHED[order.status];

  const state = (index: number): StageState =>
    reached > index ? "done" : reached === index ? "current" : "pending";

  /**
   * A stage that happened but has no timestamp. Only ever true where a
   * migration had not yet added the column — the stage itself is not in doubt.
   */
  const stamp = (
    index: number,
    value: string | null | undefined,
    known = true
  ): Pick<Stage, "at" | "atFallback"> => {
    const shown = at(value);
    if (shown) return { at: shown };
    return {
      at: null,
      atFallback:
        reached > index
          ? known
            ? "Time not recorded"
            : "Not recorded by this database"
          : undefined,
    };
  };

  const placed: Stage = {
    label: "Order placed",
    at: at(order.createdAt),
    state: "done",
  };

  if (order.cancelledAt || order.status === "CANCELLED") {
    return [
      placed,
      {
        label: "Cancelled",
        ...stamp(0, order.cancelledAt, order.lifecycleKnown),
        state: "done",
        tone: "bad",
        detail: "The rest of the lifecycle did not happen.",
      },
    ];
  }

  const d = order.delivery;

  return [
    placed,
    {
      label: "Restaurant accepted",
      ...stamp(1, order.acceptedAt, order.lifecycleKnown),
      state: state(1),
    },
    {
      label: "Food ready",
      ...stamp(2, order.readyAt, order.lifecycleKnown),
      state: state(2),
    },
    {
      // A rider can be assigned while the kitchen is still cooking, so this
      // stage is driven by the delivery row rather than by the order's status —
      // it is the one step whose truth does not live in `orders.status` at all.
      label: "Rider assigned",
      at: at(d?.assignedAt),
      state: d?.assignedAt ? "done" : reached >= 3 ? "done" : "pending",
      detail: d?.rider?.name ?? undefined,
    },
    {
      label: "Out for delivery",
      ...stamp(4, d?.pickedUpAt),
      state: state(4),
    },
    {
      label: "Delivered",
      ...stamp(5, d?.deliveredAt),
      state: state(5),
    },
  ];
}
