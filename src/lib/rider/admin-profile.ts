import {
  REQUIRED_DOC_TYPES,
  cleanText,
  isVerification,
  parsePayoutAccount,
  type DocLike,
  type PayoutAccountInput,
  type RiderDocType,
  type Verification,
} from "@/lib/rider/profile-rules";

/**
 * The admin side of rider verification (Phase 6 Task 3) — the form parsers,
 * the transitions and the sentences, with no database. Pure so
 * `scripts/qa/admin-rider-profile.ts` can check them.
 *
 * The transitions and the required-documents rule are the Manager branch's
 * `ops_set_rider_verification` (0151), so a decision made on either surface
 * leaves the database the same: verify from unverified / pending / rejected
 * (aadhaar, driving licence and photo verified, unless overridden with a
 * reason); reject from unverified / pending only — a verified rider is
 * suspended, not un-verified.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const RELOAD = "That rider or record could not be identified. Reload the page and try again.";

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

function ids<K extends string>(form: FormData, keys: readonly K[]): Record<K, string> | null {
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = str(form, k);
    if (!UUID.test(v)) return null;
    out[k] = v.toLowerCase();
  }
  return out;
}

/** A note: required (3..max) when `required`, otherwise optional (≤ max); any script, no control characters. */
function note(raw: string, required: boolean, max: number, what: string): Parsed<string | null> {
  const n = cleanText(raw, max);
  if (n === undefined) return { ok: false, error: `The ${what} is too long or has characters that can't be saved (${max} at most).` };
  if (n === null || [...n].length < 3) {
    return required ? { ok: false, error: `Give a reason (at least 3 characters) — the rider reads it.` } : { ok: true, value: null };
  }
  return { ok: true, value: n };
}

export function parseDocumentReview(
  form: FormData,
  decision: "verify" | "reject"
): Parsed<{ driverId: string; documentId: string; remarks: string | null }> {
  const id = ids(form, ["driverId", "documentId"] as const);
  if (!id) return { ok: false, error: RELOAD };
  const remarks = note(str(form, "remarks"), decision === "reject", 500, "remark");
  if (!remarks.ok) return remarks;
  return { ok: true, value: { ...id, remarks: remarks.value } };
}

export function parseVerificationDecision(form: FormData): Parsed<{
  driverId: string;
  decision: "verify" | "reject";
  expected: Verification;
  note: string | null;
  override: boolean;
}> {
  const id = ids(form, ["driverId"] as const);
  if (!id) return { ok: false, error: RELOAD };
  const decision = str(form, "decision");
  if (decision !== "verify" && decision !== "reject") return { ok: false, error: RELOAD };
  const expected = str(form, "expected");
  if (!isVerification(expected)) return { ok: false, error: RELOAD };
  const override = decision === "verify" && str(form, "override") !== "";
  const n = note(str(form, "note"), decision === "reject" || override, 300, "note");
  if (!n.ok) return n;
  return { ok: true, value: { driverId: id.driverId, decision, expected, note: n.value, override } };
}

export function parseChangeDecision(
  form: FormData
): Parsed<{ driverId: string; requestId: string; decision: "approve" | "reject"; note: string | null }> {
  const id = ids(form, ["driverId", "requestId"] as const);
  if (!id) return { ok: false, error: RELOAD };
  const decision = str(form, "decision");
  if (decision !== "approve" && decision !== "reject") return { ok: false, error: RELOAD };
  const n = note(str(form, "note"), decision === "reject", 300, "note");
  if (!n.ok) return n;
  return { ok: true, value: { ...id, decision, note: n.value } };
}

const PAYOUT_FIELD_ERROR: Record<string, string> = {
  holderName: "Enter the account holder's name as the bank has it.",
  accountNumber: "The account number should be 9 to 18 digits.",
  confirmAccountNumber: "The two account numbers don't match.",
  ifsc: "That IFSC doesn't look right — 11 characters, like HDFC0001234.",
  upiId: "That UPI ID doesn't look right — like name@bank.",
  kind: "Choose bank account or UPI.",
};

export function parsePayoutEdit(form: FormData): Parsed<{ driverId: string; account: PayoutAccountInput }> {
  const id = ids(form, ["driverId"] as const);
  if (!id) return { ok: false, error: RELOAD };
  const kind = str(form, "kind");
  const raw: Record<string, unknown> =
    kind === "bank"
      ? {
          kind,
          holderName: str(form, "holderName"),
          accountNumber: str(form, "accountNumber"),
          confirmAccountNumber: str(form, "confirmAccountNumber"),
          ifsc: str(form, "ifsc"),
        }
      : kind === "upi"
        ? { kind, upiId: str(form, "upiId"), holderName: str(form, "holderName") }
        : { kind };
  const p = parsePayoutAccount(raw);
  if (!p.ok) return { ok: false, error: PAYOUT_FIELD_ERROR[p.field] ?? "Check the account details." };
  return { ok: true, value: { driverId: id.driverId, account: p.value } };
}

/** The state a decision moves to, or null when it does not apply from here (0151's rule). */
export function verificationTarget(current: Verification, decision: "verify" | "reject"): "verified" | "rejected" | null {
  if (decision === "verify") return current === "verified" ? null : "verified";
  return current === "unverified" || current === "pending" ? "rejected" : null;
}

/** The required documents (aadhaar, driving licence, photo) without a live verified copy, in that order. */
export function unverifiedRequired(docs: readonly DocLike[]): RiderDocType[] {
  return REQUIRED_DOC_TYPES.filter((t) => !docs.some((d) => d.type === t && d.status === "verified"));
}

const MESSAGES: Record<string, string> = {
  not_found: "That record is no longer there. Reload the page.",
  already_decided: "Someone has already decided this. Reload to see the outcome.",
  stale: "The rider's status changed while this page was open. Reload and decide again.",
  invalid_transition: "That decision doesn't apply to the rider's current status. A verified rider is suspended from Team, not un-verified.",
  documents_unverified: "Verify the Aadhaar, driving licence and photo first, or tick the override and say why.",
  active_delivery: "The rider is carrying an order. Reject them once it is delivered or reassigned.",
  invalid_value: "The requested value can't be saved. Reject it with a note so the rider can send it again.",
  staged_missing: "The proposed payout account is missing. Reject the request so the rider can send it again.",
  migration_pending: "Rider profiles (migration 0086) aren't applied to this database yet. Nothing was saved.",
  too_fast: "Too many changes in a minute. Wait a moment and try again.",
  demo: "Demo mode: connect Supabase to review riders. Nothing was saved.",
  failed: "That didn't save. Try again; the problem has been logged.",
};

export function adminProfileError(code: string): string {
  return MESSAGES[code] ?? MESSAGES.failed;
}
