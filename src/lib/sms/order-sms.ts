import "server-only";
import { toLocal10 } from "@/lib/auth/phone";
import { recordProvider } from "@/lib/obs/emit";

/**
 * Transactional SMS (the new-order text to a shop) through any HTTP gateway.
 *
 * The OTP gateway (renflair.ts) only accepts a one-time code, never free
 * text, so a "new order" message needs a gateway that sends a whole message.
 * Which one is the owner's choice, so it is configured, not coded:
 *
 *   ORDER_SMS_URL     the request URL, with placeholders filled in per message:
 *                     {phone}   E.164 (+9198…), {phone10} 10-digit local,
 *                     {message} the text. All URL-encoded. Example:
 *                     https://gateway.example/send?key=XXX&to={phone10}&text={message}
 *   ORDER_SMS_METHOD  GET (default) or POST. POST sends the filled URL with an
 *                     empty body — enough for gateways that take query params.
 *
 * Unset means not configured: nothing is sent and the admin SMS page says so.
 * Indian gateways need the message to match a DLT-registered template; the
 * template is edited on that page (src/app/admin/settings/sms).
 *
 * Never logged: the URL. It carries the gateway key and the phone number.
 */

export function orderSmsConfigured(): boolean {
  return Boolean(process.env.ORDER_SMS_URL?.trim());
}

export async function sendOrderSms(e164: string, message: string): Promise<{ sent: boolean; detail?: string }> {
  const template = process.env.ORDER_SMS_URL?.trim();
  if (!template) return { sent: false, detail: "ORDER_SMS_URL not set" };
  const url = template
    .replaceAll("{phone10}", encodeURIComponent(toLocal10(e164)))
    .replaceAll("{phone}", encodeURIComponent(e164))
    .replaceAll("{message}", encodeURIComponent(message));
  const method = process.env.ORDER_SMS_METHOD?.trim().toUpperCase() === "POST" ? "POST" : "GET";

  const started = Date.now();
  try {
    const res = await fetch(url, { method, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let ok = res.ok;
    try {
      const json = JSON.parse(text) as { status?: unknown; type?: unknown };
      const word = String(json.status ?? json.type ?? "").toLowerCase();
      ok = ok && word !== "error" && word !== "failed" && word !== "failure";
    } catch {
      /* non-JSON body: the HTTP status decides */
    }
    const detail = ok ? undefined : text.slice(0, 200);
    recordProvider("sms", "send-order-sms", { ok, durationMs: Date.now() - started, status: res.status, detail });
    return { sent: ok, detail };
  } catch (e) {
    const detail = (e as Error).message;
    recordProvider("sms", "send-order-sms", { ok: false, durationMs: Date.now() - started, detail });
    return { sent: false, detail };
  }
}
