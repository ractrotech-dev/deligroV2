import { profileJson, profileRouteError, readJson, riderProfileGate } from "@/lib/auth/rider-profile-route";
import { listChangeRequests, requestProfileChange } from "@/lib/data-access/rider-profile";
import { parseChangeRequest } from "@/lib/rider/profile-rules";
import { istDay } from "@/lib/rider/earnings-math";

const ROUTE = "/api/rider/profile/change-requests";

/**
 * GET /api/rider/profile/change-requests — the rider's last 20 requests,
 * newest first, with Deligro's decision and note. The submitted value is never
 * echoed; `summary` is one masked line.
 *
 *   200 { changeRequests: { id, field, status, createdAt, decidedAt, decisionNote, summary }[] }
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 */
export async function GET() {
  const gate = await riderProfileGate(ROUTE, { write: false, perMinute: 30 });
  if (!gate.ok) return gate.response;
  try {
    return profileJson({ changeRequests: await listChangeRequests(gate.driverId) });
  } catch (e) {
    return profileRouteError(e, ROUTE, "GET", gate.driverId);
  }
}

/**
 * POST /api/rider/profile/change-requests — change name, licence, vehicle or
 * payout account.
 *
 *   body { field: "full_name",      value: { fullName } }
 *        { field: "licence",        value: { number, expiresOn: "YYYY-MM-DD" } }
 *        { field: "vehicle",        value: { type, owner: "deligro" | "rider", registration? } }
 *        { field: "payout_account", value: { kind: "bank", holderName, accountNumber, confirmAccountNumber, ifsc }
 *                                        | { kind: "upi", upiId, holderName? } }
 *
 *   201 { ok: true, id, status: "pending" }   waits for Deligro (payout always; the rest once verified)
 *   201 { ok: true, id, status: "applied" }   saved now (the rider is not verified yet)
 *   400 invalid_body | invalid_field | invalid_value (+ field)
 *   409 duplicate_pending                      one request per field at a time
 *   401 · 403 not_rider | feature_disabled · 429 · 503 migration_pending · 500
 */
export async function POST(request: Request) {
  const gate = await riderProfileGate(ROUTE, { write: true, perMinute: 30 });
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  if (body === null) return profileJson({ error: "invalid_body" }, 400);
  const parsed = parseChangeRequest(body, istDay(new Date()));
  if (!parsed.ok) return profileJson("field" in parsed ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, 400);

  try {
    const result = await requestProfileChange(gate.driverId, parsed.field, (body as { value: unknown }).value);
    if (!result.ok) {
      return result.error === "duplicate_pending"
        ? profileJson({ error: result.error }, 409)
        : profileJson({ error: result.error, field: result.field }, 400);
    }
    return profileJson(result, 201);
  } catch (e) {
    return profileRouteError(e, ROUTE, "POST", gate.driverId);
  }
}
