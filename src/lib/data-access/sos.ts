import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureError } from "@/lib/obs/emit";
import { shortOrderId } from "@/lib/utils/order-map";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { isMissingFunction } from "@/lib/data-access/rpc-fallback";
import { getRiderCode, RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import { notifyUser } from "@/lib/notifications/notify-user";
import { notifyOpsSos } from "@/lib/notifications/order-events";
import { removeAttachments, uploadAttachments, validateAttachments } from "@/lib/data-access/support-attachments";
import {
  SOS_DEDUPE_MINUTES,
  categoryLabel,
  isUuid,
  locationLink,
  sosCategory,
  type AttachmentError,
  type SosKind,
} from "@/lib/support/rules";

/**
 * SOS and safety reports (§15): "Alert Deligro" and the five report forms.
 *
 * One incident is one ticket. The write is `rider_raise_sos` (0087, service
 * role only), which takes a per-rider lock and either opens an `emergency`
 * ticket or — when the rider's open emergency was touched in the last 10
 * minutes — appends this tap to it as a location update. Ten panic taps in a
 * minute are therefore one ticket with ten messages (Review Focus 5), and
 * ops are rung ONCE, when the ticket is opened: a push and a ring to every
 * manager and admin (`notifyOpsSos`, ring id `ops:sos:<ticketId>`) with the
 * rider's name, phone and rider ID, the order they hold and a map link. The
 * ring stops when a staff member first acts on the ticket (`support.ts`).
 *
 * WHAT THIS NEVER DOES: contact anything outside Deligro. No call, SMS or
 * message to emergency services, the police or anyone else is made or
 * requested here, and nothing here may say one was. "Call 112" is a phone
 * call the rider's own device places (the app); the rider's inbox row says
 * only that Deligro ops have been alerted — and only once the ticket exists.
 *
 * Authorization: `driverId` is the session's (`/api/rider/sos`,
 * `/api/rider/support/tickets` behind `requireRiderApi()`). An order id from
 * the app is used only if it is this rider's delivery; otherwise — and when
 * none is sent — the rider's active delivery is used. A bad position or order
 * never fails an SOS.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

export type SosResult =
  | {
      ok: true;
      ticketId: string;
      number: number;
      deduped: boolean;
      /**
       * Ops phones were pushed for this tap and the push reached someone: the
       * first tap, or a later one on an emergency staff had acknowledged
       * (re-alert). False for a quiet location update, or when push is not
       * configured — the ticket still exists and the banner still shows it.
       */
      opsRung: boolean;
    }
  | { ok: false; error: AttachmentError };

export interface SosRequest {
  kind: SosKind;
  lat?: number | null;
  lng?: number | null;
  note?: string | null;
  orderId?: string | null;
  attachments?: File[];
  /** Help's subject line, when filed from the ticket form. */
  subject?: string;
}

/** The rider's order for this SOS: theirs if named, else their delivery in flight. */
async function orderFor(supabase: AdminClient, driverId: string, named: string | null | undefined): Promise<string | null> {
  try {
    if (isUuid(named)) {
      const { data } = await supabase
        .from("deliveries")
        .select("order_id")
        .eq("order_id", named)
        .eq("driver_id", driverId)
        .limit(1)
        .overrideTypes<{ order_id: string }[]>();
      if (data?.[0]) return data[0].order_id;
    }
    const { data } = await supabase
      .from("deliveries")
      .select("order_id, assigned_at")
      .eq("driver_id", driverId)
      .in("status", ["assigned", "picked_up"])
      .order("assigned_at", { ascending: false })
      .limit(1)
      .overrideTypes<{ order_id: string }[]>();
    return data?.[0]?.order_id ?? null;
  } catch {
    return null;
  }
}

async function riderInfo(supabase: AdminClient, driverId: string): Promise<{ name: string | null; phone: string | null; code: string | null }> {
  const [profile, code] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, phone")
      .eq("id", driverId)
      .maybeSingle()
      .overrideTypes<{ full_name: string | null; phone: string | null }>()
      .then((r) => r.data, () => null),
    getRiderCode(driverId).catch(() => null),
  ]);
  return { name: profile?.full_name?.trim() || null, phone: profile?.phone ?? null, code };
}

export async function raiseSos(driverId: string, input: SosRequest): Promise<SosResult> {
  const files = input.attachments ?? [];
  const bad = await validateAttachments(files);
  if (bad) return { ok: false, error: bad };

  const supabase = createAdminClient();
  const category = sosCategory(input.kind);
  const label = input.kind === "alert" ? "SOS" : categoryLabel(category);
  const lat = typeof input.lat === "number" ? input.lat : null;
  const lng = typeof input.lng === "number" ? input.lng : null;
  const link = locationLink(lat, lng);
  const note = input.note?.trim() || null;
  const orderId = await orderFor(supabase, driverId, input.orderId);

  const body = [
    input.kind === "alert" ? "SOS pressed." : `Safety report: ${label}.`,
    link ? `Location: ${link}` : "Location not shared.",
    note ? `Note: ${note}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const paths = await uploadAttachments(driverId, files, supabase);
  const { data: raw, error } = await supabase.rpc("rider_raise_sos", {
    p_driver: driverId,
    p_category: category,
    p_subject: input.subject?.trim() || (input.kind === "alert" ? "SOS — rider needs help" : `Safety report: ${label}`),
    p_body: body,
    p_lat: lat,
    p_lng: lng,
    p_order: orderId,
    p_attachments: paths,
    p_window_minutes: SOS_DEDUPE_MINUTES,
  });
  const data = raw as { ticket_id: string; number: number; deduped: boolean; rering?: boolean } | null;
  if (error || !data) {
    await removeAttachments(paths, supabase);
    if (error && (isMissingFunction(error) || isMissingTable(error))) {
      throw new RiderSchemaPendingError("migration_pending: rider_raise_sos (0087) is not applied");
    }
    throw error ?? new Error("sos_not_recorded");
  }

  const deduped = data.deduped === true;
  // A later tap on an emergency staff already acknowledged: ring again
  // (rider_raise_sos throttles this to once a minute per ticket).
  const again = deduped && data.rering === true;
  let opsRung = false;
  if (!deduped || again) {
    // Awaited, not deferred: the app shows "Deligro ops have been alerted"
    // only after this answers, so the alert must have been sent by then.
    try {
      const who = await riderInfo(supabase, driverId);
      opsRung = await notifyOpsSos(data.ticket_id, {
        kindLabel: label,
        riderName: who.name,
        riderPhone: who.phone,
        riderCode: who.code,
        orderCode: orderId ? `#${shortOrderId(orderId)}` : null,
        locationUrl: link,
        note,
        again,
        riderId: driverId,
        orderId,
      });
    } catch (e) {
      captureError(e, { source: "sos/notify", driverId, attrs: { event: "sos_ops_push_failed" } });
    }
  }
  const result = { ok: true as const, ticketId: data.ticket_id, number: Number(data.number), deduped, opsRung };
  if (!deduped) {
    try {
      // The rider's own record — inbox only: a push to someone in an
      // emergency is noise. Worded to say exactly what happened.
      await notifyUser({
        userId: driverId,
        role: "rider",
        category: "safety",
        title: "SOS sent",
        body: `Deligro ops have been alerted. Ticket #${result.number}.`,
        url: `/help/tickets/${result.ticketId}`,
        data: { ticketId: result.ticketId },
        push: false,
      });
    } catch (e) {
      captureError(e, { source: "sos/notify", driverId, attrs: { event: "sos_notify_failed" } });
    }
  }
  return result;
}
