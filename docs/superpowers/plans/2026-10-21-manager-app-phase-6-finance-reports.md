# Manager App — Phase 6: Finance & Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Finance tab with every §7 figure (nine sales & commission, nine payment-tracking), settlement history with transaction references, failed and delayed transactions, reconciliation of orders against settlements and of cash against deposits, maker–checker vendor settlements and refund decisions behind their permissions — and the twelve §13 reports from one server registry, exported as CSV, Excel and PDF, agreeing to the rupee with the dashboard and Finance (§18.4).

**Architecture:** Migration `0155` adds zone-scoped manager reads on the money tables and the indexes the reports need; `0156` extends Phase 5's generic `payment_requests` to vendor settlements (one RPC approves and marks the draft paid with the reference and the audit row) and adds an audited refund-decision RPC. Pure rules (`src/lib/ops/finance-rules.ts`) decide delays and reconciliation states; every figure comes from `src/lib/metrics` through Phase 2's scoped loader (`src/lib/data-access/ops-metrics.ts`) and the existing settlement arithmetic (`src/lib/settlements/math.ts`, `admin-settlements.ts` — never forked). One report registry (`src/lib/reports/registry.ts`) serves the manager API and the admin web Reports page. The Flutter app adds Finance (overview, payment tracking, settlements, approvals for settlements, refunds, reconciliation) and a Reports screen with a generic exporter, coded against the JSON pinned below with fake repositories.

**Tech Stack:** Supabase Postgres (RPCs, RLS, indexes), Next.js route handlers (read `node_modules/next/dist/docs/` first), Flutter 3.47 / Riverpod 3 / go_router, `fl_chart`, `excel`, `pdf` + `printing`, `share_plus` (all already in `apps/manager` from Phase 2).

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (§7, §13, Money definitions, Permissions, Audit log). Earlier plans: phases 1–5 — Phase 2 (`ops-metrics.ts` loader, `dashboard-payload.ts`, `stats_export.dart` / `ReportMeta`), Phase 3 (`ops_require_staff`, `_ops_set_actor`, contract emitter `scripts/qa/manager-contract-emit.ts`, support tickets 0143), Phase 4 (`vendor-rules.ts` `vendorRates`), Phase 5 (`payment_requests` 0152, `ops_decide_payment_request`, `/api/manager/payments/requests*`, `PaymentRequest` shape, Approvals screen, rider ledger, `cash_deposits`, `src/lib/rider/figures.ts`, `getRiderPerformance`).

## Execution layout — two halves in parallel

| Half | Worktree | Branch | Touches |
|---|---|---|---|
| **Part S (server)** | `F:\hub26\deligro-manager-p6s` | `feat/manager-p6-server` | `supabase/`, `scripts/`, `src/`, `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md`, `package.json` |
| **Part A (app)** | `F:\hub26\deligro-manager-p6a` | `feat/manager-p6-app` | `apps/manager/` only |

**Task P0** runs first in `F:\hub26\deligro-manager`. Both halves then branch from `feat/manager-app` at P0's last commit and share no files. When both are done: merge S, then A, into `feat/manager-app`, run **Task I1** there, then `git worktree remove` both and `git branch -d` both branches.

## Global Constraints

- Phase 1–5 Global Constraints apply unchanged (AGENTS.md rules, migrations 0141–0199 with **0155–0159 for this phase**, F:\dev build env, release-APK smoke test, commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never touch `F:\hub26\deligro`, `deligro-rider`, `deligro-vendor`; never bare `git stash`.
- English only — no Hindi (owner).
- **Every audited write is one RPC that changes and logs in the same transaction** (0142 pattern: `security definer set search_path = public`, `_ops_set_actor(p_actor)`, `ops_require_staff(p_actor, <zone>)` first, replay-safe on `p_client_action_id`, `revoke execute … from public, anon, authenticated; grant execute … to service_role`).
- **One arithmetic.** Every money figure in this phase is produced by `src/lib/metrics` (sales, discounts, refunds, commission, payable) or `src/lib/settlements/math.ts` via `admin-settlements.ts` (`previewSettlement`, `createSettlementDraft`, `breakdownOrder`, `sumSettlementTotals`). No route, report or screen recomputes a figure inline. Rider ledger sums use the Rider plan's ledger sign rule (`src/lib/rider/figures.ts`, present after Phase 5).
- **Never edit a completed financial record.** `vendor_settlements` with status `paid`, `rider_payouts`, approved `refunds`, `cod_handovers`, `ops_audit_log` are never updated or deleted by this phase's code; corrections are new rows (0048).
- **Money units:** order/settlement money whole rupees (integers); rider ledger money JSON numbers with up to 2 decimals (as Phase 5).
- **Dates:** IST calendar days `YYYY-MM-DD`, inclusive ranges, max 366 days (`MAX_RANGE_DAYS` from `stats-query.ts`); attribution by the order's `created_at` (design), except where a row says otherwise below (payouts by `paid_on`, settlements by `paid_at`, refunds attributed to their order's date).
- **Zone scope** on every read: orders by `zone_id`; settlements, settlement lines and corrections through the restaurant's `zone_id`; refunds and payments through their order; cash through `cod_handovers.zone_id`; riders via `applyRiderScope` (Phase 5). Out-of-scope ids answer 404 `not_found`. `zone=` narrows (`narrowScope`), never widens.
- **Permissions per call** (`managerApiContext(key)` first):

| Call | Key(s) |
|---|---|
| any `/api/manager/finance/*` read | `manager.finance.view` |
| initiate a vendor settlement (draft + request) | `manager.finance.view` + `manager.finance.initiate_payment` |
| approve / reject a settlement request | `manager.finance.approve_payment` (via Phase 5's decide route; admins always) |
| decide a refund | `manager.finance.view` + `manager.finance.adjust` |
| cash reconciliation section | `manager.finance.view` **or** `manager.cash` |
| `/api/manager/reports*` | `manager.reports.view`, plus the report kind's own key (registry `permission`) |

## Claude's calls

- **Vendor settlement maker–checker.** A manager with `initiate_payment` builds a draft with the existing `createSettlementDraft` (period) or a one-order draft (`kind = 'instant'`, built by the same draft code path for one order; `markOrderPaid`'s direct pay stays admin-only), then `ops_request_vendor_settlement` opens a `payment_requests` row (`kind 'vendor_settlement'`, `subject_id` = restaurant, `settlement_id` = the draft, `amount` = draft `net_payable`). Approval (`ops_decide_payment_request`, vendor branch): `same_person` refused; re-checks the draft with the same refund-staleness rule `markSettlementPaid` uses and the same `net_payable < 0` refusal. If stale, the RPC answers `amount_changed` with the freshly previewed amount; the route then voids the stale draft, rebuilds one for the same period (`createSettlementDraft`), re-points the request (`ops_repoint_settlement_request`, audited) and returns 409 `amount_changed` with the new amount; the approver re-submits with `confirmAmount`. Approve sets the settlement `paid`, `paid_by` = approver, `payment_ref` = reference, `paid_at = now()`; reject or cancel **voids the draft** (so its orders can be resettled) — each in one transaction with the audit row.
- **Admin paths converge.** `markSettlementPaid`, `voidSettlement` and `decideRefund` keep their signatures but write through audited RPCs (`ops_mark_settlement_paid`, `ops_void_settlement`, `ops_decide_refund`) with `p_actor` = the admin. An admin may still pay a draft directly (no checker for admins — design: "a different person with approve_payment (or an admin)"), audited.
- **Refund decisions.** `ops_decide_refund(p_actor, p_refund, p_decision approve|deny, p_reason, p_client_action_id)` changes status + `decided_by` + audit atomically, zone-checked on the order; reason required. The existing after-effects (Razorpay refund call, `createSettlementCorrection` when the order is in a paid settlement, `flagSettlementForRefund` for drafts, notifications) run after commit inside `decideRefund`, idempotently (each re-checks state; corrections are already unique per refund). An after-effect failure returns 502 `effect_failed` with the decision saved; retrying the same request is replay-safe.
- **Failed or delayed transaction rules** (constants exported from `finance-rules.ts` so Phase 8's alert engine reuses them):
  - `failed_payment` — `payments.status = 'failed'` in range.
  - `stuck_payment` — `payments.status in ('pending','authorized')` older than **30 min** on a non-cancelled order.
  - `refund_unsent` — approved refund on an online-paid order with `provider_refund_id is null` older than **24 h**.
  - `settlement_delayed` — a vendor with a delivered, unsettled order older than its cycle + grace (**weekly 7 + 3 = 10 days, monthly 31 + 3 = 34 days**).
  - `draft_stale` — a `draft` settlement older than **3 days**.
  - `approval_overdue` — a `payment_requests` row `pending_approval` older than **48 h**.
  - `rider_payout_delayed` — an unattached rider ledger row whose `effective_on`/`earned_at` is older than **35 days**.
- **Reconciliation states** (orders ↔ settlements), for delivered orders in range: `paid_matched` (in a `paid` settlement and the line's `contribution` equals `breakdownOrder` re-run with today's approved refunds, after outstanding/applied corrections); `paid_mismatch` (in a paid settlement, line ≠ recompute and no correction covers the difference); `correction_outstanding`; `in_draft`; `unsettled_due` (no line, older than cycle + grace); `unsettled_recent`. Online payments: `online_mismatch` when an online-paid order's `payments.amount_paise / 100 ≠ orders.total`. Cash: per rider per IST day, `collected` (Σ `deliveries.cod_collected_amount`), `deposited` (Σ `cod_handovers` leg `rider_to_manager` with `from_user` = rider), `pending = collected − deposited`, status `settled|pending|disputed` (disputed when an open `cash_disputes` row or a `disputed` deposit exists for that day); per manager per day, `received` vs `handed_on` (leg `manager_to_owner`).
- **Twelve reports + one.** The registry holds the twelve §13 kinds plus `finance-daily` (§7.8 "date-wise financial reports") and keeps the admin's `average-order`. Old admin kind ids stay valid as aliases: `earnings → commission`, `settlement → vendor-settlement`, `orders → orders`, `sales → sales`.
- **Finance-type report kinds** (`permission: "finance"`): `commission`, `vendor-settlement`, `rider-payout`, `refunds-adjustments`, `finance-daily`; `cash-reconciliation` is `"finance_or_cash"`; the rest are `"reports"`. In `"reports"` kinds, money columns that are finance figures (commission, payable) are **omitted from columns and rows** without `manager.finance.view`; sales columns stay (as the dashboard).
- **Marketing campaign report now** reads what exists: banners (window, `banner_events` impressions and clicks) and promotional coupons (redemptions, discount by `funded_by`, attributed sales = non-cancelled orders using the code). Phase 7 adds its `campaigns` table as a further source **inside the same builder** (`marketing` kind), so the report's columns are fixed here: `campaign, type, vendor, start, end, status, budget, fundedBy, impressions, clicks, redemptions, discountGiven, attributedOrders, attributedSales`. Sources that don't exist yet return no rows for that type; `budget` is null until Phase 7.
- **Export size.** Preview is paged (`page`, `pageSize` ≤ 200). Export calls `all=1`, capped at **10 000 rows** → 413 `too_large` with the row count, and the app asks for a narrower range. Totals are always computed over every row in the filter, never the page.

## API contract (pinned — both halves code to this)

All responses JSON. Errors `{ "error": "<code>", ...extra }`. Common query: `from`, `to` (`YYYY-MM-DD`, default last 30 IST days ending today), `zone` (uuid, optional). 400 `bad_range` (from > to, > 366 days, malformed).

### Shared shapes

```jsonc
// Money: whole rupees unless marked (2dp)
// FinanceFilters
{ "from": "2026-10-01", "to": "2026-10-21", "zone": { "id": "uuid", "name": "Bemetara" } /* or null = all my zones */ }
// SettlementSummary
{ "id": "uuid", "vendor": { "id": "uuid", "name": "Spice Hub" }, "zone": { "id": "uuid", "name": "Bemetara" },
  "kind": "batch|instant", "status": "draft|paid|void", "periodStart": "2026-10-01", "periodEnd": "2026-10-07",
  "orders": 42, "foodGross": 18450, "commission": 2768, "commissionGst": 498, "otherCharges": 0,
  "refundsRecovered": 120, "netPayable": 15064, "paymentRef": "UTR123…|null", "paidAt": "…|null",
  "paidBy": { "id": "uuid", "name": "…" } /* or null */, "createdAt": "…", "createdBy": { "id": "uuid", "name": "…" } /* or null */,
  "request": { "id": "uuid", "status": "pending_approval|approved|rejected|cancelled" } /* or null */ }
// SettlementLine
{ "orderId": "uuid", "orderCode": "AB12CD34", "placedAt": "…", "paymentMethod": "cod|online|null",
  "orderTotal": 520, "deliveryFee": 30, "foodGross": 450, "commission": 68, "commissionGst": 12,
  "otherCharges": 0, "refundRecovered": 0, "vendorNet": 370, "contribution": 370 }
// SettlementCorrection
{ "id": "uuid", "orderCode": "AB12CD34", "amount": 120, "reason": "…|null",
  "status": "outstanding|applied|voided", "originalSettlementId": "uuid", "appliedSettlementId": "uuid|null", "createdAt": "…" }
// VendorDue
{ "vendor": { "id": "uuid", "name": "Spice Hub" }, "zone": { "id": "uuid", "name": "Bemetara" }, "cycle": "weekly|monthly",
  "unsettledOrders": 18, "oldestUnsettledAt": "…|null", "payable": 6420, "recoverable": 0,
  "outstandingCorrections": 120, "lastPaidAt": "…|null", "delayed": false, "pendingRequestId": "uuid|null" }
// RiderDue
{ "rider": { "id": "uuid", "name": "Ravi Kumar", "code": "DR-0007|null" }, "unpaid": 12000.00 /* 2dp */,
  "oldestUnpaidOn": "2026-09-30|null", "lastPayout": { "amount": 12000.00, "paidOn": "2026-09-05", "reference": "UTR…|null" } /* or null */,
  "delayed": false, "pendingRequestId": "uuid|null" }
// FinanceIssue
{ "type": "failed_payment|stuck_payment|refund_unsent|settlement_delayed|draft_stale|approval_overdue|rider_payout_delayed",
  "severity": "warning|critical", "title": "Online payment failed", "detail": "BAD_REQUEST_ERROR: …|null",
  "amount": 520 /* or null; 2dp for rider */, "since": "…",
  "subject": { "kind": "order|vendor|settlement|refund|payment_request|rider", "id": "uuid", "label": "AB12CD34" },
  "reference": "pay_…|null" }
// RefundItem
{ "id": "uuid", "order": { "id": "uuid", "code": "AB12CD34", "total": 520, "paymentMethod": "cod|online|null", "placedAt": "…" },
  "vendor": { "id": "uuid", "name": "…" }, "amount": 120, "reason": "…|null", "origin": "customer|vendor_rejected|admin|system",
  "status": "pending|approved|denied", "requestedAt": "…", "decidedBy": { "id": "uuid", "name": "…" } /* or null */,
  "providerRefundId": "…|null", "settlementEffect": "none|draft_flagged|correction_created|null" }
// ReportColumn
{ "key": "netSales", "label": "Net sales", "labelHi": "शुद्ध बिक्री", "type": "text|int|money|money2|percent|date|datetime|minutes" }
// ReportPayload
{ "kind": "sales", "title": "Sales report", "subtitle": "What customers paid, day by day",
  "generatedAt": "2026-10-21T09:30:00Z", "generatedBy": { "id": "uuid", "name": "Asha Verma" },
  "filters": { "from": "2026-10-01", "to": "2026-10-21", "zone": { "id": "uuid", "name": "Bemetara" } /* or null */,
               "vendor": { "id": "uuid", "name": "…" } /* or null */, "rider": { "id": "uuid", "name": "…" } /* or null */,
               "status": "delivered|null", "payment": "all|cod|online" },
  "highlights": [{ "key": "netSales", "label": "Net sales", "labelHi": "…", "value": 152340, "type": "money" }],
  "columns": [ReportColumn], "rows": [{ "<key>": "string|number|null" }],
  "totals": { "<key>": "string|number|null" } /* or null */,
  "page": 1, "pageSize": 50, "totalRows": 312,
  "notes": ["Cancelled orders are excluded from net sales; see the Cancellation report."] }
```

### `GET /api/manager/finance/overview?from&to&zone`
200:
```jsonc
{ "filters": FinanceFilters, "generatedAt": "…",
  "sales": { "grossSales": 182340, "customerPaid": 201560, "netSales": 171220,
             "discounts": { "vendor": 4200, "platform": 6920, "total": 11120 },
             "refunds": { "total": 3450, "count": 7 },
             "adjustments": { "correctionsOutstanding": { "count": 1, "amount": 120 }, "correctionsApplied": { "count": 2, "amount": 340 } },
             "platformCommission": { "commission": 27350, "commissionGst": 4923, "otherCharges": 0, "total": 32273 },
             "deliveryFees": 9420, "riderEarnings": 48000.00, "vendorPayable": 61320, "vendorRecoverable": 0,
             "riderPayable": 24000.00, "cancelled": { "count": 12, "value": 5480 } },
  "payments": { "vendorDue": 61320, "vendorPaid": { "amount": 140220, "count": 9 },
                "riderDue": 24000.00, "riderPaid": { "amount": 48000.00, "count": 4 },
                "issues": { "warning": 3, "critical": 1 }, "pendingApprovals": 2 },
  "series": [{ "date": "2026-10-01", "customerPaid": 6420, "netSales": 5810, "commission": 870, "deliveryFees": 300, "refunds": 0 }] }
```
`vendorPaid` and `riderPaid` are paid within the range (`paid_at` / `paid_on`); `vendorDue`/`riderDue`/`vendorPayable`/`riderPayable` are as of now (not range-bound). `riderEarnings` = signed sum of ledger rows dated in range (salaried riders: the salary records).

### `GET /api/manager/finance/vendor-dues?zone&delayed=1&cursor` · `GET /api/manager/finance/rider-dues?zone&delayed=1&cursor`
200: `{ "items": [VendorDue] | [RiderDue], "nextCursor": "string|null", "totals": { "payable": 61320, "count": 14 } }` (rider totals 2dp).

### `GET /api/manager/finance/issues?type&from&to&zone&cursor`
200: `{ "items": [FinanceIssue], "nextCursor": "string|null", "counts": { "failed_payment": 1, "stuck_payment": 0, "refund_unsent": 0, "settlement_delayed": 2, "draft_stale": 0, "approval_overdue": 1, "rider_payout_delayed": 0 } }` (newest first; `from/to` apply to `failed_payment` only, the rest are current state).

### `GET /api/manager/finance/settlements?status=draft|paid|void|pending_approval&vendor&from&to&zone&cursor`
200: `{ "items": [SettlementSummary], "nextCursor": "string|null", "totals": { "netPayable": 140220, "count": 9 } }`. `from/to` filter `paid_at` for `paid`, `created_at` otherwise. `pending_approval` = drafts with a pending request.

### `GET /api/manager/finance/settlements/[id]`
200: `{ "settlement": SettlementSummary, "lines": [SettlementLine], "corrections": [SettlementCorrection], "request": PaymentRequest /* Phase 5 shape, or null */, "checks": { "stale": false, "freshNetPayable": 15064 } }`.

### `POST /api/manager/finance/settlements` (initiate)
`{ "clientActionId": "uuid", "vendorId": "uuid", "from": "2026-10-01", "to": "2026-10-07", "orderId": null, "method": "bank|upi|cash|other", "note": "…|null" }` (exactly one of `from/to` or `orderId`). 201 `{ "settlement": SettlementSummary, "request": PaymentRequest }`. Errors: 409 `nothing_to_pay`, `negative_net` (`{ "netPayable": -340 }`), `duplicate_pending`, `already_settled` (orderId), 404 `not_found`, 403 `permission_denied`.

### Decide (Phase 5 route, vendor branch filled in)
`POST /api/manager/payments/requests/[id]/decide` — body and errors exactly as Phase 5, plus 409 `stale_rebuilt` is **not** used: staleness surfaces as `amount_changed` (`{ "amount": 14944, "settlementId": "uuid" }` — the rebuilt draft). `PaymentRequest.kind = "vendor_settlement"` items carry `"settlementId": "uuid"` (new optional field, null for rider payouts).

### `GET /api/manager/finance/rider-payouts?from&to&rider&zone&cursor`
200: `{ "items": [Payout /* Phase 5 shape */ & { "rider": { "id": "uuid", "name": "…", "code": "…|null" } }], "nextCursor": "string|null", "totals": { "amount": 48000.00, "count": 4 } }` (by `paid_on`).

### `GET /api/manager/finance/refunds?status=pending|approved|denied&from&to&zone&cursor` · `POST /api/manager/finance/refunds/[id]/decide`
GET 200: `{ "items": [RefundItem], "nextCursor": "string|null", "counts": { "pending": 3 } }` (pending oldest first). POST `{ "clientActionId": "uuid", "decision": "approve|deny", "reason": "…" }` (3–300 chars) → 200 `{ "refund": RefundItem }`; 409 `already_decided`; 502 `effect_failed` (`{ "refundId": "uuid" }`, decision saved, retry the same request).

### `GET /api/manager/finance/reconciliation?section=orders|online|cash&from&to&zone&state&cursor`
200:
```jsonc
{ "section": "orders", "filters": FinanceFilters,
  "summary": { "paid_matched": 210, "paid_mismatch": 1, "correction_outstanding": 1, "in_draft": 12, "unsettled_due": 3, "unsettled_recent": 40 },
  "items": [{ "orderId": "uuid", "orderCode": "AB12CD34", "vendor": { "id": "uuid", "name": "…" }, "deliveredAt": "…",
              "state": "paid_mismatch", "expected": 370, "settled": 490, "difference": -120,
              "settlementId": "uuid|null", "correctionId": "uuid|null" }],
  "nextCursor": "string|null" }
// section=online: summary { "matched": 88, "online_mismatch": 1, "missing_payment": 0 }; items { orderId, orderCode, orderTotal, paidAmount, paymentId, state }
// section=cash: summary { "collected": 48200, "deposited": 46000, "pending": 2200, "disputedDays": 1 };
//   items { "day": "2026-10-20", "rider": { "id", "name", "code" }, "collected": 2400, "deposited": 2400, "pending": 0, "status": "settled|pending|disputed", "depositIds": ["uuid"] }
//   plus "managers": [{ "manager": { "id", "name" }, "day": "2026-10-20", "received": 9400, "handedOn": 9000, "pending": 400 }]
```
`state=` filters items. `section=cash` needs `finance.view` or `manager.cash`.

### `GET /api/manager/reports/kinds`
200: `{ "kinds": [{ "kind": "sales", "label": "Sales report", "labelHi": "बिक्री रिपोर्ट", "blurb": "…", "filters": ["vendor","zone","payment"], "statusOptions": [] }] }` — only kinds the caller may run, in registry order.

### `GET /api/manager/reports?kind&from&to&zone&vendor&rider&status&payment&page&pageSize&all=1`
200: `ReportPayload`. Errors: 400 `bad_kind` | `bad_range` | `bad_filter` (a filter the kind doesn't take); 403 `permission_denied`; 413 `too_large` (`{ "rows": 18420, "max": 10000 }`).

### Report registry — kinds, filters, columns (pinned)

| kind | permission | filters | rows (one per) | columns (keys) |
|---|---|---|---|---|
| `sales` | reports | vendor, zone, payment | IST day | `date, orders, customerPaid, grossSales, discounts, refunds, netSales, deliveryFees, aov` |
| `orders` | reports | vendor, rider, status, zone, payment | order | `code, placedAt, vendor, rider, status, paymentMethod, paymentStatus, items, total, discount, deliveryFee, cancelledBy, cancellationReason` |
| `vendor-performance` | reports | vendor, zone | vendor | `vendor, zone, orders, delivered, cancelled, cancellationRate, rejectionRate, avgAcceptMinutes, avgPrepMinutes, customerPaid, netSales, aov, rating, ratingCount` (+ `commission, payable` with finance.view) |
| `rider-performance` | reports | rider, zone | rider | `rider, code, delivered, failed, failedRate, acceptanceRate, avgDeliverMinutes, onlineHours, rating, ratingCount, codCollected` |
| `commission` | finance | vendor, zone | vendor | `vendor, orders, foodGross, commission, commissionGst, otherCharges, platformTotal, vendorNet` |
| `vendor-settlement` | finance | vendor, status (`draft,paid,void`), zone | settlement | `vendor, kind, status, periodStart, periodEnd, orders, foodGross, commission, refundsRecovered, netPayable, paymentRef, paidAt, paidBy` |
| `rider-payout` | finance | rider, zone | payout | `rider, code, periodEnd, amount, method, reference, paidOn, approvedBy, requestedBy` |
| `cancellation` | reports | vendor, zone, status (`customer,vendor,admin,manager,system` = cancelled_by) | cancelled order | `code, placedAt, cancelledAt, vendor, cancelledBy, reason, value, refunded` |
| `refunds-adjustments` | finance | vendor, zone, status (`pending,approved,denied`) | refund or correction | `date, type (refund/correction), orderCode, vendor, amount, status, origin, reason, settlementEffect, decidedBy` |
| `marketing` | reports | vendor, zone | campaign / banner / promo code | `campaign, type, vendor, start, end, status, budget, fundedBy, impressions, clicks, redemptions, discountGiven, attributedOrders, attributedSales` |
| `support-tickets` | reports | zone, status (`open,in_progress,waiting_on_requester,escalated,resolved,closed`) | ticket | `number, createdAt, requesterRole, category, priority, status, escalationLevel, assignedTo, firstResponseMinutes, resolutionMinutes, orderCode, vendor` (highlights: count, avg first response, avg resolution, top categories) |
| `cash-reconciliation` | finance_or_cash | rider, zone | rider × IST day | `date, rider, code, codOrders, collected, deposited, pending, status` |
| `finance-daily` | finance | vendor, zone | IST day | `date, customerPaid, grossSales, discountsVendor, discountsPlatform, refunds, netSales, deliveryFees, commission, commissionGst, vendorPaidOut, riderPaidOut` |
| `average-order` | reports | vendor, zone, payment | IST day | `date, orders, aov` (admin parity, kept) |

Totals row: sums of money/int columns, rates recomputed from summed numerators/denominators (never averaged averages), minutes as weighted means. Notes: `sales` and `finance-daily` always carry the cancelled-separate note; `refunds-adjustments` carries "Each refund appears once; a correction recovers a refund from a paid vendor and is not a second refund."

## Requirement coverage

| Spec item | Tasks |
|---|---|
| §7 Sales 1 gross sales · 2 net sales · 3 platform commission | S3, S4 (`overview.sales`), A2 |
| §7 Sales 4 vendor- and Deligro-funded discounts | S4 (`discounts.vendor/platform`), A2 |
| §7 Sales 5 refunds and adjustments | S4 (`refunds`, `adjustments`), S5 refunds, A2, A4 |
| §7 Sales 6 delivery fees collected | S4, A2 |
| §7 Sales 7 rider delivery earnings · 9 rider earnings payable | S4 (ledger sums), A2, A3 |
| §7 Sales 8 vendor earnings payable | S4 (`vendorPayable`), A2, A3 |
| §7 Tracking 1–2 vendor payments due / completed | S4 vendor-dues, S5 settlements, A3 |
| §7 Tracking 3–4 rider payouts due / completed | S4 rider-dues, rider-payouts, A3 |
| §7 Tracking 5 failed or delayed transactions | S3 rules, S4 issues, A3 |
| §7 Tracking 6 settlement history · 7 transaction references | S5 list/detail (`paymentRef`, payout `reference`), A3 |
| §7 Tracking 8 date-wise financial reports | S7 `finance-daily`, A2 export, A6 |
| §7 Tracking 9 reconciliation | S3, S6, A5 |
| §7 permission rule (initiate/approve only with permissions; RBAC on execution and adjustments) | S2 RPCs, S5, A4 |
| §13 reports 1–12 | S7 (registry rows above), A6 |
| §13 date range · vendor/rider/status/zone filters | S7 (`filters` per kind), A6 |
| §13 export CSV/Excel and PDF · generation date | A6 (generic exporter, `generatedAt`/`generatedBy`/filters line) |
| §13 consistent calculations across dashboards and reports | S7 parity tests, I1 |
| §13 cancelled separate from net sales · no double-counting refunds | S3/S7 tests, report notes |
| §18.4 dashboard = reports = finance | S7, I1 |

## Review Focus

1. **Self-approval and stale drafts** — the initiator approves their own settlement request → 403 `same_person`; a refund is approved between initiate and approve → approval answers `amount_changed` with the rebuilt draft's amount, the old draft is `void`, and no settlement is ever marked paid at a stale amount. (S2 PGlite, S5 QA.)
2. **Figures disagreeing** — for the same fixture rows, `overview.sales.netSales` = `sales` report total `netSales` = Phase 2 dashboard net figure; `commission` report `platformTotal` total = `overview.sales.platformCommission.total`; refunds appear once in `refunds-adjustments` even when the order spans the range edge. (S7 parity test.)
3. **Zone leakage through money joins** — a zone-A manager requesting a zone-B settlement id, refund id, payout or `vendor=` filter gets 404/empty; settlement lines are reached only through an in-scope restaurant. (S1 PGlite, S4–S7 QA.)
4. **Finance hidden without permission** — a manager with `reports.view` but not `finance.view`: `/reports/kinds` omits finance kinds, a direct `kind=commission` call → 403, `vendor-performance` rows carry no `commission`/`payable` keys, `/finance/*` → 403. (S7 QA, A6 test.)
5. **Huge exports and empty ranges** — `all=1` over a year with > 10 000 rows → 413 with the count and the app shows "Narrow the range"; an empty range returns `rows: []`, `totals` with zeros and the app's `Empty` line, never a crash or "NaN%". (S7 QA, A6 test.)

---

### Task P0: Ready the branch (in `F:\hub26\deligro-manager`)

- [ ] **Step 1:** Confirm Phase 5 is integrated: `supabase/migrations/0152_*.sql` present, `src/lib/data-access/payment-requests.ts` exports `decidePaymentRequest`. If not, stop and finish Phase 5 first.
- [ ] **Step 2:** `git merge feat/vendor-app` and `git merge feat/rider-app` if either has new commits; diff every function they re-declare against 0141–0154 copies (`guard_order_update`, `lock_restaurant_privileged_fields`, `record_rider_payout`, settlement functions) and reconcile in the later migration, keeping all behaviour; re-run every `scripts/qa/sql/migration-*.mjs`. Commit the merge and any reconciliation separately.
- [ ] **Step 3:** Copy `.env.local` and `apps/manager/env/*.json` (gitignored) into both new worktrees after creating them: `git worktree add -b feat/manager-p6-server F:/hub26/deligro-manager-p6s HEAD`, same for `p6a`.

## P0 result (2026-10-22)

- [x] Step 1 — Phase 5 is integrated (`0152_payment_requests_cash_exceptions.sql`, `payment_requests`, `ops_request_rider_payout` / `ops_decide_payment_request`).
- [x] Step 2 — `feat/vendor-app`: nothing new. `feat/rider-app` merged (`0f3c336`): Rider **0083** (rate card, `rider_earnings` + trigger, incentive rules/awards, `rider_adjustments`, `rider_payouts`, `guard_rider_ledger`, `record_rider_payout`), the delivery flow (proof photos, vendor handover, `guard_delivery_insert`, `guard_delivery_exception_update`) and its own exception decisions. 0084–0086 have **not** landed (ratings, cash deposits, documents stay in our 0150 with their planned shapes).
  - Merge resolutions: one `delivery-exceptions.ts` (the Rider module as base; decisions through 0152's audited RPC; `opts.clientActionId` makes a retry after `effect_failed` finish only what is unfinished); one `decideExceptionAction` (manager switch + derived idempotency key; web "Finish it"); `cancelOrderAsOps` keeps our audited `ops_cancel_order` core and returns the Rider branch's `CancelOpsResult`; `notifyOps` takes `PushOptions` + `zoneId`, exception pushes English-only and zone-scoped; pnpm lockfile gains `qrcode`.
  - Reconciliation commits: `baeb81c` proofs run on the real 0083 and seed past states as 0082 allows (correction_reason fixtures; IST "today" in 0154's proof); `8781371` 0150 no longer re-declares 0083's ledger (0084–0086 only; `rider_documents` by column, never `number`); `4e00d5a` 0152's preview and `_record_rider_payout` are 0083's arithmetic (IST cutoff, awards dated by their triggering earning, advisory lock, null checks), `record_rider_payout` is **revoked from everyone** — admins pay riders through `payment_requests`; `d5ce166` 0152's exception RPC enforces the live check (`moved_on`) and the photo rule (`photo_required`) under row lock; `df6e188` exception queues scoped by the **order's** zone (`order_zone_id` on 0153's view); `1048d32` order 0061 → 0063 → 0081 → 0082 → **0083** → 0141 → 0142+ documented and checked (0083 applied after 0152 would re-grant the one-person payout — caught); `51dd322` three stale QA source pins repointed.
  - Re-declared objects re-diffed: `guard_order_update`, `log_delivery_event`, the `delivery_exceptions — read` policy unchanged by this merge (Phase 5 P0 state holds); `guard_delivery_insert` / `guard_delivery_exception_update` are not re-declared by 0141–0154.
- [x] Verification: all 22 SQL proofs (0055 … 0154 + order: 31) pass; 86/93 QA scripts pass under one runner, the rest pass under their own `npm run test:*` flags except `idor-suite` (needs `QA_PASSWORD`); `tsc` clean; eslint clean on touched files; `flutter analyze` clean, `flutter test` 379 passed; `next build` passes (52 static pages).
- [x] Step 3 — worktrees `deligro-manager-p6s` / `-p6a` created from the P0 HEAD (see the P0 report).

**For Part S (decision needed from the coordinator before S2):** rider payouts no longer have an admin-alone path (`record_rider_payout` is revoked). This plan's `ops_mark_settlement_paid` (admin pays a vendor settlement directly, audited, no second approver — "Claude's calls") is now the only one-person money path. Either keep it as the plan says, or route admin vendor payments through `payment_requests` too (admin approves someone else's request, never their own) for the same reason riders' were.

**For Part S (the ledger):** read rider money from 0083's tables as landed — `rider_earnings.distance_source`, the `rider_earnings_amount_adds_up` check, `payout_id … on delete restrict`, `guard_rider_ledger` (paid rows immutable; only attaching `payout_id` is allowed). Rider dues = `_rider_payout_preview(driver, period_end)`; a payout is only ever `ops_request_rider_payout` → `ops_decide_payment_request`.

# Part S — server (worktree `deligro-manager-p6s`)

### Task S1: Migration 0155 — zone-scoped finance reads and report indexes

**Files:** Create `supabase/migrations/0155_manager_finance_reads.sql`, `scripts/qa/sql/migration-0155.mjs`; Modify `docs/DATABASE.md`.

**Interfaces — Produces (database):**
- Helper `manager_can_see_restaurant(p_restaurant uuid) returns boolean` (stable, security definer: admin, or manager and the restaurant's `zone_id` is in their `staff_zones`); reuse Phase 4's if it already defines one with this meaning (check 0145 first; don't duplicate).
- Select policies (permissive, additive): `vendor_settlements — manager read` (`manager_can_see_restaurant(restaurant_id)`), `vendor_settlement_orders — manager read` (its settlement's restaurant), `settlement_corrections — manager read` (`manager_can_see_restaurant(restaurant_id)`), `refunds — manager read` (order `manager_can_see_zone(zone_id)`), `payments — manager read` (order's zone). No manager write policies on any of them.
- Indexes (`if not exists`): `orders (zone_id, created_at)`, `refunds (order_id)`, `refunds (status, created_at)`, `payments (status, created_at)`, `vendor_settlements (restaurant_id, status, paid_at)`, `cod_handovers (zone_id, handover_date)`, `deliveries (driver_id, cod_collected_at)`, `payment_requests (status, requested_at)`.

- [ ] **Step 1: Write `migration-0155.mjs`** (preamble from 0141's proof; stub `auth.uid()` per role): zone-A manager reads zone-A shop's settlement, its lines and corrections; reads 0 rows of zone-B's; reads refunds and payments of zone-A orders only; manager `update vendor_settlements set notes='x'` → 0 rows / permission error; manager with no zones reads nothing; admin reads all; customer reads nothing new.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration** (header in house style, rollback block). **Step 4: Run every SQL proof — PASS.**
- [ ] **Step 5: Commit** `feat(db): 0155 zone-scoped manager reads on settlements, refunds, payments; report indexes`.

### Task S2: Migration 0156 — vendor-settlement maker–checker and audited money decisions

**Files:** Create `supabase/migrations/0156_settlement_requests_and_money_decisions.sql`, `scripts/qa/sql/migration-0156.mjs`; Modify `docs/DATABASE.md`.

**Interfaces — Produces (database):**
- `payment_requests.settlement_id uuid references vendor_settlements` (add if not exists); check: `kind = 'vendor_settlement'` ⇔ `settlement_id is not null`.
- `ops_request_vendor_settlement(p_actor uuid, p_settlement uuid, p_method text, p_note text, p_client_action_id text) returns jsonb` — `ops_require_staff` on the restaurant's zone; settlement must be `draft` and `created_by = p_actor`; `net_payable > 0` else `negative_net` / `nothing_to_pay`; `duplicate_pending` per restaurant; inserts the request (`amount = net_payable`, `subject_id = restaurant_id`, `zone_id`); action `payment.request` with the settlement snapshot.
- Re-declare `ops_decide_payment_request` keeping the rider branch verbatim and filling `vendor_settlement`: approve → `same_person`, `reference_required`, lock the settlement row, require `status = 'draft'`, compare `net_payable` to the request `amount` (stale-check inputs come from the route: `p_confirm_amount` must equal the current draft `net_payable` when they differ → else `amount_changed` with the draft's `net_payable`), `net_payable < 0` → `negative_net`; update settlement `status='paid', paid_at=now(), paid_by=p_actor, payment_ref=p_reference`; request `approved`, `result_id = settlement id`; reject/cancel → settlement `status='void', voided_at, voided_by` (deleting its lines exactly as `voidSettlement` does, so orders can be resettled) and request `rejected|cancelled`; audit `payment.approve|reject|cancel` with before/after.
- `ops_repoint_settlement_request(p_actor, p_request, p_new_settlement, p_client_action_id)` — service path for the rebuild: old draft voided, request `settlement_id` and `amount` updated, audit `payment.repoint`.
- `ops_mark_settlement_paid(p_actor, p_settlement, p_reference, p_client_action_id)` (admin only — `is_admin` of `p_actor`), `ops_void_settlement(p_actor, p_settlement, p_reason, p_client_action_id)` (admin, or the requester's own draft through cancel above) — the bodies `markSettlementPaid` / `voidSettlement` run today, plus audit.
- `ops_decide_refund(p_actor, p_refund, p_decision text, p_reason text, p_client_action_id) returns jsonb` — `ops_require_staff` on the order's zone; refund must be `pending` else `already_decided`; reason 3–300 chars; sets `status`, `decided_by`, `decided_at` (add column if not exists); audit `refund.approve|deny`; returns `{ refund_id, order_id, status }`.
- All: `revoke execute … from public, anon, authenticated; grant execute … to service_role`; replay-safe on `p_client_action_id`.

- [ ] **Step 1: Write `migration-0156.mjs`:** manager M1 (initiate) requests a draft of zone-A shop (net 15064) → pending, amount 15064; second request same shop → `duplicate_pending`; M1 approves → `same_person`; direct service-role `update payment_requests set decided_by = requested_by` → check violation; M2 approves without reference → `reference_required`; M2 approves with `UTR1` → settlement `paid`, `paid_by = M2`, `payment_ref = 'UTR1'`, request approved, one audit row; replay → same result; a request whose draft `net_payable` was changed to 14944 → approve without confirm → `amount_changed` 14944, with `p_confirm_amount 14944` → paid at 14944; reject without note → `note_required`; reject → settlement `void`, its lines deleted, audit row; zone-B manager decides → `forbidden`; `ops_decide_refund` approve → status approved, `decided_by`, audit; second decision → `already_decided`; deny without reason → `reason_required`; manager calling `ops_mark_settlement_paid` → `forbidden`; `update vendor_settlements set net_payable = 1 where status = 'paid'` via any RPC path is impossible (no RPC exposes it — assert no function in this migration updates a paid row's amounts).
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration. Step 4: Run every SQL proof — PASS.**
- [ ] **Step 5: Commit** `feat(db): 0156 maker–checker vendor settlements, audited settlement and refund decisions`.

### Task S3: Finance rules (pure)

**Files:** Create `src/lib/ops/finance-rules.ts`, `scripts/qa/manager-finance-rules.ts` (add `"test:manager-finance-rules"`).

**Interfaces — Produces:**
```ts
export const FINANCE_THRESHOLDS: { stuckPaymentMinutes: 30; refundUnsentHours: 24; settlementGraceDays: 3; cycleDays: { weekly: 7; monthly: 31 }; draftStaleDays: 3; approvalOverdueHours: 48; riderPayoutDelayDays: 35 };
export type FinanceIssueType = "failed_payment" | "stuck_payment" | "refund_unsent" | "settlement_delayed" | "draft_stale" | "approval_overdue" | "rider_payout_delayed";
export function issueSeverity(type: FinanceIssueType, ageHours: number): "warning" | "critical";   // critical: failed_payment, settlement_delayed > 2× threshold, approval_overdue > 96 h, rider_payout_delayed > 45 d
export function isSettlementDelayed(cycle: "weekly" | "monthly", oldestUnsettledAt: Date | null, now: Date): boolean;
export function classifyOrderReconciliation(input: { delivered: boolean; deliveredAt: Date; cycle: "weekly" | "monthly"; line: { settlementStatus: "draft" | "paid"; contribution: number } | null; expectedContribution: number; outstandingCorrection: number; appliedCorrection: number; now: Date }): { state: "paid_matched" | "paid_mismatch" | "correction_outstanding" | "in_draft" | "unsettled_due" | "unsettled_recent"; difference: number };
export function classifyOnlinePayment(orderTotal: number, paidPaise: number | null): "matched" | "online_mismatch" | "missing_payment";
export function cashDayStatus(collected: number, deposited: number, disputed: boolean): "settled" | "pending" | "disputed";
export function riderLedgerTotals(rows: { type: string; amount: number; date: string; payoutId: string | null }[], range?: { from: string; to: string }): { earnedInRange: number; unpaid: number; oldestUnpaidOn: string | null };  // signs via src/lib/rider/figures.ts
```
- [ ] **Step 1: Write the QA script:** stuck at 29 min → not an issue, 31 min → `stuck_payment`; weekly cycle oldest unsettled 9 d → not delayed, 11 d → delayed; monthly 33 d / 35 d; reconciliation — paid line 370 with expected 370 → `paid_matched`; expected 250 (refund 120 after payout) with outstanding correction 120 → `correction_outstanding`; with no correction → `paid_mismatch` difference −120; applied correction 120 → `paid_matched`; draft line → `in_draft`; no line, weekly, delivered 12 d ago → `unsettled_due`, 2 d → `unsettled_recent`; online 520 vs 52000 paise → matched, 51900 → mismatch, null → missing; cash 2400/2400 → settled, 2400/2000 → pending, disputed flag wins; ledger: salary 12000 + bonus 500 − deduction 200 with one 12000 row attached to a payout → `unpaid = 300`; range excludes rows outside.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`.**
- [ ] **Step 5: Commit** `feat(ops): finance rules — delays, reconciliation states, ledger totals`.

### Task S4: Finance overview, dues, issues, rider payouts — data layer and routes

**Files:**
- Create: `src/lib/ops/finance-contract.ts` (types for every pinned shape + serialisers), `src/lib/data-access/manager-finance.ts`, routes `src/app/api/manager/finance/overview/route.ts`, `…/vendor-dues/route.ts`, `…/rider-dues/route.ts`, `…/issues/route.ts`, `…/rider-payouts/route.ts`, `scripts/qa/manager-finance.ts` (add `"test:manager-finance"`).
- Modify: `src/lib/data-access/ops-metrics.ts` — add `loadSettlementLines(scope, opts)`, `loadCorrections(scope, opts)`, `loadPayments(scope, opts)`, `loadRiderLedger(scope, opts)`, `loadVendorCycles(restaurantIds)` (all scope-filtered, paged reads via `read-all.ts`).
- Modify: `src/lib/data-access/admin-settlements.ts` — split `listVendorSettlementQueue()` into `vendorSettlementQueueFor(scope: ManagerScope)` + the admin wrapper (unchanged output).

**Interfaces — Produces:**
```ts
export async function getFinanceOverview(scope: ManagerScope, q: { range: DateRange }): Promise<FinanceOverview>;
export async function listVendorDues(scope: ManagerScope, q: { delayedOnly: boolean; cursor?: string }): Promise<Page<VendorDue> & { totals: { payable: number; count: number } }>;
export async function listRiderDues(scope: ManagerScope, q: { delayedOnly: boolean; cursor?: string }): Promise<Page<RiderDue> & { totals: { payable: number; count: number } }>;
export async function listFinanceIssues(scope: ManagerScope, q: { type?: FinanceIssueType; range: DateRange; cursor?: string }): Promise<Page<FinanceIssue> & { counts: Record<FinanceIssueType, number> }>;
export async function listRiderPayouts(scope: ManagerScope, q: { range: DateRange; riderId?: string; cursor?: string }): Promise<Page<PayoutWithRider> & { totals: { amount: number; count: number } }>;
```
`getFinanceOverview` computes `sales` with `salesSummary`, `discountsByFunder`, `approvedRefunds`, `platformCommission`, `vendorEarnings`, `deliveryFees`, `cancelledSummary` from `src/lib/metrics` over `loadMetricOrders(scope, { range, withItems: true })`; `vendorPaid` with `vendorPaymentsCompleted`; rider figures with `riderLedgerTotals`.

- [ ] **Step 1: Write `manager-finance.ts`:** pure — serialisers on fixed rows produce exactly the pinned keys (snapshot of key sets); overview from a fixture equals hand-computed figures (gross 450+300, discounts split vendor/platform, refund once although listed twice, cancelled excluded from net, commission via `breakdownOrder`); `riderPayable` 2dp; structural — every route calls `managerApiContext("manager.finance.view")` first and every loader call passes the scope; zone-B `vendor=` id → empty. Live (skip when no server/credentials): unauthenticated → 401; manager without `finance.view` → 403.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:metrics`; admin settlements page renders the same queue (`npm run test:platform`).**
- [ ] **Step 5: Commit** `feat(api): manager finance overview, dues, issues and rider payouts`.

### Task S5: Settlements, maker–checker initiation, refunds — routes; admin paths on the audited RPCs

**Files:**
- Create: routes `src/app/api/manager/finance/settlements/route.ts` (GET, POST), `…/settlements/[id]/route.ts`, `…/refunds/route.ts`, `…/refunds/[id]/decide/route.ts`; `scripts/qa/manager-settlements.ts` (add `"test:manager-settlements"`).
- Modify: `src/lib/data-access/admin-settlements.ts` — `listSettlements`, `getSettlement` gain scope-taking variants (`listSettlementsFor(scope, q)`, `getSettlementFor(scope, id)`); `createSettlementDraft` gains optional `orderId` (instant draft, same arithmetic) and `createdBy` (manager or admin); `markSettlementPaid` / `voidSettlement` call `ops_mark_settlement_paid` / `ops_void_settlement` (signatures unchanged).
- Modify: `src/lib/data-access/payment-requests.ts` — `createVendorSettlementRequest(ctx, body)`, and `decidePaymentRequest` handles `vendor_settlement`: on approve, run the staleness check (`markSettlementPaid`'s refund comparison, extracted as `isDraftStale(settlementId): Promise<{ stale: boolean; freshNet: number }>`); if stale → void + rebuild with `createSettlementDraft` for the same period/order + `ops_repoint_settlement_request` → 409 `amount_changed` `{ amount, settlementId }`; else call the RPC. Serialise `PaymentRequest.settlementId`.
- Modify: `src/lib/data-access/refunds.ts` — `decideRefund(actor: { id: string; role: "admin" | "manager" }, id, decision, reason)` calls `ops_decide_refund`, then runs today's after-effects idempotently; the admin Server Action passes the admin actor and a reason (admin refunds UI gains a required reason field); add `listRefundsFor(scope, q)`.
- Modify: `src/lib/notifications/order-events.ts` — `notifyPaymentRequested` / `notifyPaymentDecided` cover `vendor_settlement` (push the vendor "Payout of ₹X sent, ref …" on approval).

- [ ] **Step 1: Write `manager-settlements.ts`:** pure — initiate body validation (both period and orderId → 400; neither → 400; `to` before `from` → `bad_range`); `amount_changed` mapping carries `settlementId`; refund reason length; structural — POST settlements requires `initiate_payment`, refund decide requires `finance.adjust`, approve path never calls `markSettlementPaid` for a manager, `decideRefund` no longer updates `refunds.status` directly, admin `markSettlementPaid` calls the RPC; zone — `getSettlementFor` on a zone-B id → null (404). Live (skip as before): initiate → approve as same QA manager → 403 `same_person`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`; `npm run test:manager-payments` (Phase 5) still PASS; `next build`; SECURITY_AUDIT log row (financial RPCs, maker–checker for settlements, refund decisions by managers).**
- [ ] **Step 5: Commit** `feat(api): maker–checker vendor settlements and audited refund decisions for managers`.

### Task S6: Reconciliation

**Files:** Create `src/app/api/manager/finance/reconciliation/route.ts`; Modify `src/lib/data-access/manager-finance.ts` (`getReconciliation`); test `scripts/qa/manager-reconciliation.ts` (add `"test:manager-reconciliation"`).

**Interfaces — Produces:**
```ts
export async function getReconciliation(scope: ManagerScope, q: { section: "orders" | "online" | "cash"; range: DateRange; state?: string; cursor?: string }): Promise<ReconciliationPayload>;
```
Orders section: every delivered order in range with its line (if any), expected contribution from `breakdownOrder` with current approved refunds, corrections by order → `classifyOrderReconciliation`. Cash section: `deliveries.cod_collected_amount` grouped by rider × IST day of `cod_collected_at`, `cod_handovers` by `from_user` × `handover_date`, disputes/deposits flags; managers from both legs. Permission: `orders`/`online` need `finance.view`; `cash` needs `finance.view` or `manager.cash`.

- [ ] **Step 1: Write the QA script:** fixture of 6 delivered orders hitting each state, summary counts match items; `state=paid_mismatch` returns only that item with difference −120; online section mismatch detection; cash: rider collected 2400 on 20 Oct (IST, an 23:50 IST collection counted on the 20th), deposited 2000 → pending 400; manager received 9400, handed on 9000 → pending 400; a manager with `manager.cash` but not `finance.view` gets `section=cash` 200 and `section=orders` 403.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`.**
- [ ] **Step 5: Commit** `feat(api): finance reconciliation — orders to settlements, online payments, cash to deposits`.

### Task S7: Report registry, the twelve reports, admin Reports on the registry

**Files:**
- Create: `src/lib/reports/registry.ts` (definitions + `runReport`), `src/lib/reports/builders/{sales,orders,vendor-performance,rider-performance,commission,vendor-settlement,rider-payout,cancellation,refunds-adjustments,marketing,support-tickets,cash-reconciliation,finance-daily,average-order}.ts`, `src/lib/reports/payload.ts` (`ReportPayload`, `ReportColumn`, paging, totals helpers), routes `src/app/api/manager/reports/route.ts`, `src/app/api/manager/reports/kinds/route.ts`, `scripts/qa/manager-reports.ts` (add `"test:manager-reports"`).
- Modify: `src/lib/reports/kinds.ts` — `ReportKind` becomes the registry's kind union; `REPORT_KINDS` is derived from the registry (aliases `earnings`, `settlement` resolved by `resolveKind`).
- Modify: `src/app/admin/reports/{page,report-filters,report-export}.tsx` — render any `ReportPayload` (columns typed, highlights, totals, notes, chart from the payload's daily rows when the kind is day-based), filters shown per `def.filters`; `src/lib/data-access/admin-reports.ts` — `buildReport` becomes a thin adapter over `runReport({ scope: { all: true }, … })` and the duplicate arithmetic in it is deleted.

**Interfaces — Produces:**
```ts
export type ReportPermission = "reports" | "finance" | "finance_or_cash";
export interface ReportDefinition { kind: ReportKindId; label: string; labelHi: string; blurb: string; filters: ("vendor" | "rider" | "status" | "zone" | "payment")[]; statusOptions: { value: string; label: string; labelHi: string }[]; permission: ReportPermission; dayBased: boolean; build(ctx: ReportBuildContext): Promise<ReportBuildResult> }
export interface ReportBuildContext { scope: ManagerScope; range: DateRange; vendorId?: string; riderId?: string; status?: string; payment?: "all" | "cod" | "online"; canSeeFinance: boolean }
export interface ReportBuildResult { columns: ReportColumn[]; rows: ReportRow[]; totals: ReportRow | null; highlights: ReportHighlight[]; notes: string[] }
export const REPORTS: readonly ReportDefinition[];
export function resolveKind(raw: string): ReportKindId | null;
export function permittedKinds(perms: Record<string, boolean>, isAdmin: boolean): ReportDefinition[];
export async function runReport(input: ReportBuildContext & { kind: ReportKindId; page: number; pageSize: number; all: boolean; generatedBy: { id: string; name: string } }): Promise<ReportPayload | { error: "too_large"; rows: number }>;
```
Builders use only `src/lib/metrics`, `breakdownOrder`/`sumSettlementTotals`, `vendorRates` (Phase 4), `getRiderPerformance`/`src/lib/rider/figures.ts` (Phase 5), `finance-rules.ts`, and the Phase 2/S4 loaders. Marketing: banners + `banner_events` + coupons/`coupon_redemptions`, structured as `sources: MarketingSource[]` so Phase 7 appends `campaigns`. Support: `support_tickets` (0143) — first response from `first_response_at`, resolution from `resolved_at`.

- [ ] **Step 1: Write `manager-reports.ts`:**
  - Registry: exactly the 14 kinds above, each kind's `filters` and column keys equal the pinned table; `resolveKind("earnings") === "commission"`, `resolveKind("settlement") === "vendor-settlement"`, `resolveKind("x") === null`.
  - Permissions: `permittedKinds({ "manager.reports.view": true })` excludes the five finance kinds and `cash-reconciliation`; with `manager.cash` includes `cash-reconciliation`; admin gets all 14; `vendor-performance` without finance has no `commission`/`payable` column or row key.
  - **Parity (§18.4)** on one fixture set (orders across two IST days incl. a 23:50 IST order, a cancelled order, a refund listed twice, vendor- and platform-funded discounts, a paid settlement): `sales` totals `customerPaid`/`netSales`/`refunds` = `computeDashboard` and `getFinanceOverview` figures; `commission` totals `platformTotal` = overview `platformCommission.total`; `finance-daily` per-day rows sum to its totals and to `sales`; `cancellation` count/value = `cancelledSummary`; `refunds-adjustments` lists the refund once and the correction separately; `vendor-settlement` totals `netPayable` = sum of settlement headers.
  - Paging: `pageSize 2` returns 2 rows with `totalRows` = all and totals over all; `all=1` with 10 001 synthetic rows → `too_large` 10 001.
  - Empty range → `rows: []`, totals with zeros, rates `null` (not NaN).
  - Admin: `buildReport({ kind: "sales", … })` returns the same figures as `runReport` for scope all.
- [ ] **Step 2: Run — FAIL. Step 3: Implement registry, builders, routes, admin page. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:platform`; `next build`; open `/admin/reports` for each kind in `next dev` and check it renders (screenshot two).**
- [ ] **Step 5: Commit** `feat(reports): one registry for the twelve reports — manager API and admin Reports`.

# Part A — app (worktree `deligro-manager-p6a`)

### Task A1: Models, repositories, fixtures

**Files:** Create `apps/manager/lib/models/{finance,settlement,report}.dart`, `apps/manager/lib/data/{finance_repository,reports_repository}.dart`, `apps/manager/test/fixtures/phase6/*.json` (one per pinned response, including an overview for a manager without rider ledger rows, a settlement detail with a pending request, every `FinanceIssue.type`, every reconciliation section, a `ReportPayload` with null cells and a totals row, `kinds` without finance kinds), `apps/manager/test/fakes/fake_finance_repository.dart`, `apps/manager/test/finance_models_test.dart`.
**Interfaces — Produces:** `FinanceRepository` methods one-to-one with the S4–S6 endpoints (`overview`, `vendorDues`, `riderDues`, `issues`, `riderPayouts`, `settlements`, `settlement`, `initiateSettlement`, `refunds`, `decideRefund`, `reconciliation`); `ReportsRepository.kinds()`, `ReportsRepository.run(ReportQuery q, {bool all = false})`; `Money` parsing keeps rider 2dp values as `double` and order money as `int`; `PaymentRequest` (Phase 5 model) gains nullable `settlementId`.
- [ ] **Step 1: Test:** every fixture parses; unknown enum values map to an `unknown` case rather than throwing; a missing finance block parses as null.
- [ ] **Step 2–4: FAIL → implement → PASS (`flutter test`), `flutter analyze` clean. Step 5: Commit** `feat(manager-app): finance and report models, repositories, fixtures`.

### Task A2: Finance tab — overview

**Files:** Create `apps/manager/lib/features/finance/{finance_screen,finance_overview,finance_figures}.dart`; Modify router (`/finance` replaces the placeholder), `nav.dart` (tab stays gated `manager.finance.view`); test `apps/manager/test/finance_overview_test.dart`.
- Period chips (Today, 7 days, 30 days, This month, Custom) + zone picker (Phase 2 widget); two figure groups in the document's words and order — *Sales and commission* (Total gross sales, Net sales, Platform commission (with GST and other charges in the detail), Vendor-funded discounts, Deligro-funded discounts, Refunds and adjustments, Delivery fees collected, Rider delivery earnings, Vendor earnings payable, Rider earnings payable) and *Payments* (Vendor payments due, Vendor payments completed, Rider payouts due, Rider payouts completed, Failed or delayed transactions, Pending approvals) — JetBrains Mono figures, en-IN rupees (rider values with paise only when non-zero); a daily line chart (customer paid, net sales) from `series`; each figure taps through (dues → A3 lists, issues → A3 issues, pending approvals → Phase 5 Approvals filtered `kind=vendor_settlement`); "Export date-wise" runs report `finance-daily` with the same filters through A6's exporter; cancelled orders shown as a separate line under net sales.
- [ ] **Step 1: Test:** renders every figure label from the fixture in order; Deligro-funded = `discounts.platform`; tapping Vendor payments due opens the dues route; a 403 `permission_denied` shows the "Finance isn't switched on for your account" state; error → Retry; ≥ 840 dp renders two columns.
- [ ] **Step 2–4. Step 5: Commit** `feat(manager-app): finance overview — sales, commission and payments`.

### Task A3: Payment tracking — dues, issues, settlement history, rider payouts

**Files:** Create `apps/manager/lib/features/finance/{vendor_dues_screen,rider_dues_screen,issues_screen,settlements_screen,settlement_detail_screen,rider_payouts_screen}.dart`; router `/finance/vendor-dues`, `/finance/rider-dues`, `/finance/issues`, `/finance/settlements`, `/finance/settlements/:id`, `/finance/rider-payouts`; push link `settlement` → `/finance/settlements/<id>`; test `apps/manager/test/payment_tracking_test.dart`.
- Dues lists with "Delayed only" filter, oldest-first, `delayed` marked with `StatusText`-style dot + word (amber); issues grouped by type with counts, each opening its subject (order → Phase 3 detail, vendor → Phase 4 vendor finance, rider → Phase 5 rider money, request → Approvals); settlement history with status filter (Draft, Awaiting approval, Paid, Void), period, net, **transaction reference** shown in full and copyable; settlement detail with lines (paged list), corrections, request block and its status; rider payouts with reference and approver; infinite scroll, `Empty` line on a filtered-empty list.
- [ ] **Step 1: Test:** reference text is selectable/copyable; status filter maps to the `status=` query; delayed filter; issue tap routes per subject kind; detail shows "Refund approved after this payout — correction outstanding ₹120" when a correction is outstanding.
- [ ] **Step 2–4. Step 5: Commit** `feat(manager-app): payment tracking — dues, failed and delayed, settlement history, payouts`.

### Task A4: Initiate a settlement, approvals for settlements, refunds

**Files:** Create `apps/manager/lib/features/finance/{initiate_settlement_sheet,refunds_screen,refund_decision_sheet}.dart`; Modify Phase 5 `apps/manager/lib/features/payments/approvals_screen.dart` (vendor-settlement cards: shop, period, orders, net, "Open settlement"; `amount_changed` dialog shows old → new and re-submits with `confirmAmount`); router `/finance/refunds`; test `apps/manager/test/settlement_actions_test.dart`.
- Initiate from a vendor due row ("Put up for payment", visible only with `manager.finance.initiate_payment`): period pre-filled from the vendor's cycle and oldest unsettled date, or single order; method; note; preview of net from the response; success shows "Waiting for approval by someone else". Approve/reject only when `canDecide` is true; the requester sees "You can't approve your own request" and a Cancel. Refunds queue (pending first) with approve/deny + required reason (visible only with `manager.finance.adjust`); `effect_failed` shows "Decision saved; finishing it failed — retry" and retries with the same `clientActionId`.
- [ ] **Step 1: Test:** initiate button hidden without the permission; `negative_net` shows "This shop owes Deligro ₹340 — collect it separately"; requester cannot approve; `amount_changed` flow re-submits with a **new** `clientActionId` and `confirmAmount` = the new amount (the first attempt's id is spent on the refusal; assert the fake receives both); refund deny requires 3+ chars; `effect_failed` retry reuses the id.
- [ ] **Step 2–4. Step 5: Commit** `feat(manager-app): maker–checker settlements and refund decisions`.

### Task A5: Reconciliation

**Files:** Create `apps/manager/lib/features/finance/reconciliation_screen.dart`; router `/finance/reconciliation` (reachable from Finance and from More → Cash for `manager.cash`-only managers, opening on the Cash section); test `apps/manager/test/reconciliation_test.dart`.
- Segmented control Orders / Online payments / Cash; summary chips per state (tap filters `state=`); order rows show expected vs settled and the difference in red when negative; cash rows per rider-day with status and links to the deposits (Phase 5 cash screen); a managers block (received vs handed on).
- [ ] **Step 1: Test:** summary chip filters; difference sign colouring; a `manager.cash`-only manager sees only the Cash segment.
- [ ] **Step 2–4. Step 5: Commit** `feat(manager-app): reconciliation — orders, online payments and cash`.

### Task A6: Reports and the generic exporter

**Files:** Create `apps/manager/lib/features/reports/{reports_screen,report_view,report_filters_sheet}.dart`, `apps/manager/lib/core/report_export.dart` (CSV, XLSX, PDF from any `ReportPayload`; reuse `ReportMeta`'s generated line and the bundled Roboto for ₹); Modify `stats_export.dart` to share helpers (no behaviour change), More menu row "Reports" (gated `manager.reports.view`), router `/more/reports`, `/more/reports/:kind`; test `apps/manager/test/reports_test.dart`.
- Picker lists `kinds` (only permitted ones) with blurbs; report view: From / To (default last 30 days, max 366), filter chips shown per kind's `filters` (vendor picker from Phase 4 list, rider picker from Phase 5 list, status from `statusOptions`, zone, payment), highlights, notes, a paged table (horizontal scroll on phones, full table ≥ 840 dp) with the totals row pinned; Export → CSV / Excel / PDF using `all=1`; 413 → "Too many rows (18,420). Narrow the range." Every file's header: title, period, zone, filters in words, "Generated <IST time> by <name>" from `generatedAt`/`generatedBy`; PDF repeats header and page numbers on every page; CSV uses column labels as the header row and raw numbers (no ₹) in cells.
- [ ] **Step 1: Test:** CSV of the fixture has the header lines, label row, one line per row and the totals line; money cells numeric; XLSX opens with the `excel` package and has the same cell values; PDF builds (byte length > 0) with the generated line text present; filters sheet shows only the kind's filters; 413 message; empty report shows the `Empty` line and disables export.
- [ ] **Step 2–4. Step 5: Commit** `feat(manager-app): reports — twelve kinds, filters, CSV, Excel and PDF`.

### Task A7: Release build check (app half)

- [ ] `flutter analyze` clean; `flutter test` PASS; `flutter build apk --release --dart-define-from-file=env/prod.json` with the F:\dev env; install on `deligro_test`; cold start → login with no `FATAL`/`E/flutter` in logcat; widget-test screenshots (golden or `takeScreenshot`, rendered from fixtures — no fixture mode in release) of Finance overview, Settlement detail, Reconciliation and a Report view, light and dark, saved to the scratchpad. Commit `test(manager-app): phase 6 release check`.

### Task I1: Integrate, contract check, phase exit (in `F:\hub26\deligro-manager`)

- [ ] **Step 1:** `git merge feat/manager-p6-server`, then `git merge feat/manager-p6-app`; resolve (none expected — disjoint paths).
- [ ] **Step 2: Contract check.** Extend `scripts/qa/manager-contract-emit.ts` (the Phase 3 emitter; Phase 5 may have extended it under the same name) to run the S4–S7 serialisers on fixed rows and write every Phase 6 response to `apps/manager/test/fixtures/api/generated/phase6/`; add `apps/manager/test/contract_phase6_test.dart` parsing each with the A1 models (no field the app reads missing or mistyped). Run both — PASS. Commit the generated fixtures.
- [ ] **Step 3: Phase exit:** every `scripts/qa/sql/migration-*.mjs` `ok`; all `npx tsx scripts/qa/manager-*.ts`, `test:metrics`, `test:idor`, `test:platform` PASS; `npx tsc --noEmit`; `npm run lint`; `next build`; `cd apps/manager && flutter analyze && flutter test`; release APK installed and cold-started on `deligro_test`.
- [ ] **Step 4:** Update `docs/DATABASE.md` (0155–0156), SECURITY_AUDIT log row (finance reads for managers, maker–checker settlements, refund decisions), commit `chore(manager-app): phase 6 integration — contract fixtures and exit checks`.
- [ ] **Step 5:** `git worktree remove F:/hub26/deligro-manager-p6s`, `git worktree remove F:/hub26/deligro-manager-p6a`, `git branch -d feat/manager-p6-server feat/manager-p6-app`.

## Notes for later phases

- **Phase 7** appends a `campaigns` source to `src/lib/reports/builders/marketing.ts` (fills `budget`, `fundedBy`, `status` from the campaign; attribution per the design) — no new report kind, no column change.
- **Phase 8** reads `FINANCE_THRESHOLDS` and `listFinanceIssues` for the `settlement_delayed`, `rider_payout_issue` and `cash_discrepancy` alerts (cash from `getReconciliation(section: "cash")`), and the `support-tickets` report gains no columns.
- **Phase 9** automated reports call `runReport` with `all=1` and render the PDF server-side from the same `ReportPayload`.

## Part A execution notes (2026-10-22)

Built in `deligro-manager-p6a` on `feat/manager-p6-app`, `apps/manager/` only. English only throughout.

- **A1** `f5782d9` — `models/{finance,settlement,report}.dart`, `data/{finance,reports}_repository.dart`, providers, 17 fixtures in `test/fixtures/api/phase6/`, `test/fakes/fake_finance_repository.dart`. `PaymentRequest` gains `settlementId` and `selfApproved` (bool, rendered as "Self-approved by admin").
- **A2** `3df8fbe` — Finance tab (period chips Today · 7 days · 30 days · This month · Custom, IST, ≤ 366 days), the ten sales and six payment figures in the document's words and order, hairline rows not boxes, two columns from 840 dp, daily chart (customers paid, net sales), links to every tracking list, "Export date-wise report" → `/more/reports/finance-daily` (shown only with `manager.reports.view`).
- **A3 + A4** `26781e8` — one commit: both edit the router and the vendor-dues row, so neither compiled alone. Dues lists with Delayed only, failed/delayed grouped by kind with counts and opening their subject, settlement history (status filter, reference in full + copy, list + detail from 840 dp), settlement detail (lines, corrections in words, request block), rider payouts; push `type: settlement|refund` and `/finance/*` paths. "Put up for payment" sheet (period pre-filled from the oldest unsettled order and the shop's cycle, or one order by id), settlement cards in Approvals (`?kind=vendor_settlement`, Open settlement), refunds queue with reasoned approve/deny and `effect_failed` retry on the same id.
- **A5** `5675b22` — reconciliation (Orders / Online payments / Cash, state chips, signed differences red when negative, managers' received vs handed on). Also at `/more/cash/reconciliation` for `manager.cash`-only managers (Cash screen → Reconciliation).
- **A6** `962ce70` — Reports picker (server's permitted kinds), report view (dates, kind-only filters sheet, highlights, notes, paged table with totals row), `core/report_export.dart` (CSV with BOM and formula guard, Excel, PDF with header on every page and page numbers, Roboto for ₹); 413 → "Too many rows (N). Narrow the range."; empty → Empty line and export off.
- **A7** `af6f12e` + release check — screenshot harness (finance light/dark/tablet, dues, issues, settlements + tablet, settlement detail light/dark, approvals with settlement cards, refunds, reconciliation light/dark, reports picker, report light/dark/tablet, export sheet).

**Contract gaps assumed around (for I1 / Part S to confirm):**
1. `ReportColumn.type = percent` values are read as fractions (0.125 → 12.5%), as `src/lib/metrics` computes rates. If the server sends 12.5, I1 must change `reportCellText`.
2. `labelHi` in kinds/columns/highlights is ignored (English only); the server may drop it.
3. `selfApproved` on `PaymentRequest` is not in the pinned contract; read as optional, default false.
4. One-order initiation takes the order **id** typed/pasted (the contract wants `orderId`; there is no order-code lookup).
5. Approvals `?kind=` filters client-side (Phase 5's list route has no `kind` param).
6. Settlement `amount_changed` re-sends as a new decision (new `clientActionId`); rider payouts keep Phase 5's same-id confirm.
7. Rider payouts list shows "approved through Approvals" when `requestId` is set; the contract carries no approver name.
8. Reconciliation shows the first page only (with a note); `nextCursor` beyond it is not followed.

**TDD notes:** A1–A4 and A6 tests were run and seen failing before the code. A5's test and screen were written together and not run in between.

## I1 result (2026-10-22)

- **Merges:** `feat/manager-p6-server` (conflicts kept both sides: `selfApproved` + `settlementId` on payment requests, the merged error-code list), then `feat/manager-p6-app` (clean).
- **One maker–checker rule:** 0156 had re-declared `ops_decide_payment_request` from the 0152 body it branched from, losing Phase 5's later fixes (replay match, one-admin switch, approved-amount payout). The rule is now one helper in 0152, `_payment_maker_checker(actor, request, decision, note)`, used for rider payouts and vendor settlements alike; every 0156 RPC checks a replayed id is the same action. No one-person vendor payment path: admin web "mark paid" goes through payment requests. Proof 0156: 54/0 (the new checks fail on the unreconciled 0156).
- **Contract check:** `scripts/qa/manager-contract-phase6.ts` (16 answers, in `npm run test:manager-contract`) + `apps/manager/test/contract_phase6_test.dart`. Part A's open points: rates are fractions (as assumed); no `labelHi` anywhere; `selfApproved`/`settlementId` present; report rows follow each report's own columns.
- **Parity:** `manager-reports.ts` (report totals = finance overview) and, new, `manager-finance-sql-parity.ts` (dashboard 0144 = finance 0157 for sales, delivery fees, commission, vendor dues, cancelled, per zone).
- **Exit:** all SQL proofs; 73 test scripts (all but idor/e2e/zap/qa, which need a live server and login); `tsc` clean; eslint clean on touched files; `next build` OK; `flutter analyze` clean; 463 Flutter tests; release APK 72.6 MB cold-starts to the English login on `deligro_test`, no FATAL / `E/flutter`.
- **Left open:** Part A gaps 4 (one-order initiation takes the order id, no code lookup), 5 (Approvals filters `kind` client-side), 8 (reconciliation shows the first page only). Signed-in checks need manager credentials and applied migrations.
