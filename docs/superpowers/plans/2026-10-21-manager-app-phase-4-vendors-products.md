# Manager App — Phase 4: Vendors & products — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every vendor in the manager's zones — list, onboarding, registration review, documents, status (approve / reject / suspend / reactivate), store info and hours, orders, sales, ratings, money, rates, contact and complaints — and every product across those vendors — availability, stock, categories, price and availability history, frequently-unavailable items, listing review, flags, restricted-listing approvals, sales performance and permission-gated stock adjustment (§4, §12). Every change is one audited RPC.

**Architecture:** A pre-phase merge brings the Partner branch's `0062` (hours, holidays, stock, variants) into `feat/manager-app`. Two migrations: `0145` (vendors: `rejected` status, status provenance, document review, zone-scoped manager read policies, ticket ↔ vendor link, vendor and ticket RPCs) and `0146` (products: moderation columns, restricted categories, `menu_item_changes` history trigger, `listing_flags`, moderation guard, customer-visibility in the menu read policy and the order-line guard, product RPCs). Pure rules (`src/lib/ops/vendor-rules.ts`, `src/lib/ops/product-rules.ts`) compute rates, availability and approval checks; thin `/api/manager/*` routes serialise through one contract module per area. The Flutter app adds Vendors, Products and a generic ticket thread under More, coded against the JSON pinned below with fake repositories.

**Tech Stack:** Supabase Postgres (RPCs, RLS, triggers, storage signed URLs), Next.js route handlers (read `node_modules/next/dist/docs/` first), Flutter 3.47 / Riverpod 3 / go_router, `flutter_map` (map pin in onboarding), `image_picker` / `file_picker` (document upload), `url_launcher` (call / WhatsApp), `fl_chart` (vendor and product charts, already in the app).

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (§4, §12, Permissions, Audit log, Money definitions). Earlier plans: phases 1–3 (`…-phase-3-orders-live.md` defines `ops_require_staff`, `_ops_set_actor`, the tickets base and the order list this phase links to). Neighbouring: `2026-10-21-vendor-app-design.md` (store hours, stock, variants, marketing requests, support), vendor branch migration `0062_store_inventory_options.sql`.

## Execution layout — two halves in parallel

| Half | Worktree | Branch | Touches |
|---|---|---|---|
| **Part S (server)** | `F:\hub26\deligro-manager-p4s` | `feat/manager-p4-server` | `supabase/`, `scripts/`, `src/`, `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md` |
| **Part A (app)** | `F:\hub26\deligro-manager-p4a` | `feat/manager-p4-app` | `apps/manager/` only |

**Task P0** runs first in `F:\hub26\deligro-manager`. Then both halves branch from `feat/manager-app` at P0's commit. They share no files. When both are done: merge S, then A, into `feat/manager-app`, then run **Task I1** there. Remove both worktrees afterwards (`git worktree remove`, `git branch -d`).

## Global Constraints

- Phase 1–3 Global Constraints apply unchanged (AGENTS.md rules, migrations 0141–0199 with **0145–0149 for this phase**, F:\dev build env, release-APK smoke test, commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never touch `F:\hub26\deligro`, `deligro-rider`, `deligro-vendor`; never bare `git stash`.
- English only — no Hindi (owner).
- **Every audited write is one RPC that changes and logs in the same transaction** (`_ops_log`, 0141), following 0142's pattern: `security definer set search_path = public`, `_ops_set_actor(p_actor)`, `ops_require_staff(p_actor, <zone>)` first, replay-safe on `p_client_action_id`, `revoke execute … from public, anon, authenticated; grant execute … to service_role`.
- **Re-declared functions:** before re-declaring `lock_restaurant_privileged_fields()` or `guard_order_item_insert()`, diff every definition of it across `supabase/migrations/` on the branch (after P0's merge) and keep all behaviour; add only what this plan names.
- **Permissions per call** (`managerApiContext(key)` before anything else):

| Call | Key |
|---|---|
| vendor list, detail, reviews, documents list/view, hours, complaints list | `manager.vendors.view` |
| vendor detail `finance` block | `manager.vendors.view` **and** `manager.finance.view` (block absent otherwise) |
| approve, reject, suspend, reactivate, verify / reject document | `manager.vendors.status` |
| onboard a vendor, upload a document | `manager.vendors.onboard` |
| ticket thread, reply, status | `manager.support.manage` |
| product list, detail, categories, insights; **flag** a listing | `manager.products.view` |
| hide / unhide, approve / reject a restricted listing, resolve a flag, restricted categories | `manager.products.moderate` |
| stock adjustment | `manager.products.adjust_stock` |

- **Zone scope** on every read (`applyZoneScope` on `restaurants.zone_id`; menu items, documents, reviews, tickets through their restaurant; the vendor's `zone_id` must be in scope for every action). Out-of-scope ids answer **404 `not_found`**. RPCs re-check the zone in the database.
- Vendor contact: `shopPhone` (0062, public business number) always; `ownerMobile` and `ownerEmail` to managers with `manager.vendors.view` (§4.14 needs them; they are business contacts, not customer PII). Bank details, PAN, GST numbers and `vendor_login_credentials` never leave the server in this phase.
- Customer names in reviews: first name only; never a customer phone.
- Document files are only ever served as **60-second signed URLs** from the private `vendor-docs` bucket, generated server-side after the scope check.
- Money in vendor payloads comes from `src/lib/metrics` (`salesSummary`, `vendorEarnings`, `platformCommission`) through the Phase 2 loaders (`loadMetricOrders`, `loadRefunds`, `loadPricing`, `loadPaidOrderIds`) — never a new formula.

## Claude's calls

- **Vendor statuses.** `vendor_status` gains `rejected`. Transitions (one RPC, `expected` status required → 409 `stale` otherwise): approve `pending|rejected → active`; reject `pending → rejected`; suspend `active|inactive → suspended`; reactivate `suspended|inactive → active`. **A reason (3–300 chars) is required for all four.** Approve and reactivate need a map pin (0050's rule; `needs_map_pin`). Approve also checks required documents (`fssai`, `bank_proof`) are `verified`; if not, it answers 409 `documents_unverified` with the missing types unless the request carries `override: true`, which is recorded in the audit row's `after` (`documents_override: true`). Suspension takes the shop off the storefront through 0017's `approved` sync; orders already in flight continue.
- **Who may set commission and payment terms.** Not managers. Onboarding from the app creates the shop at platform defaults; commission, payment rules and settlement cycle stay admin-only (0024/0034/0056 lock, unchanged).
- **Document verification** is part of `manager.vendors.status` (it is the approval decision's evidence). Rejecting a document requires remarks; the vendor is pushed.
- **Restricted listings.** `listing_restricted_categories` names menu categories (case-insensitive match on `menu_items.category`, trimmed) that need approval. A **new** item in a restricted category is created `approval_status = 'pending'` and is invisible to customers until approved. A **price change** on an approved restricted item does not hide it: the trigger parks the new price in `pending_price`, keeps the old `price` live, and sets `approval_status = 'pending'`; approval applies `pending_price`, rejection drops it. (Refines the design's "invisible until approved", which would have pulled a live dish off the menu for a price edit.) Moving an item into a restricted category makes it `pending` and hidden.
- **Flags vs hiding.** Any manager with `products.view` may flag a listing (`listing_flags`, reasons `inaccurate | inappropriate | wrong_image | wrong_price | wrong_category | other`); hiding, unhiding, resolving flags and approval decisions need `products.moderate`. A hidden item (`hidden_by_ops`) is invisible to customers and unorderable; the vendor sees it with the reason and cannot unhide it.
- **History.** `menu_item_changes` records `price`, `discount_price`, `available`, `name`, `image_url`, `category`, `approval_status`, `hidden_by_ops`, and `stock_qty` **only when a person changes it** (`pg_trigger_depth() = 1`; stock moved by 0062's order triggers is not history). Source `vendor | ops | admin | system`.
- **Frequently unavailable** (§12.6): per item over the range, `timesUnavailable` (transitions to unavailable) and `hoursUnavailable` (intervals reconstructed from `available` changes, the state at range start taken from the last change before it, else the current value if no change ever happened). Listed when `timesUnavailable ≥ 3` or `hoursUnavailable ≥ 24` in the range (constants in `product-rules.ts`), sorted by hours.
- **Vendor rates** (§4.13, default range = last 30 IST days): `cancellationRate` = cancelled ÷ all orders; `rejectionRate` = cancelled with `cancelled_by = 'vendor'` ÷ all orders; `avgAcceptMinutes` = mean `accepted_at − created_at` of accepted orders; `avgPrepMinutes` = mean `ready_at − accepted_at`.
- **Vendor complaints** = tickets linked to the shop: `support_tickets.restaurant_id`, stamped by trigger from the ticket's order, else from the requester when the requester owns a shop (role `restaurant`). The generic ticket thread, reply (public or internal) and status endpoints are built here, role-generic, and Phase 8 extends them (assignment, filters, metrics) rather than writing a second copy.
- **Onboarding audit.** The auth user cannot share a transaction with SQL, so `createVendorAccount` creates the auth user first (as today), then inserts the shop, menu and audit row in one RPC (`ops_onboard_vendor`); on RPC failure it deletes the auth user (today's compensation). The admin wizard is moved onto the same RPC (actor = the admin), so both paths are audited.

## API contract (pinned — both halves code to this)

All responses are JSON. Errors: `{ "error": "<code>", ...extra }`. Timestamps ISO-8601 UTC; money whole rupees (int); ids uuid strings; dates `YYYY-MM-DD` (IST).

### Shared shapes

```jsonc
// VendorListItem
{ "id": "uuid", "name": "Spice Hub", "slug": "spice-hub", "status": "pending|active|inactive|suspended|rejected",
  "openState": "open|closed|temporarily_closed|holiday|weekly_off|outside_hours", "category": "Restaurant|null",
  "zone": { "id": "uuid", "name": "Bemetara" }, "logoUrl": "…|null",
  "rating": 4.3, "ratingCount": 120, "todayOrders": 14, "pendingDocuments": 1, "openComplaints": 0,
  "createdAt": "…" }
// VendorDocument
{ "id": "uuid", "type": "fssai|gst|pan|bank_proof|shop_license|other", "fileName": "fssai.pdf",
  "status": "pending|verified|rejected", "remarks": "…|null", "reviewedBy": { "id": "uuid", "name": "…" } /* or null */,
  "reviewedAt": "…|null", "uploadedAt": "…" }
// ReviewItem
{ "id": "uuid", "rating": 4, "comment": "…|null", "customerFirstName": "Asha|null", "createdAt": "…",
  "status": "published|hidden|removed", "orderCode": "AB12CD34|null",
  "subRatings": { "foodQuality": 4, "packaging": null, "deliveryExperience": 5, "valueForMoney": null },
  "reply": { "text": "…", "at": "…" } /* or null */ }
// TicketSummary
{ "id": "uuid", "number": 17, "subject": "…", "category": "…", "priority": "normal|high|emergency",
  "status": "open|in_progress|waiting_on_requester|escalated|resolved|closed",
  "requesterRole": "restaurant|driver|customer|manager|admin", "orderId": "uuid|null", "createdAt": "…", "updatedAt": "…" }
// ProductListItem
{ "id": "uuid", "name": "Paneer Tikka", "vendor": { "id": "uuid", "name": "Spice Hub" }, "category": "Starters|null",
  "price": 180, "discountPrice": null, "pendingPrice": null, "imageUrl": "…|null", "veg": true,
  "available": true, "stockQty": 12 /* null = not tracked */, "lowStockAt": 5, "soldOutByStock": false,
  "approvalStatus": "approved|pending|rejected", "hidden": false, "openFlags": 0, "updatedAt": "…|null" }
// ProductChange
{ "id": 812, "field": "price|discount_price|available|name|image_url|category|approval_status|hidden_by_ops|stock_qty",
  "from": "160|null", "to": "180|null", "source": "vendor|ops|admin|system",
  "actor": { "id": "uuid", "name": "…", "role": "…" } /* or null */, "at": "…" }
// ListingFlag
{ "id": "uuid", "reason": "inaccurate|inappropriate|wrong_image|wrong_price|wrong_category|other", "note": "…|null",
  "status": "open|resolved|dismissed", "raisedBy": { "id": "uuid", "name": "…" }, "raisedAt": "…",
  "resolution": "…|null", "resolvedBy": { "id": "uuid", "name": "…" } /* or null */, "resolvedAt": "…|null" }
```

### `GET /api/manager/vendors`

Query: `q` (name or slug, ≥ 2 chars), `status` (comma list of statuses), `filter` (`active` = status active · `online` = active and `openState = open` · `pending` · `needs_attention` = pending documents or open complaints), `zone`, `category`, `cursor`, `limit` (default 50, max 100). Keyset on `(name asc, id asc)`.
200: `{ "items": [VendorListItem], "nextCursor": "string|null", "counts": { "all": 60, "pending": 3, "active": 49, "suspended": 2, "rejected": 1, "inactive": 5, "online": 31 } }`. 400 `bad_request` with `field`.

### `GET /api/manager/vendors/[id]`

200: `{ "vendor": VendorDetail }`, `VendorDetail` = `VendorListItem` plus
```jsonc
{
  "statusReason": "…|null", "statusChangedAt": "…|null", "statusChangedBy": { "id": "uuid", "name": "…" } /* or null */,
  "description": "…|null",
  "contact": { "shopPhone": "…|null", "ownerName": "…|null", "ownerMobile": "…|null", "ownerEmail": "…|null" },
  "address": { "line": "…|null", "landmark": "…|null", "pincode": "…|null", "lat": 21.7, "lng": 81.5 /* null when unpinned */ },
  "hours": { "opening": "09:00|null", "closing": "23:00|null", "weeklyOff": ["monday"], "closedUntil": "…|null",
             "holidays": [{ "from": "2026-11-01", "to": "2026-11-03", "note": "…|null" }],
             "deliveryAvailable": true, "selfPickup": false, "prepMinutesDefault": 20 /* null */ },
  "registration": { "fssaiNumber": "…|null", "tcAcceptedAt": "…|null", "tcVersion": "…|null", "onboardedAt": "…" },
  "documents": [VendorDocument],
  "performance": { "from": "2026-09-21", "to": "2026-10-20", "orders": 412, "sales": 98400, "aov": 239,
                   "cancellationRate": 0.06, "rejectionRate": 0.02, "avgAcceptMinutes": 3.4, "avgPrepMinutes": 18.2,
                   "rating": 4.3, "ratingCount": 120, "ratingDistribution": { "1": 2, "2": 3, "3": 10, "4": 40, "5": 65 } },
  "finance": {                                   // key ABSENT without manager.finance.view
    "commissionPct": 12, "commissionGstPct": 18, "otherChargesPerOrder": 0, "settlementCycle": "weekly|monthly|…",
    "pendingPayment": 18240, "recoverable": 0, "commissionThisPeriod": 11808,
    "settlements": [{ "id": "uuid", "periodStart": "…", "periodEnd": "…", "netPayable": 20110,
                      "status": "draft|paid|void", "paidAt": "…|null", "paymentRef": "…|null" }]   // latest 10
  },
  "openComplaints": [TicketSummary],             // open/in_progress/waiting/escalated, latest 10
  "allowed": { "approve": false, "reject": false, "suspend": true, "reactivate": false,
               "reviewDocuments": true, "uploadDocuments": false }
}
```
404 `not_found`.

### `GET /api/manager/vendors/[id]/reviews?cursor=&limit=`

200: `{ "items": [ReviewItem], "nextCursor": "string|null" }` (newest first).

### `GET /api/manager/vendors/[id]/documents/[docId]/url`

200: `{ "url": "https://…signed…", "expiresAt": "…" }` (60 s). 404 `not_found`.

### `GET /api/manager/vendors/[id]/complaints?status=&cursor=`

200: `{ "items": [TicketSummary], "nextCursor": "string|null" }`.

### `POST /api/manager/vendors/[id]/actions`

Body: `{ "action": "approve|reject|suspend|reactivate|verify_document|reject_document", "reason": "string", "clientActionId": "uuid", "expected": "<current status>" /* status actions */, "override": false /* approve */, "documentId": "uuid" /* document actions */ }`
200: `{ "ok": true, "vendor": VendorDetail }`. Replay → 200, nothing applied twice.
Errors: 400 `bad_request` | `reason_required`; 403 `permission_denied`; 404 `not_found`; 409 `stale`, `invalid_transition`, `needs_map_pin`, `documents_unverified` (`{ "missing": ["fssai"] }`); 429.

### `POST /api/manager/vendors` (onboard)

Body (the registration wizard's `VendorDraftData` subset): `{ "clientActionId": "uuid", "zoneId": "uuid", "shopName": "…", "category": "…|null", "description": "…|null", "ownerName": "…", "mobile": "10 digits", "email": "…", "password": "≥8|null", "address": "…", "landmark": "…|null", "pincode": "…|null", "lat": 21.7, "lng": 81.5 /* nullable */, "openingTime": "09:00|null", "closingTime": "23:00|null", "weeklyOff": [], "deliveryAvailable": true, "selfPickup": false, "fssaiNumber": "…|null" }`
201: `{ "id": "uuid", "slug": "…", "credentials": { "email": "…", "password": "…" } /* only when generated */ }`.
Errors: 400 `bad_request` (`field`); 403; 404 (`zoneId` out of scope); 409 `email_taken`, `phone_taken`; 429. The shop is created `pending`.

### `POST /api/manager/vendors/[id]/documents` (multipart)

Fields: `type` (doc type), `file` (jpeg/png/webp/pdf ≤ 10 MB), `clientActionId`. 201: `{ "document": VendorDocument }`. 400 `bad_file`; 403; 404.

### Tickets (generic; Phase 8 extends)

- `GET /api/manager/tickets/[id]` → `{ "ticket": TicketSummary & { "restaurant": { "id", "name" } | null, "zoneId": "uuid|null", "escalationLevel": 0, "resolution": "…|null", "firstResponseAt": "…|null", "resolvedAt": "…|null" }, "messages": [{ "id": "uuid", "author": { "id", "name", "role" }, "body": "…", "internal": false, "attachments": [{ "name": "…", "url": "signed 60 s" }], "at": "…" }] }`
- `POST /api/manager/tickets/[id]/messages` body `{ "body": "1–4000", "internal": false, "clientActionId": "uuid" }` → 201 `{ "ok": true }` (sets `first_response_at` on the first non-internal staff reply; pushes the requester for non-internal messages).
- `POST /api/manager/tickets/[id]/status` body `{ "status": "in_progress|waiting_on_requester|resolved|closed", "resolution": "required for resolved|closed, 3–1000", "clientActionId": "uuid" }` → 200 `{ "ok": true }`. 409 `invalid_transition` (closed is final).

### `GET /api/manager/products`

Query: `q` (name, ≥ 2 chars), `vendor`, `category`, `availability` (`available|unavailable|out_of_stock|low_stock`), `approval` (`pending|approved|rejected`), `flagged` (`open`), `hidden` (`true`), `zone`, `cursor`, `limit` (default 50, max 100). Keyset on `(name asc, id asc)`.
200: `{ "items": [ProductListItem], "nextCursor": "string|null", "counts": { "unavailable": 12, "outOfStock": 4, "lowStock": 6, "pendingApproval": 2, "openFlags": 1, "hidden": 1 } }`.

### `GET /api/manager/products/categories?zone=&vendor=`

200: `{ "categories": [{ "name": "Starters", "itemCount": 140, "unavailableCount": 9, "vendorCount": 22, "restricted": false }] }` — `name` null bucket returned as `"Uncategorised"`.

### `GET /api/manager/products/[id]`

200: `{ "product": ProductListItem & { "description": "…|null", "variants": [{ "name": "Half", "price": 120 }], "addonGroups": [{ "name": "Extras", "addons": [{ "name": "Cheese", "price": 20 }] }], "approvalNote": "…|null", "hiddenReason": "…|null", "changes": [ProductChange] /* newest first, ≤ 100 */, "flags": [ListingFlag], "sales": { "from": "…", "to": "…", "units": 64, "revenue": 11520, "orders": 51, "rankInVendor": 3, "daily": [{ "date": "2026-10-20", "units": 4 }] }, "availability": { "timesUnavailable": 2, "hoursUnavailable": 6.5 }, "allowed": { "flag": true, "hide": true, "unhide": false, "approve": false, "reject": false, "adjustStock": false } } }`. 404 `not_found`.

### `GET /api/manager/products/insights?from=&to=&zone=&vendor=`

200:
```jsonc
{ "from": "…", "to": "…",
  "frequentlyUnavailable": [{ "product": ProductListItem, "timesUnavailable": 5, "hoursUnavailable": 31.5 }],
  "priceChanges": [{ "product": ProductListItem, "from": 160, "to": 180, "changePct": 12.5, "at": "…", "source": "vendor" }],
  "topSellers": [{ "product": ProductListItem, "units": 64, "revenue": 11520 }],
  "slowSellers": [{ "product": ProductListItem, "units": 0, "revenue": 0 }],            // available items with the fewest units
  "outOfStock": [ProductListItem] }
```

### `POST /api/manager/products/[id]/actions`

Body: `{ "action": "flag|hide|unhide|approve|reject|resolve_flag|dismiss_flag|adjust_stock", "reason": "string", "clientActionId": "uuid", "flagReason": "…" /* flag */, "flagId": "uuid" /* resolve/dismiss */, "stockQty": 25 /* adjust_stock: new absolute quantity ≥ 0, or null to stop tracking */ }`
200: `{ "ok": true, "product": <detail as above> }`. Errors: 400 `bad_request` | `reason_required`; 403; 404; 409 `invalid_transition` (e.g. approve a non-pending item), `stale`; 429.

### `GET|POST /api/manager/products/restricted-categories`

GET → `{ "categories": [{ "name": "…", "note": "…|null", "createdAt": "…" }] }`. POST `{ "name": "…", "restricted": true|false, "reason": "…", "clientActionId": "uuid" }` → `{ "ok": true, "categories": [...] }` (`manager.products.moderate`).

### Changed: `GET /api/manager/stats`

Gains `vendor=<uuid>` (in scope, else 404): every figure computed over that shop only. Permission additionally `manager.vendors.view` when `vendor` is present.

## Requirement coverage

| Spec item | Task |
|---|---|
| §4.1 view all registered vendors | S3, A2 |
| §4.2 add / onboard (authorised) | S1 (`ops_onboard_vendor`), S4, A4 |
| §4.3 review registration details | S3 (`registration`, `address`, `contact`), A3 |
| §4.4 approve, reject, suspend, reactivate | S1, S4, A3 |
| §4.5 verify required documents | S1 (`ops_review_vendor_document`), S3, S4, A3 |
| §4.6 contact and store information | S3, A3 |
| §4.7 opening hours and availability | P0 (0062), S3 (`hours`, `openState`), A3 |
| §4.8 vendor order history | Phase 3 `GET /api/manager/orders?vendor=`, A3 (link) |
| §4.9 vendor sales statistics | S3 (`performance`), S5 (`stats?vendor=`), A3 |
| §4.10 ratings and reviews | S3, A3 |
| §4.11 commissions and settlements | S3 (`finance`), A3 |
| §4.12 pending vendor payments | S3 (`finance.pendingPayment`), A3 |
| §4.13 cancellation and rejection rates | S2 (`vendorRates`), S3, A3 |
| §4.14 contact vendors | S3 (`contact`), A3 (call / WhatsApp) |
| §4.15 resolve vendor-related complaints | S1 (`restaurant_id`, ticket RPCs), S4 (ticket routes), A5 |
| §12.1 products across authorised vendors | S6, A6 |
| §12.2 product availability | S6, A6 |
| §12.3 out-of-stock products | P0 (stock), S6 (`availability=out_of_stock`, insights), A6 |
| §12.4 product categories | S6 (`categories`), A6 |
| §12.5 price changes | S5 (`menu_item_changes`), S6 (`priceChanges`, history), A6 |
| §12.6 frequently unavailable | S2 (`frequentlyUnavailable`), S6, A6 |
| §12.7 listings and images | S6 (detail incl. variants, images), A6 |
| §12.8 flag listings | S5 (`listing_flags`, `ops_flag_listing`), S7, A6 |
| §12.9 approve restricted listing changes | S5 (moderation guard, `ops_decide_listing`), S7, A6 |
| §12.10 product sales performance | S6 (`sales`, top/slow sellers), A6 |
| §12 "stock stays with the vendor unless permitted" | S5 (`ops_adjust_stock`, `products.adjust_stock`), S7, A6 |

## Review Focus

1. **A vendor bypasses moderation** by writing `approval_status`, `hidden_by_ops`, `pending_price` directly, or by changing the price of an approved restricted dish → the trigger keeps every moderation column, the new price is parked in `pending_price`, the customer still sees and pays the old price, and a hidden or pending dish can neither be read by a customer nor ordered. (S5 PGlite; S7 QA.)
2. **A customer surface leaks a hidden or pending dish** through a service-role read (phone orders, search, restaurant page, order route) → every customer-facing `from("menu_items")` filters `approval_status = 'approved'` and `hidden_by_ops = false`, asserted structurally; RLS hides them from anon/authenticated customers; the order-line guard refuses them with `item_unavailable`. (S5 PGlite; S7 structural QA.)
3. **A manager in zone A** reads, flags, hides, approves or suspends a vendor or product of zone B by id, or onboards a shop into zone B → 404 / `forbidden`, nothing written; the RPC refuses even with the route check skipped. (S1, S5 PGlite; S4, S7 QA.)
4. **Two managers decide one vendor at once** (one suspends while the other approves), or a manager approves a shop without a map pin or with unverified documents → exactly one wins (`expected` → 409 `stale`); `needs_map_pin`; `documents_unverified` lists the missing types and only `override: true` passes, recorded in the audit row. (S1 PGlite; S4 QA; A3 widget test.)
5. **Availability history at the range edges**: a dish unavailable since before the range and never toggled inside it, a dish toggled ten times in a day, a dish sold out by stock, a deleted dish → hours and counts are right and nothing throws. (S2 QA fixtures.)

---

### Task P0: Merge the Partner branch's store and inventory work (in `F:\hub26\deligro-manager`)

- [ ] **Step 1:** `git merge feat/vendor-app` (brings `0062_store_inventory_options.sql` and its routes); if `feat/rider-app` has new commits, merge it too. Resolve shared files (features catalog, `package.json`, `docs/SECURITY_AUDIT.md`, `docs/DATABASE.md`) keeping both sides.
- [ ] **Step 2:** For every function re-declared by both the merged migrations and 0141–0144 (`guard_order_update`, `guard_order_item_insert`, `lock_restaurant_privileged_fields`, event triggers), diff the definitions and fix the **later-numbered** migration so nothing the earlier one added is lost. Run every `scripts/qa/sql/migration-*.mjs` — all `ok`.
- [ ] **Step 3:** `npx tsc --noEmit`, `npm run lint`, `cd apps/manager && flutter analyze && flutter test`.
- [ ] **Step 4: Commit** the merge, then any reconciliation as `fix(db): reconcile re-declared functions after merging Partner 0062`.

---

# Part S — server (worktree `deligro-manager-p4s`)

## P0 result

Executed 2026-10-21 on `feat/manager-app` (merges `41dd9d7` Partner, rider merge after it; reconciliation commit "chore(manager-app): phase 4 P0 — merge siblings, reconcile").

**Landed from the Partner branch (`feat/vendor-app`):**
- `0062_store_inventory_options.sql` — `store_holidays`; `restaurants.closed_until`, `shop_phone`; `menu_items.stock_qty`, `low_stock_at`, `sold_out_by_stock`, `available_days`, `available_from`, `available_to`; `menu_item_variants`, `menu_item_addon_groups`, `menu_item_addons`; `order_items.options`; `restaurant_open_statuses()`; stock triggers. Everything this plan assumed from 0062 is present.
- `0063_order_invoices.sql` — `orders.invoice_no`, `invoice_at`, `invoice_counters`, `assign_invoice_no()`; it re-declares `guard_order_update()` with the invoice locks.
- `0064_growth_support.sql` — `coupons.starts_at`; `marketing_requests` (statuses `pending / approved / in_progress / completed / rejected / cancelled`) + `marketing_request_updates`; **`support_tickets` / `support_messages` / `support-attachments` bucket (the shared 0087 shape)**; `user_notifications`; `announcements`.
- Server modules: `src/lib/data-access/support.ts` (`createTicket`, `listMyTickets`, `getMyTicket`, `replyToMyTicket`, `listAllTickets`, `getTicketForAdmin`, `adminReply`, `setTicketStatus`), `marketing.ts` (`listShopMarketing`, `createMarketingRequest`, `cancelMarketingRequest`, `listAllMarketing`, `decideMarketingRequest`), `user-notifications.ts` (`getInbox`, `markRead`, `listAnnouncements`, `createAnnouncement`, `endAnnouncement`). Partner app and rider app are now English only too.

**Reconciliation done in P0:**
- `0141` `guard_order_update()` now also locks 0063's `invoice_no`, `invoice_at` (0141 is applied after 0063 and would otherwise have dropped them). `migration-order.mjs` asserts it and that applying 0061 or 0063 after 0141 is detectable.
- `0143` no longer creates the ticket base tables, requester policies, grants or bucket — 0064 owns them; 0143 only adds the manager extensions and zone policies and now states **Depends on 0064**. Its PGlite proof applies 0064 §3 before 0143.

**Consequences for Part S / Part A:**
- The generic ticket thread / reply / status endpoints (S-side) must be built on `support.ts` — extend it with scope-taking, audited variants (`ops_*` RPCs) rather than writing a second ticket data layer. `adminReply` / `setTicketStatus` keep working for the admin console.
- Vendor ↔ ticket link (0145): 0064's `support_tickets` has no `restaurant_id`; 0145 adds it as planned, stamped from the order or the requesting vendor's shop.
- Rider eligibility: the Rider merge brought `src/lib/dispatch/eligibility.ts` (`eligibleCandidates`, via `isDispatchable`). Phase 3's `riderEligibility` uses the same `RIDER_PRESENCE_MS` threshold and adds per-reason output; keep both in step if either changes.


## Part S execution notes

Executed 2026-10-21 on `feat/manager-p4-server` (worktree `deligro-manager-p4s`), tasks S1–S7.

**Contract (Part A must read):**
- **`VendorDetail.openComplaints` is an array.** The pinned contract makes `VendorDetail` = `VendorListItem` plus fields, but the list item's `openComplaints` is a *count* and the detail's is `[TicketSummary]` (latest 10 open). The detail sends only the array; the count key is not repeated. (`VendorDetail extends Omit<VendorListItem, "openComplaints">`.)
- `TicketSummary.requesterRole` uses the contract's words: stored `vendor` → `"restaurant"`, `rider` → `"driver"`; `customer`, `manager`, `admin` pass through.
- Vendor actions also return `409 needs_map_pin` and `409 documents_unverified` with `{ "missing": ["fssai", "bank_proof"] }` (as pinned), plus `500 action_failed` on an unexpected database error, and `200 { ok: true, vendor: null }` when the action succeeded but the re-read failed (refetch). Same for products (`product: null`).
- `POST /vendors` (onboard) also answers `409 stale` for a replayed `clientActionId` that is not the caller's. A replay of the caller's own id answers `201` with the shop the first call made (no second login, no `credentials`).
- Insights take `from`/`to` (IST dates, default the last 30 days, at most 92 days, `to` not in the future).
- `stats?vendor=` answers `403 permission_denied` without `manager.vendors.view`, `404 not_found` for a shop out of scope.

**Calls made:**
- **Admin status control:** the admin console can set any status (soft delete to `inactive`, back to `pending`), which the four manager transitions do not allow. It goes through a separate admin-only RPC, `ops_admin_set_vendor_status` (0145): any status, map pin required for `active`, audited (`vendor.status`), reason defaulting to "Changed in the admin console". The admin UI does not yet ask for a reason (the Manager app does). "Decline a signup" now sets the new `rejected` status instead of `suspended`.
- **Onboarding:** `createVendorAccount` / `attachVendorToExistingUser` take `{ zoneId, clientActionId }` and write the shop through `ops_onboard_vendor`. Commission, bank, GST and PAN keys are honoured for an admin actor only. The storage path for uploads keeps the existing convention (`<restaurantId>/<type>-<key>.<ext>`), not the plan's `restaurants/<id>/<uuid>-<name>`, so existing objects and the bucket layout stay one shape.
- **Per-shop dues** come from a new `ops_vendor_dues` (0145): the dashboard's dues arithmetic for one shop, all-time, instead of loading a shop's whole order history into Node. Parity with `vendorEarnings()` in `scripts/qa/ops-sql-parity.ts`.
- **Product sales** (detail, rank in vendor, top/slow sellers) come from `ops_product_sales` / `ops_product_daily` (0146), parity-checked against a row-by-row sum. Revenue = Σ qty × price of counted, non-cancelled orders.
- **Live dish** = approved, or `pending` with a parked price (it keeps selling at the old price), and not `hidden_by_ops`. RLS, the order-line guard and `onlyLiveDishes()` (service-role reads) all use this one definition.
- **History source:** `ops` under an ops RPC, `system` for anything moved by another trigger (an order's stock, the stock rule's sell-out) or the service role, `admin` for an admin, else `vendor`.
- **Editing a rejected listing resubmits it** (`pending`). Moving a dish into a restricted category makes it a new pending listing (hidden); moving it out does not auto-approve.
- `commissionThisPeriod` = every platform deduction (commission + its GST + other charges) on the performance window, as the dashboard's Total Platform Commission counts it.
- Restricted categories are platform-wide: any admin or manager with `manager.products.moderate`; not zone-scoped.
- The Partner menu list returns `approvalStatus`, `pendingPrice`, `hidden`, `hiddenReason`, `approvalNote` (with a missing-column fallback). The admin menu manager's status chips were not added (admins see moderation in the Manager app).
- Shared `VendorNotificationCategory` unchanged: status, document and listing pushes use `support`, stock uses `low_stock`.

**Deploy order:** the website's live-dish filters read 0146's columns, so 0145 and 0146 must be applied before this code is deployed (as for 0142–0144).

**Verification:** every `scripts/qa/sql/migration-*.mjs` (0145: 63, 0146: 52, order: 19), `ops-sql-parity.ts` 144, `manager-vendor-product-rules` 50, `manager-vendors` 48, `manager-vendor-actions` 50, `manager-products` 32, `manager-product-actions` 19, `manager-order-actions` 37, `manager-scope` 24, `role-features` 27, `platform-separation` 38, `search-payload` 41; `tsc --noEmit` clean; eslint clean on touched paths; `next build` passes. Not run: `test:idor` and the signed-in live sections (no QA manager credentials; migrations not applied anywhere).

### Task S1: Migration 0145 — vendors

**Files:**
- Create: `supabase/migrations/0145_manager_vendors.sql`, `scripts/qa/sql/migration-0145.mjs`
- Modify: `docs/DATABASE.md`

**Interfaces — Consumes:** `ops_require_staff(uuid, uuid) returns text`, `_ops_set_actor(uuid)` (0142), `_ops_log(...)` (0141), `manager_can_see_zone(uuid)` (0141), `support_tickets` (0143 / Rider 0087).

**Interfaces — Produces (database):**
- `alter type public.vendor_status add value if not exists 'rejected'` — **before** the migration's `begin;` (it cannot share a transaction with code that uses the value).
- `restaurants.status_reason text`, `status_changed_by uuid → profiles`, `status_changed_at timestamptz` — not granted to anon/authenticated (read through the service role); `lock_restaurant_privileged_fields()` re-declared from its latest definition with these three added to the admin-only branch.
- `vendor_documents.status text not null default 'pending' check in ('pending','verified','rejected')`, `remarks text check ≤ 500`, `reviewed_by uuid → profiles`, `reviewed_at timestamptz`; existing rows stay `pending`.
- Manager read policies (permissive, `select` only): `"restaurants — manager read"` `using (manager_can_see_zone(zone_id))`; `"vendor_documents — manager read"`, `"reviews — manager read"`, `"review_replies — manager read"`, `"store_holidays — manager read"` through the restaurant's `zone_id`.
- `support_tickets.restaurant_id uuid → restaurants on delete set null`, index `(restaurant_id, created_at desc)`; `before insert` trigger `stamp_ticket_restaurant()`: from `orders.restaurant_id` when `order_id` is set, else the requester's oldest owned shop when the requester's profile role is `restaurant`; backfill existing rows the same way.
- RPCs (all replay-safe on `p_client_action_id`, all `returns jsonb`):
  - `ops_set_vendor_status(p_actor uuid, p_restaurant uuid, p_action text, p_expected public.vendor_status, p_reason text, p_override boolean, p_client_action_id text)` → `{ "restaurant_id", "status" }`. Locks the row `for update`; zone check; reason 3–300 (`reason_required`); `stale` if status ≠ expected; transition table from *Claude's calls* else `invalid_transition`; approve/reactivate: `needs_map_pin` when `lat` or `lng` is null; approve: `documents_unverified` (`detail` = comma list of missing of `fssai`, `bank_proof` not `verified`) unless `p_override`; writes `status`, `status_reason`, `status_changed_by`, `status_changed_at`; `_ops_log` action `vendor.<action>`, `before`/`after` with statuses and `documents_override`.
  - `ops_review_vendor_document(p_actor, p_document uuid, p_decision text, p_remarks text, p_client_action_id)` — decision `verified|rejected`; remarks required for `rejected`; zone via the document's restaurant; action `vendor.document.<decision>`.
  - `ops_onboard_vendor(p_actor, p_owner uuid, p_zone uuid, p_shop jsonb, p_menu jsonb, p_client_action_id)` → `{ "restaurant_id", "slug" }` — `ops_require_staff(p_actor, p_zone)`; inserts the restaurant (`status 'pending'`, `zone_id = p_zone`, whitelisted keys of `p_shop` only — never commission or payment terms) and any `p_menu` items; action `vendor.onboard`.
  - `ops_add_ticket_message(p_actor, p_ticket uuid, p_body text, p_internal boolean, p_client_action_id)` — zone via the ticket's `zone_id`; inserts the message (`author_role` = actor role); sets `first_response_at` on the first non-internal staff message; moves `open → in_progress` on the first staff reply; action `ticket.message` (`after.internal`).
  - `ops_set_ticket_status(p_actor, p_ticket, p_status text, p_resolution text, p_client_action_id)` — `resolved|closed` need a resolution 3–1000 and set `resolved_at`; `closed` is final (`invalid_transition`); action `ticket.status`.
- Rollback block (enum values cannot be dropped: say so; everything else dropped / restored).

- [ ] **Step 1: Write `migration-0145.mjs`** (PGlite, prior migrations' stubs as `migration-0142.mjs` does). Assertions (`ok`/`FAIL`, exit 1 on FAIL):
  - manager M (zone A) as service role: `ops_set_vendor_status(M, shopA, 'suspend', 'active', 'Hygiene complaint', false, 'c1')` → `suspended`, `approved = false`, `status_reason` set, one audit row `vendor.suspend`; replay `c1` → same, still one row.
  - `reactivate` with `expected 'active'` → `stale`; reason `''` → `reason_required`; `reject` on an `active` shop → `invalid_transition`.
  - approve a `pending` shop with no pin → `needs_map_pin`; pinned but documents unverified → `documents_unverified` with detail `fssai,bank_proof`; same with override → `active`, audit `after.documents_override = true`; after verifying both documents (`ops_review_vendor_document`) approve without override → ok.
  - `reject` → status `rejected`; approve from `rejected` → allowed.
  - M on shopB (zone B) → `forbidden`; `authenticated` role calling any RPC → permission denied.
  - shop owner updating `status_reason` or `zone_id` directly → raises.
  - document reject without remarks → `reason_required`.
  - `ops_onboard_vendor` into zone B by M → `forbidden`; into zone A with `p_shop` containing `commission_pct: 1` → shop created `pending` with the default commission.
  - manager M (authenticated JWT) selects shopA, its documents and reviews; selects none of shopB's.
  - ticket with an order of shopA → `restaurant_id = shopA`; ticket raised by shopA's owner without an order → `restaurant_id = shopA`; first staff reply sets `first_response_at` and `in_progress`; internal message does not; `resolved` without resolution → `reason_required`; `closed` then `in_progress` → `invalid_transition`.
- [ ] **Step 2: Run** `node scripts/qa/sql/migration-0145.mjs` — FAIL (file missing).
- [ ] **Step 3: Write the migration** (house-style header: purpose, STATUS: PENDING APPROVAL, security notes, rollback).
- [ ] **Step 4: Run the 0145 proof and every SQL proof — all `ok`.**
- [ ] **Step 5: Update `docs/DATABASE.md`; commit** `feat(db): 0145 manager vendors — rejected status, provenance, document review, zone reads, ticket link, audited RPCs`.

### Task S2: Vendor and product rules (pure)

**Files:**
- Create: `src/lib/ops/vendor-rules.ts`, `src/lib/ops/product-rules.ts`, `scripts/qa/manager-vendor-product-rules.ts` (add `"test:manager-vp-rules"` to `package.json`)

**Interfaces — Produces:**
```ts
export type VendorStatus = "pending" | "active" | "inactive" | "suspended" | "rejected";
export type VendorAction = "approve" | "reject" | "suspend" | "reactivate";
export const REQUIRED_DOCUMENTS = ["fssai", "bank_proof"] as const;
export function nextVendorStatus(from: VendorStatus, action: VendorAction): VendorStatus | null;
export function allowedVendorActions(v: { status: VendorStatus }, perms: Record<string, boolean>): { approve: boolean; reject: boolean; suspend: boolean; reactivate: boolean; reviewDocuments: boolean; uploadDocuments: boolean };
export function missingRequiredDocuments(docs: { type: string; status: string }[]): string[];
export function vendorRates(orders: { status: string; cancelledBy: string | null; createdAt: string; acceptedAt: string | null; readyAt: string | null }[]):
  { orders: number; cancellationRate: number; rejectionRate: number; avgAcceptMinutes: number | null; avgPrepMinutes: number | null };
export function ratingDistribution(ratings: number[]): Record<"1" | "2" | "3" | "4" | "5", number>;

export const FREQUENT_UNAVAILABLE_TIMES = 3;
export const FREQUENT_UNAVAILABLE_HOURS = 24;
export interface AvailabilityChange { itemId: string; at: string; to: boolean }  // `available` changes, any order
export function availabilityStats(itemId: string, changes: AvailabilityChange[], currentAvailable: boolean, range: { start: Date; endExclusive: Date }):
  { timesUnavailable: number; hoursUnavailable: number };
export function frequentlyUnavailable<T extends { id: string; available: boolean }>(items: T[], changes: AvailabilityChange[], range: { start: Date; endExclusive: Date }):
  { item: T; timesUnavailable: number; hoursUnavailable: number }[];
export function isRestrictedCategory(category: string | null, restricted: readonly string[]): boolean; // trim + case-insensitive
export function priceChangePct(from: number, to: number): number | null;       // null when from = 0
export function allowedProductActions(p: { approvalStatus: string; hidden: boolean; openFlags: number }, perms: Record<string, boolean>):
  { flag: boolean; hide: boolean; unhide: boolean; approve: boolean; reject: boolean; adjustStock: boolean };
export function rankSellers<T extends { units: number; revenue: number }>(rows: T[], dir: "top" | "slow", limit: number): T[];
```

- [ ] **Step 1: Write the QA script** (house style): transitions table (approve from pending/rejected → active; reject from active → null; suspend from inactive → suspended; reactivate from pending → null); `allowedVendorActions` hides everything without `manager.vendors.status` and `uploadDocuments` needs `manager.vendors.onboard`; `missingRequiredDocuments` with fssai verified, bank_proof rejected → `["bank_proof"]`; `vendorRates` on 10 orders with 2 cancelled (1 by vendor) → 0.2 / 0.1, accept mean over accepted only, null with none; distribution counts; `availabilityStats` — unavailable since before the range with no changes in range → full range hours, `timesUnavailable` 0; available → off at 10:00 → on at 14:00 in range → 1 time, 4 h; no changes ever and currently unavailable → full range; changes given out of order are sorted; a change exactly at `endExclusive` ignored; `frequentlyUnavailable` thresholds (3 times or 24 h) and sort by hours; `isRestrictedCategory(" Liquor ", ["liquor"])` true, null false; `priceChangePct(160,180)` 12.5, `(0,10)` null; `allowedProductActions` (flag with `products.view`, hide needs `products.moderate`, approve only when pending, adjustStock only with `products.adjust_stock`); `rankSellers` slow puts zero units first.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; eslint on the files.**
- [ ] **Step 5: Commit** `feat(ops): vendor and product rules — transitions, documents, rates, availability, sellers`.

### Task S3: Vendor list and detail — data layer, contract, routes

**Files:**
- Create: `src/lib/ops/vendor-contract.ts` (types for every pinned vendor/ticket/review shape + serialisers), `src/lib/data-access/manager-vendors.ts`, `src/app/api/manager/vendors/route.ts` (GET; POST in S4), `src/app/api/manager/vendors/[id]/route.ts`, `.../[id]/reviews/route.ts`, `.../[id]/documents/[docId]/url/route.ts`, `.../[id]/complaints/route.ts`, `scripts/qa/manager-vendors.ts` (add `"test:manager-vendors"`)
- Modify: `src/lib/data-access/vendor-documents.ts` (expose review columns; `signedDocumentUrl(path, seconds)`), `src/lib/data-access/admin-vendors.ts` (`VendorStatus` includes `rejected`; admin list labels it), admin vendor UI files that switch on status (add `rejected` label/tone)

**Interfaces — Produces:**
- `parseVendorQuery(params: URLSearchParams): { ok: true; query: VendorQuery } | { ok: false; field: string }`; `encodeNameCursor(name: string, id: string)`, `decodeNameCursor(s: string)`.
- `listManagerVendors(scope: ManagerScope, q: VendorQuery, now: Date): Promise<{ items: VendorListItem[]; nextCursor: string | null; counts: VendorCounts }>` — open state for the page in one `restaurant_open_statuses(ids)` call (0062); today's orders, pending documents and open complaints in one grouped read each.
- `getManagerVendorDetail(scope: ManagerScope, id: string, ctx: { permissions: Record<string, boolean>; now: Date }): Promise<VendorDetail | null>` — performance over the last 30 IST days via `loadMetricOrders` (vendor-filtered) + `salesSummary` + `vendorRates`; `finance` only with `manager.finance.view`, using `vendorEarnings(...).byVendor[id]`, `platformCommission`, latest 10 settlements; `allowed` from `allowedVendorActions`.
- `listVendorReviews(scope, id, cursor, limit)`, `listVendorComplaints(scope, id, status, cursor)`, `vendorDocumentUrl(scope, id, docId)`.
- Explicit column lists only; no bank, PAN, GST, credential columns selected.

- [ ] **Step 1: Write `scripts/qa/manager-vendors.ts`:** pure — query parsing (`filter=online`, bad `status`, `limit=101`, short `q`), cursor round-trip, serialiser omits `finance` without `manager.finance.view` and never contains `bank_`, `pan_number`, `gst_number`, `upi_id` keys (walk the object), review serialiser emits first name only (`"Asha Verma"` → `"Asha"`), `openState` mapping from each `restaurant_status_now` value. Structural: every route file opens with `managerApiContext("manager.vendors.view")`; `manager-vendors.ts` has no `select("*")` and every `from("restaurants")` chain applies the scope. Live (skip when `BASE` unreachable or `QA_MANAGER_*` absent): 401 unauthenticated; out-of-zone id 404; signed URL expires in ≤ 60 s.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`.**
- [ ] **Step 5: Commit** `feat(api): manager vendors — list, detail, performance, finance, reviews, documents, complaints`.

### Task S4: Vendor actions, onboarding, documents upload, ticket routes

**Files:**
- Create: `src/lib/data-access/manager-vendor-actions.ts`, `src/lib/data-access/manager-tickets.ts`, `src/app/api/manager/vendors/[id]/actions/route.ts`, `.../[id]/documents/route.ts`, `src/app/api/manager/tickets/[id]/route.ts`, `.../[id]/messages/route.ts`, `.../[id]/status/route.ts`, `src/lib/notifications/vendor-ops.ts`, `scripts/qa/manager-vendor-actions.ts` (add `"test:manager-vendor-actions"`)
- Modify: `src/app/api/manager/vendors/route.ts` (POST), `src/lib/data-access/vendor-registration.ts` (`createVendorAccount(data, operatorId, opts?: { zoneId?: string; actor?: OpsActor })` inserts through `ops_onboard_vendor`; the admin wizard passes `{ actor: { id, role: "admin" } }`), `src/lib/data-access/admin-vendors.ts` (`setVendorStatus` → `ops_set_vendor_status` with the admin actor and a reason; the admin UI's status control asks for a reason)

**Interfaces — Produces:**
```ts
export const VENDOR_ACTION_PERMISSION: Record<"approve" | "reject" | "suspend" | "reactivate" | "verify_document" | "reject_document", FeatureKey>;
export async function opsVendorStatus(actor: OpsActor, id: string, action: VendorAction, expected: VendorStatus, reason: string, override: boolean, clientActionId: string): Promise<OpsResult>;
export async function opsReviewDocument(actor: OpsActor, vendorId: string, documentId: string, decision: "verified" | "rejected", remarks: string | null, clientActionId: string): Promise<OpsResult>;
export async function opsOnboardVendor(actor: OpsActor, scope: ManagerScope, input: OnboardInput, clientActionId: string): Promise<{ ok: true; id: string; slug: string; credentials?: { email: string; password: string } } | OpsResult>;
export async function opsUploadDocument(actor: OpsActor, scope: ManagerScope, vendorId: string, type: VendorDocType, file: File, clientActionId: string): Promise<{ ok: true; document: VendorDocument } | OpsResult>;
export async function getTicketThread(scope: ManagerScope, id: string): Promise<TicketThread | null>;
export async function opsTicketMessage(actor: OpsActor, id: string, body: string, internal: boolean, clientActionId: string): Promise<OpsResult>;
export async function opsTicketStatus(actor: OpsActor, id: string, status: string, resolution: string | null, clientActionId: string): Promise<OpsResult>;
export function mapVendorRpcError(e: { code?: string; message?: string; details?: string }): OpsResult; // extends Phase 3's mapRpcError: needs_map_pin, documents_unverified (extra.missing)
export async function notifyVendorOps(restaurantId: string, kind: "status" | "document" | "listing" | "stock", text: { title: PushText; body: PushText }, url: string): Promise<void>;
```
- `OpsActor`, `OpsResult`, `mapRpcError` come from Phase 3 (`src/lib/data-access/manager-ops-actions.ts`); reuse, do not redefine.
- Upload: validate type and size before storage; storage path `restaurants/<id>/<uuid>-<safe name>`; then one RPC-equivalent insert + `_ops_log` (`vendor.document.upload`) through a small `ops_add_vendor_document` RPC added to 0145 if S1 is already committed → put it in **0145** while S1 is open, else in a new `0147` (same pattern).
- Notifications (deferred, after the RPC): owner pushed on status change, document decision; requester pushed on non-internal ticket replies and status changes (writes `user_notifications` when that table exists — probe with `columnKnownMissing` / `isMissingColumn` as Phase 1 does).

- [ ] **Step 1: Write the QA script:** pure — `mapVendorRpcError` for every code; body validation (`reason` "ok" → `reason_required`; missing `expected` for status actions → 400; `documentId` not uuid → 400; onboard with 9-digit mobile → 400 `field: "mobile"`; `zoneId` missing → 400); `VENDOR_ACTION_PERMISSION` equals the Global Constraints table; upload rejects `text/html` and 11 MB. Structural: `createVendorAccount` calls `ops_onboard_vendor` and contains no direct `from("restaurants").insert`; `setVendorStatus` calls `ops_set_vendor_status`; ticket routes open with `managerApiContext("manager.support.manage")`. Live (skip as S3): suspend then replay the same `clientActionId` → one change; suspend with a stale `expected` → 409.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`; `npm run test:platform`; walk `docs/SECURITY_AUDIT.md` (new RPCs, uploads, routes) and add a log row.**
- [ ] **Step 5: Commit** `feat(api): audited vendor status, document review, onboarding, uploads and ticket replies`.

### Task S5: Migration 0146 — products

**Files:**
- Create: `supabase/migrations/0146_manager_products.sql`, `scripts/qa/sql/migration-0146.mjs`
- Modify: `docs/DATABASE.md`

**Interfaces — Produces (database):**
- `menu_items` gains `approval_status text not null default 'approved' check in ('approved','pending','rejected')`, `approval_note text`, `pending_price integer check (pending_price >= 0)`, `hidden_by_ops boolean not null default false`, `hidden_reason text`, `moderated_by uuid → profiles`, `moderated_at timestamptz`, `updated_at timestamptz` (maintained by the guard).
- `public.listing_restricted_categories (name text primary key check (name = lower(btrim(name)) and char_length(name) between 1 and 60), note text, created_by uuid, created_at timestamptz default now())`; RLS on; select for admins and managers; writes service role only.
- `public.menu_item_changes (id bigint identity pk, menu_item_id uuid not null → menu_items on delete cascade, restaurant_id uuid not null, field text not null, old_value text, new_value text, source text not null check in ('vendor','ops','admin','system'), actor_id uuid, created_at timestamptz default now())`, indexes `(menu_item_id, created_at desc)`, `(restaurant_id, field, created_at desc)`. RLS: owner reads own shop's, admins all, managers by the shop's zone; writes revoked from anon/authenticated (trigger is `security definer`).
- `public.listing_flags (id uuid pk, menu_item_id uuid not null → menu_items on delete cascade, restaurant_id uuid not null, reason text not null check in ('inaccurate','inappropriate','wrong_image','wrong_price','wrong_category','other'), note text check ≤ 500, status text not null default 'open' check in ('open','resolved','dismissed'), raised_by uuid not null, raised_at timestamptz default now(), resolution text, resolved_by uuid, resolved_at timestamptz)`, index `(status, raised_at desc)`, partial unique `(menu_item_id, reason) where status = 'open'`. RLS: owner reads own shop's flags; admins; managers by zone; writes service role only.
- Trigger `guard_menu_item_moderation()` (`before insert or update`, `security definer`): when the writer is not admin / service role / ops session (`current_setting('deligro.ops_moderation', true) = 'on'`): on insert force `approval_status` = `pending` if `isRestricted(category)` else `approved`, and `hidden_by_ops = false`, `pending_price = null`, moderation columns null; on update keep every moderation column at `old`; if the category is restricted and `new.price <> old.price` and the item was approved → `pending_price := new.price; price := old.price; approval_status := 'pending'`; if the category changed into a restricted one → `approval_status := 'pending'`. Always `updated_at := now()`.
- Trigger `log_menu_item_change()` (`after insert or update`, `security definer`): one row per changed field in the list from *Claude's calls*; `stock_qty` only when `pg_trigger_depth() = 1`; `source` = `ops` under the ops session flag, `admin` for `is_admin()`, `system` for service role without an actor, else `vendor`; `actor_id` = `coalesce(auth.uid(), deligro.actor_id)`.
- `"menu — read"` policy re-created: `(restaurant approved and approval_status = 'approved' and not hidden_by_ops) or owns_restaurant(restaurant_id) or is_admin() or manager_can_see_zone(<restaurant zone>)`.
- `guard_order_item_insert()` re-declared from its latest definition (0062 after P0) adding, before pricing: the dish must be `approval_status = 'approved'` and `not hidden_by_ops`, else raise `item_unavailable` (the same error the guard raises for an unavailable dish).
- RPCs (replay-safe, zone via the item's restaurant, each sets `deligro.ops_moderation = 'on'` locally before writing):
  - `ops_flag_listing(p_actor, p_item, p_reason text, p_note text, p_client_action_id)` → `{ "flag_id" }`; an open flag with the same reason returns that flag. Action `product.flag`.
  - `ops_set_listing_hidden(p_actor, p_item, p_hidden boolean, p_reason text, p_client_action_id)` — reason required; action `product.hide|unhide`.
  - `ops_decide_listing(p_actor, p_item, p_decision text, p_reason text, p_client_action_id)` — item must be `pending` (`invalid_transition`); approve: `approval_status='approved'`, apply and clear `pending_price`; reject: a never-approved item → `rejected`; a parked price → clear `pending_price`, back to `approved`; reason required for reject. Action `product.approve|reject`.
  - `ops_resolve_listing_flag(p_actor, p_flag uuid, p_status text, p_resolution text, p_client_action_id)` — `resolved|dismissed`, resolution required; action `product.flag.<status>`.
  - `ops_adjust_stock(p_actor, p_item, p_stock_qty integer, p_reason text, p_client_action_id)` — `p_stock_qty` ≥ 0 or null (stop tracking); reason required; 0062's `menu_stock_rules` then marks sold out / back on; action `product.stock`, `before`/`after` quantities.
  - `ops_set_restricted_category(p_actor, p_name text, p_restricted boolean, p_reason text, p_client_action_id)` — `ops_require_staff(p_actor, null)` semantics for a platform-wide list: allowed for admins and for managers (permission enforced by the route); action `product.restricted_category`.
- Rollback block.

- [ ] **Step 1: Write `migration-0146.mjs`:** owner inserts a dish in restricted category `liquor` → `pending`; anon / a customer cannot select it; ordering it → `item_unavailable`; manager approves → visible, orderable. Owner changes the price of an approved restricted dish 200 → 250 → `price` stays 200, `pending_price` 250, `pending`, still visible to customers at 200; approve → price 250, `pending_price` null; reject on another → price unchanged, `approved`. Owner `update menu_items set hidden_by_ops = false` on a hidden dish → still hidden; owner sets `approval_status = 'approved'` → unchanged. `ops_set_listing_hidden` → customer can't read or order it; owner still reads it with `hidden_reason`. History: price change by owner → one `price` row source `vendor`; ops stock adjust → `stock_qty` row source `ops` with actor; an order consuming stock (0062 `take_stock`) → **no** `stock_qty` row; availability toggle → `available` row. Flags: duplicate open flag with the same reason returns the same id; zone-B manager → `forbidden`; resolve without resolution → `reason_required`. `ops_adjust_stock(…, 0, …)` → item sold out by stock (0062 rule). Manager (authenticated, zone A) reads zone-A items including pending/hidden, none of zone B.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration. Step 4: Run the 0146 proof and every SQL proof — all `ok`.**
- [ ] **Step 5: Update `docs/DATABASE.md`; commit** `feat(db): 0146 manager products — moderation, restricted listings, change history, flags, audited RPCs`.

### Task S6: Product list, categories, detail, insights — data layer, contract, routes

**Files:**
- Create: `src/lib/ops/product-contract.ts`, `src/lib/data-access/manager-products.ts`, `src/app/api/manager/products/route.ts`, `.../categories/route.ts`, `.../[id]/route.ts`, `.../insights/route.ts`, `scripts/qa/manager-products.ts` (add `"test:manager-products"`)
- Modify: `src/app/api/manager/stats/route.ts` and its data function (`vendor=` filter; `manager.vendors.view` when present)

**Interfaces — Produces:**
- `parseProductQuery(params): { ok: true; query: ProductQuery } | { ok: false; field: string }`.
- `listManagerProducts(scope, q): Promise<{ items: ProductListItem[]; nextCursor: string | null; counts: ProductCounts }>` — `out_of_stock` = `sold_out_by_stock` or `stock_qty = 0`; `low_stock` = tracked and `stock_qty <= low_stock_at` and > 0; `unavailable` = `available = false`.
- `listProductCategories(scope, vendor?)`, `getManagerProductDetail(scope, id, ctx)` (sales over the last 30 IST days from `order_items` of non-cancelled orders joined by `menu_item_id`; `rankInVendor` by units; `availability` via `availabilityStats`; variants and add-ons from 0062 tables), `getProductInsights(scope, range, vendor?)` (`frequentlyUnavailable`, `priceChanges` = `menu_item_changes` `field='price'` in range newest first, top/slow sellers via `rankSellers` over available items, `outOfStock`).

- [ ] **Step 1: Write the QA script:** pure — query parsing; counts definitions on fixture rows; insights builder (export `buildProductInsights(rows, range)`) — a dish with zero sales appears in slow sellers, a hidden dish does not appear in top sellers, a price change outside the range is excluded, `changePct` computed; detail serialiser includes `pendingPrice` and `hiddenReason`. Structural: routes open with `managerApiContext("manager.products.view")`; every `from("menu_items")` chain in the module is scoped through its restaurant's zone. Stats route: `vendor` param out of scope → 404 (live, skip as before).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`.**
- [ ] **Step 5: Commit** `feat(api): manager products — list, categories, detail with history and sales, insights; vendor stats filter`.

### Task S7: Product actions, restricted categories, customer-surface filters

**Files:**
- Create: `src/lib/data-access/manager-product-actions.ts`, `src/app/api/manager/products/[id]/actions/route.ts`, `src/app/api/manager/products/restricted-categories/route.ts`, `scripts/qa/manager-product-actions.ts` (add `"test:manager-product-actions"`)
- Modify (customer-visible service-role menu reads gain `.eq("approval_status", "approved").eq("hidden_by_ops", false)`): `src/lib/data-access/manager-phone-orders.ts`, `src/lib/data-access/orders.ts` (menu lookup for pricing), and every other `from("menu_items")` found by `grep -rn 'from("menu_items")' src` whose result reaches a customer or a phone order; vendor and admin menus keep showing everything with a status chip (`src/app/admin/vendors/[id]/menu-manager.tsx`: "Pending approval", "Hidden by Deligro" labels); the Partner API's menu list (`src/app/api/vendor/menu/**`) returns `approvalStatus`, `pendingPrice`, `hidden`, `hiddenReason` so the vendor app can show them.

**Interfaces — Produces:**
```ts
export const PRODUCT_ACTION_PERMISSION: Record<"flag" | "hide" | "unhide" | "approve" | "reject" | "resolve_flag" | "dismiss_flag" | "adjust_stock", FeatureKey>;
export async function opsProductAction(actor: OpsActor, scope: ManagerScope, id: string, input: ProductActionInput, clientActionId: string): Promise<OpsResult>;
export async function listRestrictedCategories(): Promise<{ name: string; note: string | null; createdAt: string }[]>;
export async function opsSetRestrictedCategory(actor: OpsActor, name: string, restricted: boolean, reason: string, clientActionId: string): Promise<OpsResult>;
```
- Owner pushed (`notifyVendorOps`, kind `listing` / `stock`) on flag, hide, decision and stock adjustment.

- [ ] **Step 1: Write the QA script:** pure — body validation per action (`adjust_stock` with `-1` → 400; `flag` without `flagReason` → 400; `resolve_flag` without `flagId` → 400; `hide` with a 2-char reason → `reason_required`); `PRODUCT_ACTION_PERMISSION` matches the Global Constraints table (flag → `manager.products.view`). Structural: every customer-facing `from("menu_items")` (the files listed above) contains both filters — a regex check over those files, failing with the file name; route opens with `managerApiContext` keyed per action. Live (skip as before): flag twice with the same reason → same flag id.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`; `npm run test:search-payload`; `next build`; SECURITY_AUDIT log row (RLS change on `menu_items`, new tables).**
- [ ] **Step 5: Commit** `feat(api): audited product moderation and stock adjustment; customer surfaces hide pending and hidden dishes`.

---

# Part A — app (worktree `deligro-manager-p4a`)

Part A never calls a real server in tests: every screen gets its data through `VendorsRepository`, `ProductsRepository`, `TicketsRepository`, overridden with fakes in tests. Routes live under `/more/vendors`, `/more/products`, `/more/tickets/:id` (replacing the Phase 1 placeholders for Vendors and Products; Support stays a Phase 8 placeholder).

### Task A1: Models, repositories, fixtures

**Files:**
- Create: `apps/manager/lib/models/vendors.dart`, `apps/manager/lib/models/products.dart`, `apps/manager/lib/models/tickets.dart`, `apps/manager/lib/data/vendors_repository.dart`, `apps/manager/lib/data/products_repository.dart`, `apps/manager/lib/data/tickets_repository.dart`, `apps/manager/test/fixtures/api/{vendors_list,vendor_detail,vendor_reviews,ticket_thread,products_list,product_detail,product_categories,product_insights}.json`, `apps/manager/test/fakes/fake_vendor_product_repositories.dart`, `apps/manager/test/vendor_product_models_test.dart`
- Modify: `apps/manager/pubspec.yaml` (add `file_picker`, `image_picker` if absent; `url_launcher` if absent), `apps/manager/lib/state/providers.dart`

**Interfaces — Produces:**
- Models with lenient `fromJson` (unknown enum → `.unknown`): `VendorListItem`, `VendorDetail` (+ `VendorContact`, `VendorAddress`, `VendorHours`, `Holiday`, `VendorRegistration`, `VendorPerformance`, `VendorFinance?`, `SettlementRow`, `VendorAllowed`), `VendorDocument`, `ReviewItem`, `TicketSummary`, `TicketThread`, `TicketMessage`, `VendorPage { items, nextCursor, counts }`, `ProductListItem`, `ProductDetail`, `ProductChange`, `ListingFlag`, `ProductSales`, `ProductAllowed`, `ProductPage`, `CategoryRow`, `ProductInsights`.
- `VendorFilters` / `ProductFilters` (immutable, `copyWith`, `toQuery()`, `fromUri(Uri)` — understands the dashboard's `/more/vendors?filter=active|online`).
- `abstract interface class VendorsRepository { Future<VendorPage> list(VendorFilters f, {String? cursor}); Future<VendorDetail> detail(String id); Future<ReviewPage> reviews(String id, {String? cursor}); Future<String> documentUrl(String id, String docId); Future<TicketPage> complaints(String id, {String? cursor}); Future<ActionOutcome<VendorDetail>> act(String id, VendorAction a); Future<OnboardResult> onboard(OnboardDraft d); Future<VendorDocument> upload(String id, String type, XFile file, String clientActionId); }`; `ProductsRepository { list; categories; detail; insights; act; restricted(); setRestricted(...) }`; `TicketsRepository { thread(id); reply(id, body, internal, cid); setStatus(id, status, resolution, cid) }`; `Api*` implementations over `ApiClient`.
- `VendorAction` (sealed: `Approve(expected, override)`, `Reject(expected)`, `Suspend(expected)`, `Reactivate(expected)`, `VerifyDocument(docId)`, `RejectDocument(docId)`), `ProductAction` (sealed: `Flag(flagReason)`, `Hide`, `Unhide`, `Approve`, `Reject`, `ResolveFlag(flagId)`, `DismissFlag(flagId)`, `AdjustStock(int?)`), each with `reason` and a `clientActionId` created once per intent and reused on retry. Reuse Phase 3's `ActionOutcome` (generic over the returned detail) — generalise it here if Phase 3 made it order-specific.

- [ ] **Step 1: Write `vendor_product_models_test.dart`:** every fixture parses; a vendor detail **without** `finance` parses with `finance == null`; `rejected` status parses; unknown status → `.unknown`; `VendorFilters.fromUri('/more/vendors?filter=online')` → `filter == online`; `toQuery()` round-trips; a product with `stockQty: null` → "not tracked"; `ApiVendorsRepository.act` maps 409 `{"error":"documents_unverified","missing":["fssai"]}` to `ActionRefused('documents_unverified', ['fssai'])`; an `Approve` retried keeps its `clientActionId`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze` clean.**
- [ ] **Step 5: Commit** `feat(manager-app): vendor, product and ticket models, repositories, contract fixtures`.

### Task A2: Vendors list

**Files:**
- Create: `apps/manager/lib/state/vendors.dart`, `apps/manager/lib/features/vendors/vendors_screen.dart`, `.../vendor_tile.dart`, `.../vendor_filters_sheet.dart`, `apps/manager/test/vendors_screen_test.dart`
- Modify: `apps/manager/lib/router.dart` (`/more/vendors` with query params), `apps/manager/lib/features/shell/nav.dart` (Vendors no longer a placeholder)

**Interfaces — Produces:** `vendorFiltersProvider`, `vendorListProvider` (`AsyncNotifier` with `loadMore()`, `refresh()`); screen: search (debounced 400 ms), status tabs **All · Pending (n) · Active (n) · Suspended (n) · Rejected (n) · Inactive (n)**, chips "Open now", "Needs attention", zone, category; tile: logo, name, open-state dot and word, status (`StatusText`-style dot + word, not a capsule), rating, today's orders (JetBrains Mono), badges for pending documents and open complaints; infinite scroll at 80 %; pull to refresh; skeleton, filtered-empty dashed line, error + Retry; "Add vendor" FAB only when `manager.vendors.onboard`; ≥ 840 dp list + detail.

- [ ] **Step 1: Write `vendors_screen_test.dart`** (fake repo): first page renders and requests `cursor: null`; scrolling loads the next cursor and stops at null; tapping "Pending (3)" requests `status=pending`; route `/more/vendors?filter=online` opens with "Open now" active; typing "spi" requests `q=spi` once after debounce; empty filtered result shows the dashed line; error → Retry re-calls; FAB hidden without `manager.vendors.onboard`, visible with it.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): Vendors list — search, status tabs, filters, paging`.

### Task A3: Vendor detail — overview, documents, reviews, finance, complaints, actions

**Files:**
- Create: `apps/manager/lib/features/vendors/vendor_detail_screen.dart`, `.../vendor_overview_tab.dart`, `.../vendor_documents_tab.dart`, `.../vendor_reviews_tab.dart`, `.../vendor_finance_tab.dart`, `.../vendor_complaints_tab.dart`, `.../vendor_actions.dart`, `apps/manager/lib/widgets/contact_buttons.dart`, `apps/manager/test/vendor_detail_test.dart`
- Modify: `apps/manager/lib/router.dart` (`/more/vendors/:id`), `apps/manager/lib/features/stats/stats_screen.dart` (accepts `vendorId`, title shows the shop; `/stats?vendor=<id>`)

**Interfaces — Produces:**
- Header: name, status word with reason and "changed by … on …", open state, zone, rating; actions row showing only `allowed`: **Approve / Reject / Suspend / Reactivate** — each through Phase 3's `showReasonDialog` (required) with quick picks (approve: "Documents verified", "Store inspected"; reject: "Documents invalid", "Outside service area", "Duplicate registration"; suspend: "Hygiene complaint", "Repeated cancellations", "Pending dues", "Owner request"; reactivate: "Issue resolved", "Owner request"); Approve that comes back `documents_unverified` shows the missing documents and offers "Approve anyway" which resends with `override: true` and the same `clientActionId`; `needs_map_pin` → "Pin the shop on the map first (Admin → Vendors → Edit)".
- Tabs: **Overview** (contact with Call / WhatsApp via `contact_buttons.dart` — `tel:` and `https://wa.me/91…`; address with a small `flutter_map` pin; hours, weekly off, holidays, temporary closing, delivery/pickup; registration details; performance figures for the last 30 days with cancellation and rejection rates and a rating distribution bar; links "Orders" → `/orders?vendor=<id>` and "Sales statistics" → `/stats?vendor=<id>`), **Documents** (list with status; tap → opens the signed URL in an in-app viewer (images) or the system viewer (PDF); Verify / Reject with remarks when `reviewDocuments`; Upload when `uploadDocuments`), **Reviews** (paged, rating, sub-ratings, first name, reply), **Finance** (only when the payload has it: commission, GST, other charges, cycle, pending payment, recoverable, settlements list with status and reference), **Complaints** (ticket summaries → `/more/tickets/:id`).

- [ ] **Step 1: Write `vendor_detail_test.dart`:** fixture renders name, status reason and the performance rates as percentages; Finance tab absent for a fixture without `finance`; only allowed actions appear; Suspend opens the reason dialog, Submit disabled under 3 chars, then calls `act(Suspend(expected: 'active'))`; Approve → `ActionRefused('documents_unverified', ['fssai'])` shows "FSSAI licence not verified" and "Approve anyway" resends with `override: true` and the same id; `stale` → "Someone else changed this vendor" and a refresh; document Reject requires remarks; Call button launches `tel:+91…` (fake launcher); "Orders" navigates to `/orders?vendor=<id>`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): vendor detail — overview, documents, reviews, finance, complaints, audited actions`.

### Task A4: Vendor onboarding

**Files:**
- Create: `apps/manager/lib/features/vendors/onboard/onboard_flow.dart`, `.../onboard_steps.dart`, `.../map_pin_picker.dart`, `apps/manager/lib/state/onboard_draft.dart`, `apps/manager/test/vendor_onboard_test.dart`
- Modify: `apps/manager/lib/router.dart` (`/more/vendors/new`)

**Interfaces — Produces:** five steps — **Shop** (name, category, description, zone from the manager's zones), **Owner** (name, 10-digit mobile, email, optional password ≥ 8), **Location** (address, landmark, pincode, map pin with "Use my location"), **Hours** (opening, closing, weekly off, delivery, pickup), **Documents** (type + file/photo for each, optional now) → **Review & submit**. Draft kept in memory and in `SharedPreferences` (`manager-onboard-draft`) until submitted or discarded; submit sends one `clientActionId`; on 201 shows generated credentials once with Copy and a warning that they will not be shown again, then uploads chosen documents one by one (progress, retry per file) and opens the new vendor.

- [ ] **Step 1: Write `vendor_onboard_test.dart`:** Next disabled until required fields of each step are valid (9-digit mobile rejected with a message); zone defaults to the only zone when the manager has one; submit calls `onboard` once even if tapped twice; 409 `phone_taken` returns to the Owner step with "This mobile number already has an account"; generated credentials are shown with Copy; a failed document upload shows Retry for that file only; the draft survives a rebuild of the flow (prefs fake).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): onboard a vendor — shop, owner, pin, hours, documents`.

### Task A5: Ticket thread (generic)

**Files:**
- Create: `apps/manager/lib/features/support/ticket_thread_screen.dart`, `apps/manager/lib/state/tickets.dart`, `apps/manager/test/ticket_thread_test.dart`
- Modify: `apps/manager/lib/router.dart` (`/more/tickets/:id`), `apps/manager/lib/core/push.dart` (ticket pushes → `/more/tickets/<id>`)

**Interfaces — Produces:** header (number, subject, category, priority, status, shop link, order link → `/orders/<id>`), messages oldest first (internal notes tinted with an "Internal note" label), attachments opening signed URLs, composer with **Reply / Internal note** toggle, status menu (In progress, Waiting on requester, Resolved, Closed — Resolved and Closed ask for a resolution); 10 s polling while open.

- [ ] **Step 1: Write `ticket_thread_test.dart`:** internal messages show the label; sending with the toggle on calls `reply(internal: true)`; Resolve requires a resolution of ≥ 3 chars; a closed ticket hides the composer and the status menu; retry after a network error reuses the same `clientActionId`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): ticket thread — replies, internal notes, status with resolution`.

### Task A6: Products — list, categories, detail, insights, moderation, stock

**Files:**
- Create: `apps/manager/lib/state/products.dart`, `apps/manager/lib/features/products/products_screen.dart`, `.../product_tile.dart`, `.../product_filters_sheet.dart`, `.../product_categories_screen.dart`, `.../product_detail_screen.dart`, `.../product_history.dart`, `.../product_insights_screen.dart`, `.../restricted_categories_screen.dart`, `.../stock_dialog.dart`, `apps/manager/test/products_screens_test.dart`
- Modify: `apps/manager/lib/router.dart` (`/more/products`, `/more/products/:id`, `/more/products/categories`, `/more/products/insights`, `/more/products/restricted`), `apps/manager/lib/features/shell/nav.dart`

**Interfaces — Produces:**
- List: search, quick tabs **All · Unavailable (n) · Out of stock (n) · Low stock (n) · Pending approval (n) · Flagged (n) · Hidden (n)**, filters (vendor, category, zone); tile with image, name, shop, price (pending price shown as "₹180 → ₹220 pending"), availability dot, stock ("12 left", "Not tracked", "Sold out"), approval / hidden / flag chips; paging as Orders.
- Categories screen: rows with item and unavailable counts, vendor count, restricted marker; tap → list filtered by category.
- Detail: image(s), description, variants and add-ons, price block, availability and stock, approval note / hidden reason, **History** (`ProductChange` list: "Price ₹160 → ₹180 · vendor · 12 Oct 14:20"), **Flags**, **Sales** (30 days: units, revenue, orders, rank in shop, daily bar chart with `fl_chart`), actions per `allowed`: Flag (reason picker + note), Hide / Unhide (reason dialog), Approve / Reject (reason; shows pending price), Resolve / Dismiss flag, Adjust stock (`stock_dialog.dart`: new quantity or "Stop tracking", reason required).
- Insights: range picker (7 / 30 / 90 days, custom), sections **Frequently unavailable** (times, hours), **Price changes** (from → to, %, source), **Top sellers**, **Slow sellers**, **Out of stock**; each row → detail.
- Restricted categories (only with `manager.products.moderate`): list, add (name + reason), remove (reason).

- [ ] **Step 1: Write `products_screens_test.dart`:** list renders a pending-price tile as "₹180 → ₹220 pending"; "Out of stock (4)" requests `availability=out_of_stock`; detail shows history rows in newest-first order with source words; actions limited to `allowed` (no Adjust stock without permission); Hide requires a reason; Adjust stock rejects a negative number and sends `null` for "Stop tracking"; insights shows "31.5 h unavailable" for the fixture; restricted categories screen hidden from the More/Products menu without `manager.products.moderate`; a 409 `invalid_transition` on Approve shows "This listing is no longer waiting for approval" and refreshes.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): Products — list, categories, detail with history and sales, insights, moderation, stock`.

### Task A7: Release build check (app half)

- [ ] **Step 1:** `flutter analyze`, `flutter test` (all), release APK with the F:\dev env (`flutter build apk --release --dart-define-from-file=env/prod.json`).
- [ ] **Step 2:** Install on `deligro_test`; cold start reaches login with no `E/flutter` or FATAL in logcat; golden/screenshot tests (fixture data) for Vendors list, Vendor detail (Overview and Documents), Onboarding step 3, Ticket thread, Products list, Product detail and Insights, light and dark, saved under the scratchpad and listed in the commit body.
- [ ] **Step 3: Commit** `test(manager-app): Phase 4 screens — release build and screenshots`.

---

## Part A execution notes

Executed 2026-10-21 in `deligro-manager-p4a` (`feat/manager-p4-app`), `apps/manager/` only. English only throughout (no `tr()`; the no-Devanagari test stays green).

**Commits:** `f61732d` A1 models/repositories/fixtures · `6317970` A2 Vendors list · `93d2123` A3 vendor detail (+ `/stats?vendor=`) · `c1b3200` A4 onboarding · `064b025` A5 ticket thread · `0f722fd` A6 Products · `51e9688` Part S contract notes + dark-mode amber · `b683a85` FAB style + screenshot harness.

**Verification:** `flutter analyze` clean; `flutter test` 233 passed; `flutter test test_screens --update-goldens` 30 screenshots (Phase 4: vendors list light/dark/tablet, vendor overview and documents light/dark, onboarding Location step light/dark, ticket thread light/dark, products list light/dark/tablet, product detail light/dark, insights light/dark) copied to the session scratchpad `manager-p4a/`; release APK (69.9 MB) installed on `deligro_test`, cold start reaches the English login, process alive, no FATAL / `E/flutter` in logcat. Signed-in screens on the device need `QA_MANAGER_*` and the migrations applied — not run.

**Claude's calls (Part A):**
- Phase 3's `ActionOutcome` is order-specific and sealed; widening it would have broken Phase 3's exhaustive switches, so a parallel generic `Outcome<T>` (`Applied<T>` / `Refused<T>`, `lib/models/outcome.dart`) carries vendor, product and ticket actions. `Refused.reasons` holds `missing` (documents) or `reasons`.
- `ApproveVendor.override` is the field `waiveDocuments` in Dart (a field named `override` shadows the annotation); the wire key is still `override`.
- Vendor detail tabs live in one file (`vendor_tabs.dart`) rather than five; actions in `vendor_actions.dart`. Ticket labels and the summary tile in `features/support/ticket_labels.dart` (Phase 8 reuses them).
- `Paged<T, C>` (`lib/state/paged.dart`) backs both new lists; its refresh keeps rows from later pages by id, never by position (the bug the Phase 3 review found in the Orders list is not repeated here).
- Seams for tests: `urlOpenerProvider` (call / WhatsApp / PDFs), `documentPickerProvider` (file or camera), `currentLocationProvider` (geolocator; ACCESS_FINE/COARSE_LOCATION added to the manifest).
- On Android `XFile.fromData` takes its name from `path`; the picker passes the file name as `path` for content-URI files.
- The onboarding draft persists everything except the password (`manager-onboard-draft`). A refusal about one field returns to its step with the message under the field; a refusal about the form (e.g. `stale`) shows on Review. A corrected form after any refusal gets a new `clientActionId`; a network retry keeps it. A replayed onboarding without `credentials` says they were shown once.
- `/stats?vendor=<id>&name=…` reuses the Statistics screen through a `vendorStatsProvider` family; the export title names the shop.
- New theme token `amberText` (deep ink in light mode, bright amber in dark): `popInk` is for text on a solid amber fill and vanished on the dark page.
- Route permissions: `/more/vendors/new` → `manager.vendors.onboard`, `/more/tickets/:id` → `manager.support.manage`, `/more/products/restricted` → `manager.products.moderate`.

**Contract gaps assumed around:**
- No vendor or category directory endpoint: the Vendors category filter and the Products vendor/category filters offer the values among rows already loaded (as Phase 3's Orders filters do).
- Restricted categories: `GET` returns names; the add dialog takes a free-text name (matched case-insensitively by the server).
- Category rows tap through to `/more/products?category=<name>`; the server's `"Uncategorised"` bucket is sent as that literal name.
- Flag: the contract has `flagReason` and `reason`; the app sends the manager's description as `reason` (shown as the flag's note).
- Document "verify" also asks for a short note (the contract requires `reason` on every action).

# Integration (in `F:\hub26\deligro-manager`, after both halves)

### Task I1: Merge, contract check, phase exit

**Files:**
- Modify: `scripts/qa/manager-contract-emit.ts` (Phase 3), `apps/manager/test/contract_test.dart`

- [ ] **Step 1: Merge** `feat/manager-p4-server`, then `feat/manager-p4-app` into `feat/manager-app` (resolve `package.json` script additions if any).
- [ ] **Step 2: Contract check.** Extend the emitter to run the S3/S4/S6 serialisers on in-file fixture rows (vendor in each status, with and without finance permission, a rejected document, a ticket thread with an internal note, products in each availability/approval state with a parked price, insights with each section non-empty) and write `apps/manager/test/fixtures/api/generated/{vendors_list,vendor_detail,vendor_reviews,ticket_thread,products_list,product_detail,product_categories,product_insights}.json`; extend `contract_test.dart` to parse each with the A1 models and assert every non-nullable model field is present and typed. Run `npx tsx scripts/qa/manager-contract-emit.ts && cd apps/manager && flutter test test/contract_test.dart` — PASS. Commit the generated fixtures.
- [ ] **Step 3: Phase exit:** every `scripts/qa/sql/migration-*.mjs` ok; `npm run test:manager-vp-rules`, `test:manager-vendors`, `test:manager-vendor-actions`, `test:manager-products`, `test:manager-product-actions`, plus Phase 2–3 scripts, `test:metrics`, `test:idor`, `test:platform`, `test:search-payload`; `npx tsc --noEmit`; `npm run lint`; `next build`; `flutter analyze`; `flutter test`; release APK on `deligro_test` (Vendors and Products reachable from More; signed-in flows need `QA_MANAGER_*` and the migrations applied — record if unavailable).
- [ ] **Step 4: Commit** `test(manager): Phase 4 contract check and phase exit`; remove both worktrees and branches.

## I1 result

- Merged `feat/manager-p4-server` (19bed9e) and `feat/manager-p4-app` (6ada0ea) into `feat/manager-app` with no conflicts. 0145/0146 add read policies only — managers still have no direct write on any table (Phase 3 fix kept).
- Contract gaps closed (80e8ff2): `GET /api/manager/vendors/directory` feeds the vendor pickers on Orders and Products; product category filters use the server list; a flag's description travels as `note` (server still accepts `reason`); verifying a document takes an optional `note`; restricted categories suggest existing categories with free-text fallback; the product filter sheet's buttons wrap instead of overflowing.
- Contract check (1168cd4): the emitter writes 11 Phase 4 answers from the routes' own serialisers (ticket thread and category aggregation moved into pure modules); `contract_phase4_test.dart` compares each with the app's hand fixtures key by key and parses it with the models. A renamed key fails it.
- Exit: 15 SQL proofs pass (0145: 63, 0146: 52, order: 19); 30 QA scripts pass (manager-api / vendor-api need a signed-in server and ran 0); `tsc` clean; eslint clean on touched paths; `next build` passes with `/api/manager/vendors/directory`; `flutter analyze` clean; `flutter test` 266 passed; release APK (69.9 MB) cold-starts on `deligro_test` to the English login, no FATAL / `E/flutter`.
- Not verified: signed-in screens on a device and the signed-in API halves (no QA manager credentials; migrations not applied anywhere).
