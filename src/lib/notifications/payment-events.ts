import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFeatures } from "@/lib/features/flags.server";
import { notifyUser, type NotificationRole } from "./notify-user";

/**
 * Money notices for staff and riders (§5.13, §5.14): a payout waiting for a
 * checker, a payout decided, a cash deposit decided. Inbox row + push through
 * `notifyUser`; fire-and-forget (call through deferNotify) — a failed notice
 * never undoes the money it is about. Staff text is English only (owner's rule
 * for the manager side).
 */

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

interface RequestRow {
  id: string;
  kind: string;
  subject_id: string;
  zone_id: string | null;
  amount: number | string;
  status: string;
  requested_by: string;
  decided_by: string | null;
  decision_note: string | null;
}

async function requestRow(id: string): Promise<RequestRow | null> {
  const { data } = await createAdminClient()
    .from("payment_requests")
    .select("id, kind, subject_id, zone_id, amount, status, requested_by, decided_by, decision_note")
    .eq("id", id)
    .maybeSingle<RequestRow>();
  return data ?? null;
}

async function nameOf(id: string): Promise<string> {
  const { data } = await createAdminClient().from("profiles").select("full_name").eq("id", id).maybeSingle<{ full_name: string | null }>();
  return data?.full_name?.trim() || "a rider";
}

/**
 * A payout is waiting: every admin, and the managers of its zone who hold
 * manager.finance.approve_payment — never the person who asked (they cannot
 * approve it).
 */
export async function notifyPaymentRequested(requestId: string): Promise<void> {
  try {
    const r = await requestRow(requestId);
    if (!r || r.status !== "pending_approval") return;
    const supabase = createAdminClient();
    const { data: staff } = await supabase.from("profiles").select("id, role").in("role", ["admin", "manager"]);
    const people = (staff ?? []) as { id: string; role: string }[];
    const inZone = new Set<string>();
    if (r.zone_id) {
      const { data: zs } = await supabase.from("staff_zones").select("user_id").eq("zone_id", r.zone_id);
      for (const z of (zs ?? []) as { user_id: string }[]) inZone.add(z.user_id);
    }
    const who = await nameOf(r.subject_id);
    for (const p of people) {
      if (p.id === r.requested_by) continue;
      if (p.role === "manager") {
        if (!inZone.has(p.id)) continue;
        const f = await getFeatures("manager", p.id);
        if (!f["manager.finance.approve_payment"]) continue;
      }
      await notifyUser({
        userId: p.id,
        role: p.role as NotificationRole,
        category: "payments",
        title: "Payout waiting for approval",
        body: `${rupees(Number(r.amount))} for ${who}`,
        url: `/more/approvals/${r.id}`,
        data: { requestId: r.id },
      });
    }
  } catch {
    // fire-and-forget
  }
}

/** The requester learns the outcome; on approval the rider learns their payout was recorded. */
export async function notifyPaymentDecided(requestId: string): Promise<void> {
  try {
    const r = await requestRow(requestId);
    if (!r || r.status === "pending_approval") return;
    const { data: requester } = await createAdminClient().from("profiles").select("role").eq("id", r.requested_by).maybeSingle<{ role: string }>();
    const who = await nameOf(r.subject_id);
    const word = r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : "cancelled";
    if (r.status !== "cancelled") {
      await notifyUser({
        userId: r.requested_by,
        role: (requester?.role ?? "manager") as NotificationRole,
        category: "payments",
        title: `Payout ${word}`,
        body: `${rupees(Number(r.amount))} for ${who}${r.status === "rejected" && r.decision_note ? ` — ${r.decision_note}` : ""}`,
        url: `/more/approvals/${r.id}`,
        data: { requestId: r.id },
      });
    }
    if (r.status === "approved" && r.kind === "rider_payout") {
      await notifyUser({
        userId: r.subject_id,
        role: "rider",
        category: "payouts",
        title: "Payout recorded",
        body: `${rupees(Number(r.amount))} has been paid to you.`,
        url: "/earnings",
        data: { requestId: r.id },
      });
    }
  } catch {
    // fire-and-forget
  }
}

/** The rider learns a deposit they declared was confirmed or disputed. */
export async function notifyRiderDepositDecided(depositId: string): Promise<void> {
  try {
    const { data } = await createAdminClient()
      .from("cash_deposits")
      .select("driver_id, amount, status, decision_note")
      .eq("id", depositId)
      .maybeSingle<{ driver_id: string; amount: number; status: string; decision_note: string | null }>();
    if (!data || (data.status !== "confirmed" && data.status !== "disputed")) return;
    await notifyUser({
      userId: data.driver_id,
      role: "rider",
      category: "cash",
      title: data.status === "confirmed" ? "Deposit confirmed" : "Deposit disputed",
      body: data.status === "confirmed"
        ? `${rupees(data.amount)} received. Thank you.`
        : `${rupees(data.amount)}: ${data.decision_note ?? "please talk to your manager"}`,
      url: "/more/cash",
      data: { depositId },
    });
  } catch {
    // fire-and-forget
  }
}
