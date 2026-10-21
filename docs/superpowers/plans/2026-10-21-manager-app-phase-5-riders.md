# Manager App — Phase 5: Riders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every rider in the manager's zones — list with live state, onboarding, documents, verification and account status (approve / reject / suspend / reactivate), live position and active route, assign and reassign, delivery history, completed and failed deliveries, ratings and performance, earnings and payouts (salaried, maker–checker), cash collection against deposits, delivery-exception decisions, and complaints (§5.1–5.15). Every change is one audited RPC.

**Architecture:** Task P0 merges `feat/rider-app` and reconciles re-declared functions. Migration `0150` converges: it creates, with the Rider design's exact names and shapes, any rider table §5 needs that has not landed on the Rider branch (`create table if not exists`, so either order of application converges). `0151` adds the generic account status (`profiles.account_status`, used again by customers in Phase 7), zone-scoped manager reads on every rider table, and the audited rider RPCs. `0152` adds generic maker–checker `payment_requests` (Phase 6 reuses it for vendor settlements) and audited RPCs for payouts, cash deposits, cash disputes and exception decisions. Pure rules in `src/lib/ops/rider-rules.ts`; thin `/api/manager/*` routes serialise through `src/lib/ops/rider-contract.ts`. The Flutter app adds Riders (list, detail, onboarding), Approvals, Cash deposits and an Exceptions queue, coded against the JSON pinned below with fake repositories.

**Tech Stack:** Supabase Postgres (RPCs, RLS, triggers, storage signed URLs), Next.js route handlers (read `node_modules/next/dist/docs/` first), Flutter 3.47 / Riverpod 3 / go_router, `flutter_map`, `fl_chart`, `image_picker` / `file_picker`, `url_launcher`.

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (§5, Permissions, Audit log, Money definitions — "Rider side", Alerts §6.7). Earlier plans: phases 1–4 (`…-phase-3-orders-live.md` defines `ops_require_staff`, `_ops_set_actor`, `riderEligibility`, `getLiveSnapshot`, the order actions and `cancelOrderAsOps`; `…-phase-4-vendors-products.md` defines the generic ticket thread/reply/status endpoints and `TicketSummary`). Neighbouring, binding where they name a table or function: `docs/superpowers/specs/2026-10-21-rider-app-design.md`, `docs/superpowers/plans/2026-10-21-rider-app-phase-{2,3,4,5,6,7}-*.md` (on `feat/rider-app`), migration `0081_rider_app_foundation.sql`.

## Execution layout — two halves in parallel

| Half | Worktree | Branch | Touches |
|---|---|---|---|
| **Part S (server)** | `F:\hub26\deligro-manager-p5s` | `feat/manager-p5-server` | `supabase/`, `scripts/`, `src/`, `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md`, `package.json` |
| **Part A (app)** | `F:\hub26\deligro-manager-p5a` | `feat/manager-p5-app` | `apps/manager/` only |

**Task P0** runs first in `F:\hub26\deligro-manager`. Both halves then branch from `feat/manager-app` at P0's last commit and share no files. When both are done: merge S, then A, into `feat/manager-app`, run **Task I1** there, then `git worktree remove` both and `git branch -d` both branches.

## Global Constraints

- Phase 1–4 Global Constraints apply unchanged (AGENTS.md rules, migrations 0141–0199 with **0150–0154 for this phase**, F:\dev build env, release-APK smoke test, commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never touch `F:\hub26\deligro`, `deligro-rider`, `deligro-vendor`; never bare `git stash`.
- English only — no Hindi (owner).
- **Every audited write is one RPC that changes and logs in the same transaction** (`_ops_log`, 0141), following 0142's pattern: `security definer set search_path = public`, `_ops_set_actor(p_actor)`, `ops_require_staff(p_actor, <zone>)` first, replay-safe on `p_client_action_id` (return the recorded result unchanged), `revoke execute … from public, anon, authenticated; grant execute … to service_role`.
- **A rider's zone** = their `staff_zones` rows. For `ops_require_staff` on a rider, pass each of the rider's zones until one passes (helper `ops_require_staff_for_rider(p_actor, p_rider) returns text`, 0151); a rider with no zone is visible to admins only (fail closed).
- **Re-declared functions:** before re-declaring any function (`record_rider_payout`, `guard_delivery_transition`, `log_delivery_event`, `lock_profile_privileged_fields` or whatever `profiles` self-update guard exists, dispatch eligibility SQL), diff every definition across `supabase/migrations/` on the branch after P0 and keep all behaviour; add only what this plan names.
- **Converge, don't fork:** where a Rider-branch server function named in this plan exists after P0 (`decideException`, `decideDeposit`, `getRiderPerformance`, `getRiderHistory`, `listRidersForAdmin`, `uploadRiderDocument`, `riderDocumentUrl`), the manager routes call it (or it is refactored onto this phase's RPC, keeping its signature). Where it does not exist, this phase creates it **at the Rider plan's path with the Rider plan's exact signature**, and the commit body says so.
- **Permissions per call** (`managerApiContext(key)` before anything else). One new catalog key: `manager.exceptions.decide` (default **on**; label "Decide delivery exceptions" / "डिलीवरी अपवाद तय करना").

| Call | Key |
|---|---|
| rider list, detail, history, ratings, documents list/view, live block, complaints | `manager.riders.view` |
| detail `money` block, ledger, payouts list | `manager.riders.view` **and** `manager.finance.view` (block absent otherwise) |
| approve, reject, suspend, reactivate, verify / reject document, force offline | `manager.riders.status` |
| onboard a rider, upload a document | `manager.riders.onboard` |
| add bonus / deduction / adjustment | `manager.finance.adjust` |
| create a payout request | `manager.finance.initiate_payment` |
| approve / reject a payment request | `manager.finance.approve_payment` (admins always) |
| list, confirm / dispute cash deposits; list, resolve cash disputes | `manager.cash` |
| list exceptions | `manager.riders.view` |
| decide an exception | `manager.exceptions.decide` |
| assign / reassign from rider detail | Phase 3 keys (`manager.assign_rider`, `manager.reassign_rider`) via Phase 3's order actions |

- **Zone scope** on every read: riders through `manager_can_see_rider(driver_id)` (0141) in SQL and `applyRiderScope(query, scope)` (new, in `src/lib/auth/manager-scope.ts`, filters `driver_id in (select user_id from staff_zones where zone_id in scope)`) on service-role reads. Out-of-scope ids answer **404 `not_found`**.
- **Privacy (§5.7, §16.10):** a rider's position is returned **only while `rider_status.is_online` or the rider holds an active delivery**; offline riders carry `position: null`. Rider phone goes to managers with `manager.riders.view` (staff contact, §15.5 "dispatch can call the rider"). Aadhaar numbers only masked; PAN and licence numbers masked to last 4 in manager payloads; `rider_payout_accounts` and its staged table never leave the server in this phase (payouts show `method` and `reference` only). Customer identity in ratings: never (`customer_id` is not serialised). Document files only as **60-second signed URLs** from the private `rider-documents` bucket, generated after the scope check.
- **Rider money** values are JSON numbers with up to 2 decimals (the ledger is `numeric(10,2)`); every other money value stays whole rupees.
- Riders are **salaried** (owner; design "Rider side"): no per-order pay formula is added here. Salary is a `rider_adjustments` row of kind `salary`; payouts go through `payment_requests`.

## Claude's calls

- **Verification vs account status.** "Approve / reject" a rider is `rider_profiles.verification_status` (0086: `unverified|pending|verified|rejected`). "Suspend / reactivate" is the generic `profiles.account_status` (`active|suspended|restricted`, default `active`) with `status_reason`, `status_changed_by`, `status_changed_at` — the same columns Phase 7 uses for customers. Transitions (`expected` required → 409 `stale` otherwise): approve `unverified|pending|rejected → verified` (requires `aadhaar`, `driving_licence`, `photo` documents `verified` unless `override: true`, recorded in the audit `after`); reject `unverified|pending → rejected`; suspend `active → suspended`; reactivate `suspended → active`. **A reason (3–300 chars) is required for all four.**
- **What blocks work.** `account_status = 'suspended'` or `verification_status = 'rejected'`: cannot go online (`/api/rider/status` → 403 `account_suspended` / `verification_rejected`), is never dispatch-eligible (SQL `rider_can_work(uuid)` used by `ops_assign_rider` and dispatch; TS `riderEligibility` reason `suspended`), and `/api/rider/me` answers 403 `account_suspended` so the Rider app shows a blocking screen. `unverified` / `pending` riders keep working exactly as today (every existing rider is `unverified`; blocking them would stop deliveries on deploy).
- **Suspension with an active delivery** is refused with 409 `active_delivery` and the order codes; the manager reassigns first (Phase 3), then suspends. Suspension otherwise forces offline in the same RPC: `rider_status.is_online = false`, `break_until = null`, the open `rider_shifts` row ended with `ended_by = 'ops'`, pending offers released (`deliveries` with `offered_driver_id = rider` and status `unassigned` get `offered_driver_id = null`). **Force offline** (no suspension) is the same RPC path with reason, for a rider who is idle but unreachable.
- **Onboarding** (`manager.riders.onboard`): the server creates the auth user first (as Settings → Team does today), then one RPC `ops_onboard_rider` sets `profiles.role = 'driver'`, name, phone, the chosen `staff_zones` zone (must be in the manager's scope), the 0086 profile fields, `verification_status = 'pending'`, and the audit row; on RPC failure the auth user is deleted (today's compensation). Admin Team creation is moved onto the same RPC (actor = admin) so both paths are audited. A generated password is returned once.
- **Payouts — maker–checker.** `payment_requests` is generic (`kind 'rider_payout'` now, `'vendor_settlement'` in Phase 6). A request carries the preview amount computed at request time. Approval re-computes: if the amount differs it answers 409 `amount_changed` with the new amount, and the approver re-submits with `confirmAmount` equal to it. Approval inserts the salary adjustment (when the request carries `salaryAmount`) and records the payout through `_record_rider_payout` (the 0083 math, refactored so `record_rider_payout` remains the admin wrapper) — all in one transaction with the audit row. **`decided_by` must differ from `requested_by`** (SQL check and RPC error `same_person`), admins included.
- **Adjustments** (bonus, deduction, adjustment) are not payments and need no checker; they need `manager.finance.adjust` and a reason, and are audited.
- **Cash deposits.** Confirm writes the `cod_handovers` row (leg `rider_to_manager`, zone = the deciding manager's zone that contains the rider) and marks the deposit `confirmed` with `handover_id`, in one RPC; dispute requires a note. The Rider branch's `decideDeposit` becomes a wrapper over that RPC (signature kept). Cash disputes resolve with a resolution text.
- **Exceptions.** `ops_decide_delivery_exception` records the decision and audit row atomically; the effects that live in TypeScript (failed delivery → `cancelOrderAsOps(…, reason: "delivery_failed: <kind>")`; `go_offline` → release and re-dispatch, then force offline) run after commit inside `decideException`, idempotently (each re-checks current state and returns `already_resolved`), exactly as the Rider plan specifies. A failure in the after-effects leaves the decision recorded and returns 502 `effect_failed` with the exception id; the Exceptions screen shows "Decision saved; finishing it failed — retry", whose retry calls the same endpoint (replay-safe: the RPC returns the recorded decision and the effects re-check state).
- **Performance windows:** last 30 IST days by default; `acceptanceRate` = accepted ÷ offered (`delivery_events`), `avgDeliverMinutes` = mean accepted→delivered, `failedRate` = failed ÷ (delivered + failed), `onlineHours` = sum of `rider_shifts` overlap with the window (open shift counted to now). These are the Rider plan's `figures.ts` definitions; reuse them.

## API contract (pinned — both halves code to this)

All responses JSON. Errors `{ "error": "<code>", ...extra }`. Timestamps ISO-8601 UTC; ids uuid; dates `YYYY-MM-DD` (IST).

### Shared shapes

```jsonc
// RiderState
"online|available|on_delivery|break|stale|offline"   // available = online, not on break, fresh fix, no active delivery
// RiderListItem
{ "id": "uuid", "riderCode": "DR-0007|null", "name": "Ravi Kumar|null", "phone": "+9198…|null",
  "photoUrl": "…|null", "state": "RiderState", "lastFixAt": "…|null", "fixAgeSeconds": 42 /* null */,
  "zones": [{ "id": "uuid", "name": "Bemetara" }],
  "verification": "unverified|pending|verified|rejected", "account": "active|suspended|restricted",
  "activeDeliveries": 1, "deliveredToday": 9, "rating": 4.6 /* null */, "ratingCount": 31,
  "pendingDocuments": 0, "expiringDocuments": 1, "openComplaints": 0 }
// RiderDocument
{ "id": "uuid", "type": "aadhaar|pan|driving_licence|vehicle_rc|insurance|puc|photo",
  "numberMasked": "XXXX1234|null", "expiresOn": "2027-03-01|null",
  "status": "pending|verified|rejected|expired|replaced", "remarks": "…|null",
  "reviewedBy": { "id": "uuid", "name": "…" } /* or null */, "reviewedAt": "…|null", "uploadedAt": "…" }
// RiderHistoryItem  (= Rider plan HistoryItem)
{ "orderId": "uuid", "code": "AB12CD34", "shop": "Spice Hub", "dropArea": "Ward 4|null",
  "outcome": "delivered|failed|cancelled|reassigned", "acceptedAt": "…|null", "pickedUpAt": "…|null",
  "deliveredAt": "…|null", "endedAt": "…", "distanceKm": 3.2 /* null */, "reason": "…|null",
  "cancelledBy": "customer|vendor|admin|manager|system|null", "proof": "code|photo|ops_approved|staff|vendor|null",
  "itemCount": 3, "orderValue": 420 }
// LedgerRow
{ "id": "uuid", "type": "earning|incentive|salary|bonus|deduction|adjustment", "amount": 1500.00,
  "date": "2026-10-01", "reason": "…|null", "orderCode": "…|null", "payoutId": "uuid|null",
  "status": "pending|paid", "createdBy": { "id": "uuid", "name": "…" } /* null for earnings */ }
// Payout
{ "id": "uuid", "amount": 12000.00, "method": "bank|upi|cash|other", "reference": "UTR…|null",
  "paidOn": "2026-10-05", "periodEnd": "2026-09-30", "items": 3, "requestId": "uuid|null" }
// PaymentRequest
{ "id": "uuid", "kind": "rider_payout|vendor_settlement", "subject": { "id": "uuid", "name": "Ravi Kumar", "code": "DR-0007|null" },
  "zone": { "id": "uuid", "name": "Bemetara" }, "amount": 12000.00, "periodEnd": "2026-09-30|null",
  "salaryAmount": 12000.00 /* null */, "method": "bank|upi|cash|other", "note": "…|null",
  "status": "pending_approval|approved|rejected|cancelled",
  "requestedBy": { "id": "uuid", "name": "…" }, "requestedAt": "…",
  "decidedBy": { "id": "uuid", "name": "…" } /* or null */, "decidedAt": "…|null", "decisionNote": "…|null",
  "reference": "…|null", "paidOn": "…|null", "resultId": "uuid|null",
  "canDecide": false   // true only when the viewer holds approve_payment AND is not the requester
}
// CashDeposit
{ "id": "uuid", "rider": { "id": "uuid", "name": "…", "code": "DR-0007|null" }, "amount": 2400, "method": "cash|upi",
  "reference": "…|null", "hasPhoto": true, "note": "…|null", "status": "submitted|confirmed|disputed|withdrawn",
  "decidedBy": { "id": "uuid", "name": "…" } /* or null */, "decidedAt": "…|null", "decisionNote": "…|null",
  "handoverId": "uuid|null", "createdAt": "…" }
// CashDispute
{ "id": "uuid", "rider": { "id": "uuid", "name": "…", "code": "…|null" }, "day": "2026-10-20", "claimedAmount": 1800 /* null */,
  "message": "…", "status": "open|resolved", "resolution": "…|null", "resolvedAt": "…|null", "createdAt": "…" }
// DeliveryException
{ "id": "uuid", "orderId": "uuid", "orderCode": "AB12CD34", "rider": { "id": "uuid", "name": "…", "code": "…|null", "phone": "…|null" },
  "kind": "customer_unreachable|wrong_address|complete_without_code|failed_delivery|manual_pickup|go_offline|return_to_shop|missing_items|wrong_package|vendor_delay|other",
  "reason": "…", "notes": "…|null", "hasPhoto": false, "lat": 21.7, "lng": 81.5 /* null */,
  "status": "pending|approved|rejected|acknowledged", "decidedBy": { "id": "uuid", "name": "…" } /* or null */,
  "decidedAt": "…|null", "decisionNote": "…|null", "createdAt": "…",
  "decisions": ["approve", "reject"] /* or ["acknowledge"] for report kinds; [] when decided */ }
```

### `GET /api/manager/riders`

Query: `q` (name, phone digits ≥ 4, or rider code), `state` (comma list of `RiderState`), `verification`, `account`, `zone`, `filter` (`needs_review` = pending documents or verification `pending` · `expiring` = a document expiring within 30 days), `cursor`, `limit` (default 50, max 100). Keyset on `(name asc nulls last, id asc)`.
200: `{ "items": [RiderListItem], "nextCursor": "string|null", "counts": { "all": 24, "online": 9, "available": 5, "on_delivery": 4, "break": 1, "stale": 1, "offline": 14, "suspended": 1, "needs_review": 2 } }`. 400 `bad_request` with `field`.

### `GET /api/manager/riders/[id]`

200: `{ "rider": RiderDetail }`, `RiderDetail` = `RiderListItem` plus
```jsonc
{
  "accountReason": "…|null", "accountChangedAt": "…|null", "accountChangedBy": { "id": "uuid", "name": "…" } /* or null */,
  "verifiedAt": "…|null", "verifiedBy": { "id": "uuid", "name": "…" } /* or null */,
  "profile": { "vehicleType": "ev_bike|bike|scooter|bicycle|other|null", "vehicleOwner": "deligro|rider",
               "vehicleRegistration": "…|null", "licenceNumberMasked": "XXXX5678|null", "licenceExpiresOn": "…|null",
               "address": "…|null", "pincode": "…|null",
               "emergency": { "name": "…|null", "phone": "…|null", "relation": "…|null" }, "joinedAt": "…" },
  "availability": { "onlineSince": "…|null", "breakUntil": "…|null",
                    "position": { "lat": 21.7, "lng": 81.5, "at": "…" } /* null unless online or on delivery */ },
  "active": [{ "orderId": "uuid", "code": "AB12CD34", "status": "assigned|picked_up", "shop": { "name": "…", "lat": 0, "lng": 0 },
               "drop": { "area": "…|null", "lat": 0, "lng": 0 }, "etaPickupAt": "…|null", "etaDeliveryAt": "…|null",
               "route": [[21.7, 81.5], [21.71, 81.52]] /* polyline from the live module; [] when unknown */,
               "delay": { "kind": "prep|pickup|delivery|unassigned", "minutes": 7 } /* or null */ }],
  "performance": { "from": "…", "to": "…", "delivered": 212, "failed": 3, "cancelled": 4,
                   "acceptanceRate": 0.91, "avgDeliverMinutes": 24.5, "avgPickupToDeliverMinutes": 11.2,
                   "failedRate": 0.014, "onlineHours": 182.5,
                   "months": [{ "month": "2026-09", "delivered": 190, "failed": 2, "cancelled": 3, "acceptanceRate": 0.9, "avgDeliverMin": 25.1, "onlineHours": 170 }] },
  "ratings": { "average": 4.6, "count": 31, "distribution": { "1": 0, "2": 1, "3": 2, "4": 8, "5": 20 },
               "recent": [{ "rating": 5, "comment": "…|null", "at": "…", "orderCode": "…" }] },
  "documents": [RiderDocument],
  "money": {                                    // key ABSENT without manager.finance.view
    "pending": 12000.00, "paidTotal": 48000.00, "lastPayout": Payout /* or null */,
    "pendingRequests": [PaymentRequest] },
  "cash": { "collectedToday": 3200, "depositedToday": 2400, "pendingDeposit": 800,
            "openDeposits": [CashDeposit], "openDisputes": [CashDispute] },
  "openExceptions": [DeliveryException],
  "openComplaints": [TicketSummary],
  "allowed": { "approve": false, "reject": false, "suspend": true, "reactivate": false, "forceOffline": true,
               "reviewDocuments": true, "uploadDocuments": false, "addAdjustment": false, "requestPayout": false,
               "assign": true }
}
```
404 `not_found`.

### `GET /api/manager/riders/[id]/history?from=&to=&outcome=&cursor=`
200: `{ "items": [RiderHistoryItem], "nextCursor": "string|null", "totals": { "delivered": 40, "failed": 1, "cancelled": 2, "reassigned": 1 } }` (keyset on `endedAt desc`, 50).

### `GET /api/manager/riders/[id]/ratings?cursor=`
200: `{ "items": [{ "rating": 5, "comment": "…|null", "at": "…", "orderCode": "…" }], "nextCursor": "string|null" }`.

### `GET /api/manager/riders/[id]/documents/[docId]/url`
200: `{ "url": "https://…", "expiresAt": "…" }` (60 s). 404 `not_found`.

### `GET /api/manager/riders/[id]/ledger?from=&to=&status=pending|paid&cursor=`
Needs `manager.finance.view`. 200: `{ "items": [LedgerRow], "nextCursor": "string|null", "payouts": [Payout], "summary": { "pending": 12000.00, "paid": 48000.00 } }`.

### `POST /api/manager/riders/[id]/actions`
```jsonc
{ "action": "approve|reject|suspend|reactivate|force_offline|verify_document|reject_document|add_adjustment",
  "clientActionId": "uuid",
  "reason": "…",                               // approve/reject/suspend/reactivate/force_offline/add_adjustment: 3–300 chars
  "expected": "unverified|pending|rejected|active|suspended",  // approve/reject: verification; suspend/reactivate: account
  "override": false,                           // approve only
  "documentId": "uuid", "remarks": "…",        // documents; remarks required to reject
  "adjustment": { "kind": "bonus|deduction|adjustment", "amount": 500.00, "effectiveOn": "2026-10-20", "orderId": "uuid|null" } }
```
200: `{ "rider": RiderDetail }`. Errors: 400 `bad_request` | `reason_required` | `remarks_required`; 403 `permission_denied`; 404 `not_found`; 409 `stale`, `documents_unverified` (`{ "missing": ["driving_licence"] }`), `active_delivery` (`{ "orders": ["AB12CD34"] }`), `invalid_transition`, `already_decided`; 429.

### `POST /api/manager/riders` (onboard)
```jsonc
{ "clientActionId": "uuid", "fullName": "Ravi Kumar", "mobile": "9876543210", "email": "…|null", "password": "…|null",
  "zoneId": "uuid", "vehicleType": "ev_bike", "vehicleOwner": "deligro", "vehicleRegistration": "…|null",
  "licenceNumber": "…|null", "licenceExpiresOn": "…|null", "addressLine": "…|null", "pincode": "491335|null",
  "emergencyName": "…|null", "emergencyPhone": "…|null", "emergencyRelation": "…|null" }
```
201: `{ "riderId": "uuid", "riderCode": "DR-0025", "credentials": { "mobile": "+919876543210", "password": "generated…" } /* null when the manager set one */ }`. 400 `bad_request` with `field`; 409 `phone_taken` | `email_taken`; 404 `not_found` (zone out of scope).

### `POST /api/manager/riders/[id]/documents` (multipart)
Fields `type`, `number?`, `expiresOn?`, `file` (PDF/JPEG/PNG, ≤ 10 MB, magic-byte checked). 201: `{ "document": RiderDocument }`. 400 `bad_type` | `too_large` | `invalid_number` | `expiry_required` (licence, insurance, PUC need expiry).

### `GET /api/manager/payments/requests?status=&kind=&zone=&mine=1&cursor=`
Needs `manager.finance.view`. 200: `{ "items": [PaymentRequest], "nextCursor": "string|null", "counts": { "pending_approval": 2, "approved": 10, "rejected": 1, "cancelled": 0 } }`.

### `POST /api/manager/payments/requests`
Needs `manager.finance.initiate_payment`. `{ "clientActionId": "uuid", "kind": "rider_payout", "riderId": "uuid", "periodEnd": "2026-09-30", "method": "bank|upi|cash|other", "salaryAmount": 12000.00 /* or null */, "note": "…|null" }` → 201 `{ "request": PaymentRequest }`. 409 `nothing_to_pay`, `duplicate_pending` (one pending request per rider), 404 `not_found`.

### `POST /api/manager/payments/requests/[id]/decide`
`{ "clientActionId": "uuid", "decision": "approve|reject|cancel", "reference": "UTR…", "paidOn": "2026-10-05", "confirmAmount": 12000.00 /* when re-submitting after amount_changed */, "note": "…" }`. Approve needs `manager.finance.approve_payment` (or admin) and `reference`; reject needs a note; `cancel` is the requester withdrawing their own pending request (needs `initiate_payment`). 200: `{ "request": PaymentRequest }`. Errors: 403 `same_person` | `permission_denied`; 409 `amount_changed` (`{ "amount": 12500.00 }`), `already_decided`, `nothing_to_pay`; 400 `reference_required` | `note_required`.

### `GET /api/manager/cash/deposits?status=&rider=&cursor=` · `POST /api/manager/cash/deposits/[id]/decide`
GET 200: `{ "items": [CashDeposit], "nextCursor": "string|null", "counts": { "submitted": 3 } }`. GET `…/deposits/[id]/photo` → `{ "url", "expiresAt" }` (60 s).
POST `{ "clientActionId": "uuid", "decision": "confirm|dispute", "note": "…" }` → 200 `{ "deposit": CashDeposit }`; 400 `note_required` (dispute); 409 `already_decided`.

### `GET /api/manager/cash/disputes?status=&cursor=` · `POST /api/manager/cash/disputes/[id]/resolve`
GET 200: `{ "items": [CashDispute], "nextCursor": "string|null" }`. POST `{ "clientActionId": "uuid", "resolution": "…" }` (3–500 chars) → 200 `{ "dispute": CashDispute }`; 409 `already_resolved`.

### `GET /api/manager/exceptions?status=pending&rider=&cursor=` · `POST /api/manager/exceptions/[id]/decide`
GET 200: `{ "items": [DeliveryException], "nextCursor": "string|null", "counts": { "pending": 2 } }` (oldest pending first). GET `…/exceptions/[id]/photo` → `{ "url", "expiresAt" }`.
POST `{ "clientActionId": "uuid", "decision": "approve|reject|acknowledge", "note": "…" }` (note required to reject) → 200 `{ "exception": DeliveryException }`; 409 `already_resolved`; 502 `effect_failed` (`{ "exceptionId": "uuid" }` — decision saved, retry the same request).

### Changed (Phase 3 endpoints, contract unchanged)
`GET /api/manager/orders/[id]/riders` and `ops_assign_rider` / `ops_reassign_delivery` treat `rider_can_work(rider) = false` as `suspended`. `GET /api/manager/live` rider entries gain `"riderCode"` (string|null).

## Requirement coverage

| Spec item | Tasks |
|---|---|
| §5.1 view all registered riders | S3, A2 |
| §5.2 onboard riders and review their documents | S1, S2, S4, A4, A3 |
| §5.3 approve / reject / suspend / reactivate | S2, S4, A3 |
| §5.4 online / offline status | S3, A2 |
| §5.5 riders available for assignment | S3 (`state=available`), A2 chip; Phase 3 picker |
| §5.6 riders currently handling deliveries | S3 (`state=on_delivery`, `active`), A2, A3 |
| §5.7 location during permitted tracking | S3 (position only online/active), A3 map |
| §5.8 active routes and ETAs | S3 (`active[].route`, ETAs from Phase 3 live module), A3 |
| §5.9 assign or reassign | Phase 3 actions; S3 `allowed.assign`, A3 "Assign an order" / per-order Reassign |
| §5.10 delivery history | S3 history, A3 Deliveries tab |
| §5.11 completed and failed deliveries | S3 `totals` + outcome filter, A3 |
| §5.12 ratings and performance | S3, A3 Performance tab |
| §5.13 earnings and payout status | S1 (ledger tables if missing), S5, S6, A5, A3 Money tab |
| §5.14 cash collection and reconciliation | S5 (deposit/dispute RPCs), S6, A6 |
| §5.15 complaints and support | S3 `openComplaints` (Phase 4 ticket endpoints, `requester_role = 'driver'` or ticket on the rider's delivery), A3 Complaints tab → Phase 4 ticket thread |
| Exception decisions (deferred from Phase 3) | S5, S7, A7 |
| Suspension enforced in Rider app, dispatch, assignment | S2, S4 |
| Audit of every status, document, payout, cash and exception decision | S2, S5 |

## Review Focus

1. **The person who requested a payout approves it** (two tabs, or an admin who requested) → 403 `same_person`; the SQL check refuses even a direct RPC call. (S5 PGlite, S6 QA, A5 test hides Approve when `canDecide` is false.)
2. **A suspended rider keeps working through a stale session or an open offer** → `/api/rider/status` online → 403 `account_suspended`; dispatch and `ops_assign_rider` refuse; the open offer is released in the suspension transaction. (S2 PGlite, S4 QA.)
3. **The payout amount changes between request and approval** (a delivery lands, an adjustment is added) → 409 `amount_changed` with the new figure; nothing is paid until the approver confirms that figure. (S5 PGlite.)
4. **A zone-A manager opens or acts on a zone-B rider, deposit, exception or payment request by id** → 404, and every RPC refuses in the database. (S2/S5 PGlite, S3/S6 QA.)
5. **An exception's after-effect fails (cancellation errors) after the decision committed** → 502 `effect_failed`, the decision stays recorded, and retrying the same request completes the effect once (no second cancellation, no second refund). (S7 QA, A7 test.)

---

### Task P0: Merge the Rider branch (in `F:\hub26\deligro-manager`)

- [ ] **Step 1:** `git merge feat/rider-app` (and `feat/vendor-app` if it has new commits). Resolve shared files (features catalog, `package.json`, `docs/SECURITY_AUDIT.md`, `docs/DATABASE.md`, `src/lib/notifications/order-events.ts`, `src/lib/dispatch/*`) keeping both sides.
- [ ] **Step 2:** List which of these landed: `0082` (`delivery_exceptions`), `0083` (`rider_earnings`, `rider_incentive_rules`, `rider_incentive_awards`, `rider_adjustments`, `rider_payouts`, `record_rider_payout`), `0084` (`rider_ratings`), `0085` (`cash_deposits`, `cash_disputes`, `cash_reminders`), `0086` (`rider_profiles` columns, `rider_documents`, `rider_payout_accounts`, `rider_profile_change_requests`, bucket `rider-documents`), `0087` (tickets, `user_notifications`, `announcements`), and the server modules named in Global Constraints. Write the list into this plan under a new heading `## P0 result` (landed / missing) — Part S reads it.
- [ ] **Step 3:** For every function re-declared both by merged migrations and 0141–0149 (`guard_delivery_transition`, `log_delivery_event`, `guard_order_update`, dispatch eligibility helpers), diff and fix the **later-numbered** migration so nothing the earlier one added is lost. Run every `scripts/qa/sql/migration-*.mjs` — all `ok`.
- [ ] **Step 4:** `npx tsc --noEmit`, `npm run lint`, `cd apps/manager && flutter analyze && flutter test`.
- [ ] **Step 5: Commit** the merge, then reconciliation as `fix(db): reconcile re-declared functions after merging Rider work`, then the plan update as `docs(manager-app): phase 5 P0 result`.

---

# Part S — server (worktree `deligro-manager-p5s`)

### Task S1: Migration 0150 — converge the Rider tables §5 needs

**Files:** Create `supabase/migrations/0150_rider_tables_converge.sql`, `scripts/qa/sql/migration-0150.mjs`; Modify `docs/DATABASE.md`.

**Interfaces — Produces (database), each only if P0 marked it missing, each with `create table if not exists` / `add column if not exists` / `drop policy if exists`, with the Rider plan's exact columns, checks, indexes and RLS:**
- From rider 0082: `delivery_exceptions` (columns as in rider phase 2 Task 1, including the pending-uniqueness index and the report-vs-request kind checks).
- From rider 0083: `rider_earnings`, `rider_incentive_awards`, `rider_adjustments`, `rider_payouts`, `record_rider_payout(p_driver uuid, p_period_end date, p_method text, p_reference text, p_paid_on date, p_note text) returns uuid` (admin only). Rate card, incentive rules and the earnings trigger are **not** built here (they belong to the Rider branch and produce no rows for salaried riders); `rider_incentive_rules` is created only because `rider_incentive_awards` references it.
- From rider 0084: `rider_ratings` and its insert/select policies.
- From rider 0085: `cash_deposits`, `cash_disputes` (checks: confirmed ⇒ `handover_id`, disputed ⇒ `decision_note`).
- From rider 0086: the `rider_profiles` columns, `rider_documents` (partial unique non-`replaced` per `(driver_id, doc_type)`), `rider_payout_accounts` + `rider_payout_accounts_staged` (RLS on, no policies, all revoked from anon/authenticated), bucket `rider-documents` (private, 10 MB, pdf/jpeg/png).
- Header lists exactly which objects this migration created and states "identical to Rider 008N; when that migration is merged, this block is a no-op".

- [ ] **Step 1: Write `migration-0150.mjs`:** apply 0081 then 0150 on PGlite; for each object created here, assert its columns and checks equal the Rider plan's text (a small table of expected columns per table); applying 0150 **twice** is a no-op; applying the merged Rider migration (when present on the branch) after 0150 raises nothing.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration. Step 4: Run it and every SQL proof — all `ok`.**
- [ ] **Step 5: Commit** `feat(db): 0150 converge Rider tables the manager rider screens need` (body lists what was built here and why).

### Task S2: Migration 0151 — account status, zone reads, rider RPCs

**Files:** Create `supabase/migrations/0151_manager_riders.sql`, `scripts/qa/sql/migration-0151.mjs`; Modify `docs/DATABASE.md`.

**Interfaces — Consumes:** `ops_require_staff`, `_ops_set_actor` (0142), `_ops_log` (0141), `manager_can_see_rider` (0141), `staff_zones`.

**Interfaces — Produces (database):**
- `profiles.account_status text not null default 'active' check in ('active','suspended','restricted')`, `status_reason text`, `status_changed_by uuid`, `status_changed_at timestamptz`; added to the `profiles` self-update lock (re-declare the existing guard, keeping all its columns) so only service role / admin may change them.
- `rider_can_work(p_rider uuid) returns boolean` (stable, security definer): `account_status = 'active'` and `coalesce(verification_status, 'unverified') <> 'rejected'`. Dispatch's SQL eligibility and `ops_assign_rider` / `ops_reassign_delivery` (re-declared, keeping 0142's behaviour) call it.
- `ops_require_staff_for_rider(p_actor uuid, p_rider uuid) returns text`.
- Zone-scoped manager select policies (`using (driver_id = auth.uid() or manager_can_see_rider(driver_id))`, admin via `is_admin()` as the existing policies do) on `delivery_exceptions`, `rider_earnings`, `rider_incentive_awards`, `rider_adjustments`, `rider_payouts`, `rider_ratings`, `cash_deposits`, `cash_disputes`, `rider_documents`, `rider_profile_change_requests`; **replace** any "managers select all" policy the Rider migrations created. Never any policy on `rider_payout_accounts*`.
- RPCs (`returns jsonb`, all with `p_client_action_id text`):
  - `ops_set_rider_verification(p_actor, p_rider, p_decision text /* approve|reject */, p_expected text, p_reason text, p_override boolean, p_client_action_id)` — required documents check (`aadhaar`, `driving_licence`, `photo` verified) unless override → `documents_unverified` (detail = comma list); sets `verification_status`, `verified_at/by`; action `rider.verify` / `rider.reject`.
  - `ops_set_rider_account(p_actor, p_rider, p_decision text /* suspend|reactivate */, p_expected text, p_reason text, p_client_action_id)` — suspend refuses `active_delivery` (detail = order short codes) when the rider has an `assigned`/`picked_up` delivery; else sets `account_status`, reason, by/at, forces offline (status, break, shift `ended_by='ops'`, releases `offered_driver_id`); action `rider.suspend` / `rider.reactivate`.
  - `ops_force_rider_offline(p_actor, p_rider, p_reason, p_client_action_id)` — same offline effects, refuses `active_delivery`; action `rider.force_offline`.
  - `ops_review_rider_document(p_actor, p_document uuid, p_decision text /* verify|reject */, p_remarks text, p_client_action_id)` — remarks required to reject; `already_decided` unless `pending`; action `rider.document.verify` / `.reject`.
  - `ops_onboard_rider(p_actor, p_user uuid, p_zone uuid, p_profile jsonb, p_client_action_id)` — `ops_require_staff(p_actor, p_zone)`; sets role `driver`, name, phone, `staff_zones`, profile columns, `verification_status = 'pending'`; action `rider.onboard`.
  - `ops_add_rider_adjustment(p_actor, p_rider, p_kind text, p_amount numeric, p_reason text, p_effective_on date, p_order uuid, p_client_action_id)` — kinds `bonus|deduction|adjustment` only (salary goes through payment requests); action `rider.adjustment`.

- [ ] **Step 1: Write `migration-0151.mjs`:** a rider updating own `account_status` → error; manager zone A suspends a zone-A rider with no delivery → `suspended`, `is_online` false, open shift ended `ops`, offer released, one audit row; same call replayed → same result, still one audit row; with an `assigned` delivery → `active_delivery` naming the code; zone-B manager → `forbidden`; `rider_can_work` false after suspension and after `verification_status = 'rejected'`, true for `unverified`; `ops_assign_rider` to the suspended rider → `rider_ineligible` detail `suspended`; approve without verified documents → `documents_unverified` listing the missing types, with override → `verified` and `documents_override: true` in the audit `after`; stale `expected` → `stale`; reject document without remarks → `reason_required`; second decision → `already_decided`; manager (authenticated, zone A) selects zone-A riders' documents, deposits, earnings, exceptions and none of zone B; nobody but service role selects `rider_payout_accounts`; `ops_add_rider_adjustment` with kind `salary` → error.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration (house-style header, STATUS: PENDING APPROVAL, rollback). Step 4: Run it and every SQL proof — all `ok`.**
- [ ] **Step 5: Commit** `feat(db): 0151 manager riders — account status, zone reads, audited verification, suspension, documents, onboarding, adjustments`.

### Task S3: Rider rules, list, detail, history, ratings, ledger — data layer, contract, routes

**Files:**
- Create: `src/lib/ops/rider-rules.ts`, `src/lib/ops/rider-contract.ts`, `src/lib/data-access/manager-riders.ts`, routes `src/app/api/manager/riders/route.ts` (GET), `src/app/api/manager/riders/[id]/route.ts`, `…/[id]/history/route.ts`, `…/[id]/ratings/route.ts`, `…/[id]/documents/[docId]/url/route.ts`, `…/[id]/ledger/route.ts`, `scripts/qa/manager-riders.ts` (add `"test:manager-riders"`).
- Modify: `src/lib/auth/manager-scope.ts` (`applyRiderScope`), `src/lib/ops/live-rules.ts` (`riderEligibility` reads `canWork`; `getLiveSnapshot` adds `riderCode`), `src/lib/features/catalog.ts` (`manager.exceptions.decide`).
- Create only if P0 marked missing (Rider plan paths and signatures): `src/lib/rider/figures.ts`, `src/lib/data-access/rider-insights.ts` (`getRiderHistory`, `getRiderPerformance`).

**Interfaces — Produces:**
```ts
export type RiderState = "online" | "available" | "on_delivery" | "break" | "stale" | "offline";
export function riderState(s: { isOnline: boolean; breakUntil: Date | null; lastFixAt: Date | null; activeDeliveries: number }, now: Date): RiderState; // stale = online with fix older than RIDER_PRESENCE_MS
export function maskNumber(n: string | null): string | null;            // "XXXX" + last 4
export function requiredRiderDocsMissing(docs: { type: string; status: string }[]): string[]; // of aadhaar, driving_licence, photo
export function allowedRiderActions(r: { verification: string; account: string; activeDeliveries: number }, perms: Record<string, boolean>): RiderDetail["allowed"];
export function documentExpiring(expiresOn: string | null, now: Date, days?: number): boolean; // default 30
export async function listRidersForManager(scope: ManagerScope, q: RiderQuery, now: Date): Promise<{ items: RiderListItem[]; nextCursor: string | null; counts: RiderCounts }>;
export async function getRiderForManager(scope: ManagerScope, id: string, perms: Record<string, boolean>, now: Date): Promise<RiderDetail | null>;
export async function getRiderLedger(scope: ManagerScope, id: string, q: { from?: string; to?: string; status?: "pending" | "paid"; cursor?: string | null }): Promise<LedgerPage | null>;
export function serializeRiderDetail(d: RiderDetailRow, perms: Record<string, boolean>): RiderDetail; // omits `money` without finance.view
```
- Position rule in the serializer: `availability.position` and `active[].route` only when online or `activeDeliveries > 0`.
- `active[]` ETAs, route and delay come from Phase 3's live module for the rider's deliveries — no second ETA model.

- [ ] **Step 1: Write `scripts/qa/manager-riders.ts`:** pure — `riderState` table (online + break → `break`; online + 6-min fix → `stale`; online + active delivery → `on_delivery`; online idle fresh → `available`; offline with active delivery → `on_delivery`); `maskNumber("123456781234")` → `"XXXX1234"`, null → null; `requiredRiderDocsMissing` with licence rejected → `["driving_licence", …]`; `allowedRiderActions` hides status actions without `manager.riders.status`, hides `suspend` when account suspended, `addAdjustment` needs `finance.adjust`, `requestPayout` needs `initiate_payment`; serializer omits `money` without `finance.view`, `position` null for an offline idle rider, never emits keys matching `/account_number|ifsc|upi_id|customer_id|aadhaar$/` (walk the object), Aadhaar only masked; query parsing (`state=available,on_delivery`, bad `state` → 400 `field`, `limit=101` → 400); cursor round-trip. Structural: every route opens with `managerApiContext("manager.riders.view")`; ledger route additionally checks `manager.finance.view`; no `select("*")`; every service-role rider query applies `applyRiderScope`. Live (skip when `BASE` unreachable or `QA_MANAGER_*` absent): 401 unauthenticated; out-of-zone rider → 404; document URL expires ≤ 60 s.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsx scripts/qa/manager-live-rules.ts` still PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`.**
- [ ] **Step 5: Commit** `feat(api): manager riders — list, detail, live state, performance, ratings, history, ledger`.

### Task S4: Rider actions, onboarding, document upload; suspension enforced

**Files:**
- Create: `src/app/api/manager/riders/[id]/actions/route.ts`, `src/app/api/manager/riders/[id]/documents/route.ts` (POST multipart), `scripts/qa/manager-rider-actions.ts`.
- Modify: `src/app/api/manager/riders/route.ts` (POST onboard), `src/lib/data-access/manager-riders.ts` (`actOnRider`, `onboardRider`, `uploadRiderDocumentAsOps`), `src/lib/data-access/employees.ts` (Team's driver creation → `ops_onboard_rider` with actor = admin; behaviour otherwise unchanged), `src/app/api/rider/status/route.ts` + `src/lib/rider/availability.ts` (going online refused when `!canWork`), `src/app/api/rider/me/route.ts` (403 `account_suspended` / `verification_rejected`), the web `/driver` layout (same refusal, plain message), dispatch eligibility (`src/lib/dispatch/*`, skip riders with `rider_can_work = false`).
- Use, or create at the Rider plan's path/signature if missing: `uploadRiderDocument(driverId, input)`, `riderDocumentUrl(driverId, docId)` in `src/lib/data-access/rider-profile.ts`.

**Interfaces — Produces:**
```ts
export const RIDER_ACTION_PERMISSION: Record<RiderAction, FeatureKey>; // matches the Global Constraints table
export function mapRiderRpcError(e: PostgrestError): { status: number; body: { error: string; [k: string]: unknown } };
export async function actOnRider(ctx: ManagerApiContextOk, riderId: string, body: RiderActionBody): Promise<{ ok: true; rider: RiderDetail } | { ok: false; status: number; body: object }>;
export async function onboardRider(ctx: ManagerApiContextOk, body: OnboardRiderBody): Promise<{ ok: true; riderId: string; riderCode: string; credentials: { mobile: string; password: string } | null } | { ok: false; status: number; body: object }>;
```
- `mapRiderRpcError`: 42501 → 404 `not_found`; `stale`, `invalid_transition`, `already_decided` → 409; `documents_unverified` → 409 `{ missing: detail.split(",") }`; `active_delivery` → 409 `{ orders: detail.split(",") }`; `reason_required` → 400.
- Writes rate-limited with `managerWriteLimit`; onboarding also `rider-onboard:${user.id}` 10 / hour.

- [ ] **Step 1: Write `scripts/qa/manager-rider-actions.ts`:** pure — `mapRiderRpcError` for every code; body validation (reason "ok" → `reason_required`; `suspend` without `expected` → 400; `reject_document` without remarks → `remarks_required`; `add_adjustment` amount 0 or kind `salary` → 400; onboard 9-digit mobile → 400 `field: "mobile"`, missing `zoneId` → 400, pincode "4913" → 400); `RIDER_ACTION_PERMISSION` equals the table; upload rejects `text/html` magic bytes and an 11 MB file. Structural: `onboardRider` and `employees.ts` driver creation call `ops_onboard_rider` and contain no direct `profiles` role update; `/api/rider/status` POST checks `canWork` before `nextAvailability`; dispatch eligibility references `rider_can_work` or `canWork`. Live (skip as S3): suspend, replay same `clientActionId` → one change; stale `expected` → 409; a suspended QA rider `POST /api/rider/status {online:true}` → 403 `account_suspended`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`; `npm run test:platform`; walk `docs/SECURITY_AUDIT.md` (new RPCs, uploads, auth-path change in `/api/rider/*`) and add a log row.**
- [ ] **Step 5: Commit** `feat(api): audited rider verification, suspension, documents and onboarding; suspended riders cannot work`.

### Task S5: Migration 0152 — payment requests, cash and exception decisions

**Files:** Create `supabase/migrations/0152_payment_requests_cash_exceptions.sql`, `scripts/qa/sql/migration-0152.mjs`; Modify `docs/DATABASE.md`.

**Interfaces — Produces (database):**
- `payment_requests (id uuid pk default gen_random_uuid(), kind text not null check in ('rider_payout','vendor_settlement'), subject_id uuid not null, zone_id uuid references delivery_zones, amount numeric(12,2) not null check > 0, period_end date, salary_amount numeric(10,2) check (salary_amount is null or salary_amount > 0), method text check in ('bank','upi','cash','other'), note text, status text not null default 'pending_approval' check in ('pending_approval','approved','rejected','cancelled'), requested_by uuid not null, requested_at timestamptz not null default now(), decided_by uuid, decided_at timestamptz, decision_note text, reference text, paid_on date, result_id uuid, client_action_id text unique, constraint payment_requests_maker_checker check (decided_by is null or decided_by <> requested_by), constraint payment_requests_approved_ref check (status <> 'approved' or reference is not null))`; partial unique one `pending_approval` per `(kind, subject_id)`. RLS: select for admins and `manager_can_see_zone(zone_id)`; no write policies; revoked writes from anon/authenticated.
- `rider_payouts.request_id uuid references payment_requests` (add column if not exists).
- `_record_rider_payout(p_actor uuid, p_driver uuid, p_period_end date, p_method text, p_reference text, p_paid_on date, p_note text) returns uuid` — the 0083 body moved here verbatim (lock unattached rows, sum, `nothing_to_pay`, insert, attach) with `created_by = p_actor`; **re-declare** `record_rider_payout(...)` as `is_admin()` check + `_record_rider_payout(auth.uid(), …)` — same signature and behaviour.
- `_rider_payout_preview(p_driver uuid, p_period_end date) returns numeric` — the same sum without writing (used by request and approval).
- `ops_request_rider_payout(p_actor, p_rider, p_period_end, p_method, p_salary numeric, p_note, p_client_action_id) returns jsonb` — preview + salary > 0 else `nothing_to_pay`; `duplicate_pending`; action `payment.request`.
- `ops_decide_payment_request(p_actor, p_request, p_decision text /* approve|reject|cancel */, p_reference text, p_paid_on date, p_confirm_amount numeric, p_note text, p_client_action_id) returns jsonb` — approve: `same_person` when actor = requester; locks the request; re-computes preview + salary; if ≠ stored amount and ≠ `p_confirm_amount` → `amount_changed` (detail = new amount); inserts the salary `rider_adjustments` row (`kind='salary'`, `effective_on = period_end`, `created_by = requester`) when present, calls `_record_rider_payout(p_actor, …)`, sets `rider_payouts.request_id`, `result_id`, status `approved`; reject requires note; cancel only by the requester while pending; action `payment.approve|reject|cancel` with before/after. For `kind = 'vendor_settlement'` it raises `not_supported` (Phase 6 fills it in).
- `ops_decide_cash_deposit(p_actor, p_deposit, p_decision text /* confirm|dispute */, p_note text, p_zone uuid, p_client_action_id) returns jsonb` — confirm inserts `cod_handovers` (leg `rider_to_manager`, amount, `zone_id = p_zone` which must be one of the rider's zones in scope) and sets `confirmed` + `handover_id`; dispute requires note; action `cash.deposit.confirm|dispute`.
- `ops_resolve_cash_dispute(p_actor, p_dispute, p_resolution text, p_client_action_id) returns jsonb` — action `cash.dispute.resolve`.
- `ops_decide_delivery_exception(p_actor, p_exception, p_decision text /* approve|reject|acknowledge */, p_note text, p_client_action_id) returns jsonb` — request kinds accept approve/reject, report kinds acknowledge only; reject requires note; `already_resolved` unless `pending`; sets status, `decided_by/at`, `decision_note`, writes the `delivery_events` `exception_decided` row; action `delivery.exception.<decision>`; returns `{ exception_id, kind, delivery_id, order_id, status }` for the TS after-effects.

- [ ] **Step 1: Write `migration-0152.mjs`:** salaried rider with no earnings: request with salary 12000 → `pending_approval`, amount 12000; second request → `duplicate_pending`; requester approves → `same_person`; a direct `update payment_requests set decided_by = requested_by` as service role → check violation; another manager approves without reference → `reference_required`; with reference → `rider_adjustments` salary row + `rider_payouts` row (12000, `request_id` set) + every unattached row attached + audit row, request `approved`; replay → same result, still one payout; add a 500 bonus after a new request, approve → `amount_changed` detail 12500, approve with `p_confirm_amount = 12500` → payout 12500; `record_rider_payout` as admin still works and as a manager → `forbidden`; zone-B manager decides → `forbidden`; deposit confirm → `cod_handovers` row with the zone, deposit `confirmed`; dispute without note → `reason_required`; exception approve on a report kind → error; acknowledge works; reject without note → `reason_required`; second decision → `already_resolved`; manager reads zone-A payment requests only.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration. Step 4: Run it, the 0150/0151 proofs and every SQL proof — all `ok`.**
- [ ] **Step 5: Commit** `feat(db): 0152 maker–checker payment requests, audited cash and exception decisions`.

### Task S6: Payment requests, cash deposits, disputes — data layer and routes

**Files:**
- Create: `src/lib/data-access/payment-requests.ts`, `src/lib/data-access/manager-cash.ts`, routes `src/app/api/manager/payments/requests/route.ts` (GET, POST), `…/requests/[id]/decide/route.ts`, `src/app/api/manager/cash/deposits/route.ts`, `…/deposits/[id]/decide/route.ts`, `…/deposits/[id]/photo/route.ts`, `src/app/api/manager/cash/disputes/route.ts`, `…/disputes/[id]/resolve/route.ts`, `scripts/qa/manager-payments.ts` (add `"test:manager-payments"`).
- Modify (or create at the Rider path/signature if missing): `src/lib/data-access/rider-cash.ts` — `decideDeposit(actor, id, decision, note?)` becomes a wrapper over `ops_decide_cash_deposit` (signature unchanged); `src/app/manager/cash/{page,actions}.ts(x)` deposit queue uses it; `src/app/admin/riders/[id]/money-actions.ts` `recordPayoutAction` unchanged (admin wrapper still exists).
- Modify: `src/lib/notifications/order-events.ts` — `notifyPaymentRequested(requestId)` (push managers in the zone holding `approve_payment`, and admins), `notifyPaymentDecided(requestId)` (push the requester; on approval push the rider "Payout of ₹X recorded").

**Interfaces — Produces:**
```ts
export async function listPaymentRequests(scope: ManagerScope, viewer: { id: string; perms: Record<string, boolean>; isAdmin: boolean }, q: PaymentRequestQuery): Promise<{ items: PaymentRequest[]; nextCursor: string | null; counts: Record<PaymentRequest["status"], number> }>;
export async function createRiderPayoutRequest(ctx: ManagerApiContextOk, body: CreatePayoutBody): Promise<Result<PaymentRequest>>;
export async function decidePaymentRequest(ctx: ManagerApiContextOk, id: string, body: DecideBody): Promise<Result<PaymentRequest>>;
export function canDecide(r: { requestedBy: string; status: string }, viewer: { id: string; perms: Record<string, boolean>; isAdmin: boolean }): boolean;
export async function listCashDeposits(scope: ManagerScope, q: DepositQuery): Promise<Page<CashDeposit> & { counts: { submitted: number } }>;
export async function listCashDisputes(scope: ManagerScope, q: DisputeQuery): Promise<Page<CashDispute>>;
export async function resolveCashDispute(ctx: ManagerApiContextOk, id: string, body: { clientActionId: string; resolution: string }): Promise<Result<CashDispute>>;
```
- Approve route checks `manager.finance.approve_payment` (admins pass); cancel checks `initiate_payment`; the RPC enforces `same_person` regardless.
- Confirming a deposit picks `p_zone` = the first of the rider's zones in the manager's scope (admins: the rider's first zone).

- [ ] **Step 1: Write `scripts/qa/manager-payments.ts`:** pure — `canDecide` (requester with approve → false; other manager with approve → true; without approve → false; admin who requested → false; decided request → false); body validation (`periodEnd` in the future → 400; approve without `reference` → `reference_required`; reject without note → `note_required`; dispute without note → `note_required`; resolution 2 chars → 400); `amount_changed` maps to 409 with `amount`. Structural: decide route checks `manager.finance.approve_payment` for approve; `decideDeposit` calls `ops_decide_cash_deposit` and no longer inserts `cod_handovers` itself; every list applies scope. Live (skip as before): create then approve as the same QA manager → 403 `same_person`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`; `next build`; SECURITY_AUDIT log row (financial RPCs, maker–checker).**
- [ ] **Step 5: Commit** `feat(api): maker–checker rider payouts, cash deposit and dispute decisions for managers`.

### Task S7: Exception queue and decisions

**Files:**
- Create: `src/app/api/manager/exceptions/route.ts`, `…/exceptions/[id]/decide/route.ts`, `…/exceptions/[id]/photo/route.ts`, `scripts/qa/manager-exceptions.ts` (add `"test:manager-exceptions"`).
- Modify (or create at the Rider path/signature if missing): `src/lib/data-access/delivery-exceptions.ts` — `decideException(actor: { id: string; role: "admin" | "manager" }, id: string, decision: "approve" | "reject" | "acknowledge", note?: string)` calls `ops_decide_delivery_exception`, then runs the after-effects exactly as Rider phase 2 Task 4 specifies (failed kinds → delivery `failed` + `cancelOrderAsOps(orderId, { by, reason: "delivery_failed: <kind>", requestedBy: actor.id })`; `complete_without_code` → completion with `delivery_method = 'ops_approved'` and COD record; `manual_pickup` → nothing further; `go_offline` → release + `dispatchOrder(orderId, "ready", { excludeRiderIds })` + `ops_force_rider_offline`), each guarded by the current state so a replay never repeats an effect; returns `{ ok: false, error: "effect_failed" }` when an effect throws after the decision committed. The web manager board's `decideExceptionAction` delegates to it.
- Modify: `src/lib/data-access/manager-riders.ts` (`openExceptions` on rider detail).

**Interfaces — Produces:** `listExceptions(scope: ManagerScope, q: { status?: string; rider?: string; cursor?: string | null }): Promise<Page<DeliveryException> & { counts: { pending: number } }>`; `serializeException(row, viewerPerms): DeliveryException` (`decisions` = `[]` when decided or without `manager.exceptions.decide`).

- [ ] **Step 1: Write `scripts/qa/manager-exceptions.ts`:** pure — `serializeException` decisions per kind (request kinds → approve/reject; report kinds → acknowledge; decided → []; without the permission → []); body validation (reject without note → 400 `note_required`; unknown decision → 400). Structural: decide route opens with `managerApiContext("manager.exceptions.decide")`; `decideException` calls `ops_decide_delivery_exception` before any effect and `cancelOrderAsOps` only inside a state re-check; the manager web action delegates to `decideException`. Live (skip as before): deciding a decided exception → 409 `already_resolved`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; all `test:manager-*` scripts.**
- [ ] **Step 5: Commit** `feat(api): manager exception queue — audited decisions with replay-safe after-effects`.

---

# Part A — app (worktree `deligro-manager-p5a`)

Every screen: loading skeleton, filtered-empty dashed line, full-screen empty state, error + Retry, pull to refresh; ≥ 840 dp list + detail side by side; strings through `tr`; figures in JetBrains Mono; status as dot + word, not a capsule.

### Task A1: Models, repositories, fixtures

**Files:** Create `apps/manager/lib/models/{rider,payment_request,cash,delivery_exception}.dart`, `apps/manager/lib/data/{riders_repository,payments_repository,cash_repository,exceptions_repository}.dart`, `apps/manager/test/fixtures/phase5/*.json` (one per pinned shape, including a detail **without** `money`), `apps/manager/test/rider_models_test.dart`.

**Interfaces — Produces:** `RiderListItem`, `RiderDetail`, `RiderDocument`, `RiderHistoryItem`, `LedgerRow`, `Payout`, `PaymentRequest`, `CashDeposit`, `CashDispute`, `DeliveryException`, enums with `.unknown`; `RiderFilters { q, states, verification, account, zoneId, filter }` with `fromUri` / `toQuery`; `sealed class RiderAction` (`Approve`, `Reject`, `Suspend`, `Reactivate`, `ForceOffline`, `VerifyDocument`, `RejectDocument`, `AddAdjustment`) each holding a `clientActionId` generated once; `ActionRefused(code, details)` (reused from Phase 3); abstract repositories + `Api…` implementations + `Fake…` for tests.

- [ ] **Step 1: Write `rider_models_test.dart`:** every fixture parses; detail without `money` → `money == null`; `position: null` parses; unknown `state` → `.unknown`; rider money `1500.5` parses as double; `RiderFilters.fromUri('/more/riders?state=available')` → `{available}`; `toQuery()` round-trips; 409 `{"error":"active_delivery","orders":["AB12CD34"]}` → `ActionRefused('active_delivery', ['AB12CD34'])`; 409 `{"error":"amount_changed","amount":12500}` → `ActionRefused('amount_changed', ['12500'])`; a retried `Suspend` keeps its id.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): rider, payment, cash and exception models, repositories, fixtures`.

### Task A2: Riders list

**Files:** Create `apps/manager/lib/features/riders/riders_screen.dart`, `…/riders_providers.dart`; Modify `apps/manager/lib/router.dart` (`/more/riders`, `/more/riders/:id`, `/more/riders/new`), More menu row (gated `manager.riders.view`), Home tile deep links (Active Riders → `?account=active`, Online Riders → `?state=online,available,on_delivery`, On Delivery → `?state=on_delivery`); test `apps/manager/test/riders_screen_test.dart`.

**Interfaces — Produces:** search (debounced 400 ms), state tabs **All · Available (n) · On delivery (n) · Break (n) · Offline (n)**, chips "Needs review", "Documents expiring", "Suspended", zone; tile: photo/initials, name, rider code (mono), state dot + word, "updated N min ago" (grey past 2 min), today's deliveries, rating, badges for pending/expiring documents and open complaints; infinite scroll at 80 %; "Add rider" FAB only with `manager.riders.onboard`; 30 s refresh while visible.

- [ ] **Step 1: Write `riders_screen_test.dart`** (fake repo): first page with `cursor: null`; scroll loads next and stops at null; "Available (5)" requests `state=available`; route `?state=on_delivery` opens that tab; typing "DR-00" requests `q=DR-00` once; stale fix shows "updated 6 min ago" in grey; filtered-empty dashed line; error → Retry; FAB hidden without `manager.riders.onboard`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): Riders list — live state, search, filters, paging`.

### Task A3: Rider detail — overview & live, deliveries, performance, documents, money, cash, complaints, actions

**Files:** Create `apps/manager/lib/features/riders/rider_detail_screen.dart` and tab widgets `rider_overview_tab.dart`, `rider_deliveries_tab.dart`, `rider_performance_tab.dart`, `rider_documents_tab.dart`, `rider_money_tab.dart`, `rider_cash_tab.dart`, `rider_complaints_tab.dart`; test `apps/manager/test/rider_detail_test.dart`.

**Interfaces — Produces:**
- Header: name, code, state, verification and account (dot + word), zone(s), Call (`tel:`) and WhatsApp (`https://wa.me/…`).
- **Overview**: map (`flutter_map`) with the rider's position (only when present; otherwise "Location shown only while the rider is online"), each active delivery's shop and drop pins, route polyline, ETA times and delay chip; per-delivery Reassign (opens Phase 3's rider picker for that order) and an "Assign an order" sheet listing unassigned orders in scope (Phase 3 `GET /api/manager/orders?queue=unassigned`) when `allowed.assign`; profile facts (vehicle, licence masked + expiry, emergency contact).
- **Deliveries**: history list with outcome filter chips (Delivered · Failed · Cancelled · Reassigned), date range, totals row; tap → `/orders/<id>`.
- **Performance**: tiles (acceptance rate, average delivery minutes, failed rate, online hours), 30-day/month switch, monthly table, rating average + distribution bars + recent comments.
- **Documents**: list with status, expiry (amber within 30 days, red expired), View (signed URL in an in-app viewer for images, external app for PDF), Verify / Reject (remarks) when `allowed.reviewDocuments`, Upload when `allowed.uploadDocuments`.
- **Money** (only when `money` present): pending, paid total, last payout, pending requests (status, requester), ledger link → `/more/riders/:id/ledger`, "Record salary payout" when `allowed.requestPayout` (opens A5's request form), "Add bonus / deduction" when `allowed.addAdjustment` (kind, amount, date, reason).
- **Cash**: collected / deposited / pending today (mono), open deposits (Confirm / Dispute with note, `manager.cash`), open disputes (Resolve).
- **Complaints**: `openComplaints` → Phase 4 ticket thread `/more/tickets/:id`.
- Actions menu shows only `allowed` ones; Approve / Reject / Suspend / Reactivate / Force offline open a reason dialog (Submit disabled under 3 chars); refusals map to sentences: `documents_unverified` → "Missing verified: Driving licence" + "Approve anyway"; `active_delivery` → "Reassign AB12CD34 first" with a link to that order; `stale` → "Someone else changed this rider" + refresh; network error → retry with the same `clientActionId`.

- [ ] **Step 1: Write `rider_detail_test.dart`:** fixture renders name, code and state; offline fixture shows the "Location shown only while…" line and no marker; Money tab absent without `money`; only allowed actions shown; Suspend → reason dialog → `act(Suspend(expected: 'active'))`; `ActionRefused('active_delivery', ['AB12CD34'])` shows "Reassign AB12CD34 first" and tapping navigates to `/orders/<id>`; Approve → `documents_unverified` → "Approve anyway" resends with `override: true` and the same id; document Reject requires remarks; Deliveries "Failed" chip requests `outcome=failed`; Call launches `tel:+91…` (fake launcher); deposit Dispute requires a note.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): rider detail — live map, deliveries, performance, documents, money, cash, complaints, audited actions`.

### Task A4: Rider onboarding

**Files:** Create `apps/manager/lib/features/riders/rider_onboard_screen.dart`; test `apps/manager/test/rider_onboard_test.dart`.

**Interfaces — Produces:** steps **Rider** (name, 10-digit mobile, email, optional password ≥ 8, zone from the manager's zones) → **Vehicle & licence** (type, owner Deligro/rider, registration, licence number, expiry) → **Address & emergency** (address, 6-digit pincode, emergency name/phone/relation) → **Documents** (Aadhaar, driving licence, photo required for verification but optional now; RC/insurance/PUC shown only when owner = rider; camera or file) → **Review & submit**. Draft in `SharedPreferences` (`manager-rider-onboard-draft`); one `clientActionId` per submission; on 201 shows generated credentials once with Copy and "This password will not be shown again"; then uploads documents one by one with progress and per-file Retry; opens the new rider.

- [ ] **Step 1: Write `rider_onboard_test.dart`:** Next disabled until each step's required fields are valid (9-digit mobile, 4-digit pincode rejected with messages); zone preselected when the manager has one zone; RC/insurance/PUC hidden for owner Deligro; double-tap submit calls `onboard` once; 409 `phone_taken` returns to step 1 with "This mobile number already has an account"; credentials shown with Copy; a failed upload shows Retry for that file only; the draft survives a rebuild.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): onboard a rider — account, vehicle, licence, emergency contact, documents`.

### Task A5: Approvals (maker–checker) and rider ledger

**Files:** Create `apps/manager/lib/features/payments/approvals_screen.dart`, `…/payout_request_sheet.dart`, `apps/manager/lib/features/riders/rider_ledger_screen.dart`; Modify More menu (row "Approvals" with pending count, gated `manager.finance.view`), router (`/more/approvals`, `/more/riders/:id/ledger`), push link `payment_request` → `/more/approvals?id=<id>`; test `apps/manager/test/approvals_test.dart`.

**Interfaces — Produces:**
- Approvals: tabs **Waiting (n) · Approved · Rejected · Mine**; card shows subject, amount (mono), period end, salary component, method, requester and time, note; **Approve** (enter UTR/reference, paid-on date) and **Reject** (note) only when `canDecide`; "You requested this — another person must approve it" when the viewer is the requester; requester sees **Withdraw** on their own pending request.
- `amount_changed` → a dialog "The amount is now ₹12,500.00 (was ₹12,000.00). Approve ₹12,500.00?" → resends with `confirmAmount` and the same `clientActionId`.
- Payout request sheet: period end (date ≤ today), method, salary amount (optional), note; shows "Will pay ₹X (salary ₹Y + ₹Z pending ledger)" from the rider detail's `money.pending` + salary before submit.
- Ledger screen: rows with type, date, reason, paid/pending, filters, payouts list with references.

- [ ] **Step 1: Write `approvals_test.dart`:** a request by the viewer shows the "another person" line and no Approve; another's request with `canDecide` shows Approve; Approve without a reference keeps Submit disabled; `amount_changed` dialog resends with `confirmAmount: 12500` and the same id; Reject requires a note; "Waiting (2)" requests `status=pending_approval`; payout sheet refuses a future period end; ledger "Pending" filter requests `status=pending`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): approvals with maker–checker, salary payout requests, rider ledger`.

### Task A6: Cash deposits and disputes

**Files:** Create `apps/manager/lib/features/cash/cash_screen.dart`; Modify More menu (row "Cash deposits" with submitted count, gated `manager.cash`), router `/more/cash`, push link `cash_deposit` → `/more/cash`; test `apps/manager/test/cash_screen_test.dart`.

**Interfaces — Produces:** tabs **Deposits (n) · Disputes (n) · History**; deposit card: rider, amount (mono), method, reference, receipt photo thumbnail (signed URL), note; **Confirm** and **Dispute** (note required); dispute card: day, claimed amount, message, **Resolve** (resolution text); history of confirmed/disputed/resolved with who and when.

- [ ] **Step 1: Write `cash_screen_test.dart`:** submitted deposits listed; Confirm calls `decide(confirm)` once on double tap; Dispute without a note keeps Submit disabled; `already_decided` → "Already handled by someone else" + refresh; Resolve requires 3+ chars; tab counts from the response.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): cash deposits and disputes — confirm, dispute, resolve`.

### Task A7: Exceptions queue

**Files:** Create `apps/manager/lib/features/live/exceptions_screen.dart`; Modify the Live tab (badge "Needs a decision (n)" opening `/live/exceptions`), router, push link `delivery_exception` → `/live/exceptions?id=<id>`; test `apps/manager/test/exceptions_screen_test.dart`.

**Interfaces — Produces:** oldest pending first; card: kind in words, order code (→ `/orders/<id>`), rider with Call, reason, notes, photo (signed URL), map pin when `lat/lng`, age; buttons from `decisions` only (Approve / Reject with note / Acknowledge); confirmation for approving `failed_delivery` ("This cancels order AB12CD34 and refunds the customer per the usual rules"); `effect_failed` → "Decision saved; finishing it failed" with Retry (same `clientActionId`); 10 s refresh while visible.

- [ ] **Step 1: Write `exceptions_screen_test.dart`:** report kind shows only Acknowledge; request kind shows Approve and Reject; no buttons without `manager.exceptions.decide` (`decisions: []`); approving `failed_delivery` shows the cancellation warning first; Reject requires a note; `effect_failed` shows the Retry line and Retry re-sends the identical `clientActionId`; Live badge shows the pending count.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): delivery exception queue — approve, reject, acknowledge, retry after-effects`.

---

### Task I1: Integrate, contract check, phase exit (in `F:\hub26\deligro-manager`)

- [ ] **Step 1:** `git merge feat/manager-p5-server`, then `git merge feat/manager-p5-app`; resolve (should be none — disjoint paths).
- [ ] **Step 2: Contract check.** Extend the Phase 3 generator (`scripts/qa/manager-contract-fixtures.ts`) to emit, from Part S's serializers on fixed rows, one JSON per Phase 5 shape into `apps/manager/test/contract/phase5/`; add `apps/manager/test/contract_phase5_test.dart` that parses every generated file with the Part A models and asserts no field the app reads is missing or mistyped. Run both.
- [ ] **Step 3: Phase exit:** every `scripts/qa/sql/migration-*.mjs` `ok`; all `npx tsx scripts/qa/manager-*.ts` and `test:idor`, `test:platform`, `test:metrics` PASS; `npx tsc --noEmit`; `npm run lint`; `next build`; `cd apps/manager && flutter analyze && flutter test`; release APK (`--dart-define-from-file=env/prod.json`) installed on `deligro_test`, cold start → login with no `FATAL`/`E/flutter` in logcat; widget-test screenshots (golden or `takeScreenshot`) of Riders list, rider detail Overview, Approvals and Exceptions saved under the scratchpad for the report.
- [ ] **Step 4:** Update `docs/DATABASE.md` (0150–0152 summary), add the phase's SECURITY_AUDIT log row if not already added; commit `chore(manager-app): phase 5 integration — contract fixtures and exit checks`.
- [ ] **Step 5:** `git worktree remove F:/hub26/deligro-manager-p5s`, `git worktree remove F:/hub26/deligro-manager-p5a`, `git branch -d feat/manager-p5-server feat/manager-p5-app`.
