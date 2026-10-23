# Manager App — Phase 7: Marketing, Offers & Customers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor marketing requests with the five statuses, approval with remarks, scheduled campaigns (featured store, banner, seasonal/festival, sponsored product) with dates, budget and funding, real performance and attributed sales; promo codes a manager can create within their zones with validity, eligible vendors/zones/items, limits and funding, usage, server-side refusal and a change log; and customer management with permission-gated contact, order history, complaints, refunds, retention, feedback and suspension that every sign-in and order path enforces.

**Architecture:** Three migrations: `0160` (marketing requests — the Partner design's table, built here first — campaigns, campaign tracking, banner-click attribution, audited RPCs), `0161` (offers: validity start, multi-vendor/zone/item eligibility, change log by trigger, `price_coupon` re-declared, audited offer RPCs, manager read policy), `0162` (customers: zone-scoped manager read on `profiles` replacing 0023's blanket policy, caller lookup and contact reveal RPCs, account-status RPC, order-insert guard, retention facts RPC). Pure rules in `src/lib/marketing/*`, `src/lib/ops/offer-rules.ts`, `src/lib/metrics/customers.ts`; thin `/api/manager/*` routes serialise through one contract module per area. Customer surfaces (web and `apps/customer`) learn featured/sponsored labels, campaign tracking, item-eligible codes and the suspended/restricted refusals. The Flutter Manager app adds Marketing, Campaigns, Offers and Customers, coded against the JSON pinned below with fake repositories.

**Tech Stack:** Supabase Postgres (RPCs, RLS, triggers, storage bucket), Supabase Auth admin (`ban_duration`), Next.js route handlers (read `node_modules/next/dist/docs/` first), Flutter 3.47 / Riverpod 3 / go_router, `fl_chart`, `image_picker` (already used by Phase 4 uploads).

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (§8, §9, §10, Permissions, Audit log, §16). Earlier plans: phases 1–6 — Phase 1 (`managerApiContext`, `applyZoneScope`, `narrowScope`), Phase 2 (`ops-metrics.ts` loader; dashboard counts `marketing_requests` with `status = 'pending'` and `restaurant_id` in scope), Phase 3 (`ops_require_staff`, `_ops_set_actor`, `_ops_log`, `OpsActor`, `GET /api/manager/orders` and its query parser, contract emitter), Phase 4 (`manager_can_see_restaurant`, ticket thread/messages/status endpoints, `TicketSummary`), Phase 5 (`profiles.account_status|status_reason|status_changed_by|status_changed_at` in 0151 and its profile lock, `maskNumber`), Phase 6 (`RefundItem`, `POST /api/manager/finance/refunds/[id]/decide`, report registry `src/lib/reports/builders/marketing.ts` with fixed columns). Neighbouring: Partner design §6 Marketing requests and §9 Offers (`coupons.starts_at`).

## Execution layout — two halves in parallel

| Half | Worktree | Branch | Touches |
|---|---|---|---|
| **Part S (server + customer surfaces)** | `F:\hub26\deligro-manager-p7s` | `feat/manager-p7-server` | `supabase/`, `scripts/`, `src/`, `apps/customer/`, `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md`, `package.json` |
| **Part A (manager app)** | `F:\hub26\deligro-manager-p7a` | `feat/manager-p7-app` | `apps/manager/` only |

**Task P0** runs first in `F:\hub26\deligro-manager`. Both halves then branch from `feat/manager-app` at P0's last commit and share no files. When both are done: merge S, then A, into `feat/manager-app`, run **Task I1** there, then `git worktree remove` both and `git branch -d` both branches.

## Global Constraints

- Phase 1–6 Global Constraints apply unchanged (AGENTS.md rules, migrations 0141–0199 with **0160–0164 for this phase**, F:\dev build env, release-APK smoke test, commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never touch `F:\hub26\deligro`, `deligro-rider`, `deligro-vendor`; never bare `git stash`.
- English only — no Hindi (owner).
- **Every audited write is one RPC that changes and logs in the same transaction** (0142 pattern: `security definer set search_path = public`, `_ops_set_actor(p_actor)`, `ops_require_staff(p_actor, <zone>)` first, replay-safe on `p_client_action_id`, revoked from `public, anon, authenticated`, granted to `service_role`). A reason (3–300 chars) is required on every reject, cancel, end-early, deactivate, edit-after-start, suspend, restrict, reactivate and contact reveal.
- **Re-declared functions:** before re-declaring `price_coupon`, `apply_coupon_to_order`, `preview_coupon`, `guard_order_update`, the profile self-update lock (as 0151 left it), or any `profiles` policy, diff every definition across `supabase/migrations/` after P0 and keep all behaviour (0056's advisory lock, 0061/0141 locked columns, 0151 status columns); add only what this plan names.
- **Money units:** whole rupees (integers). Offers keep the existing funding values `platform | vendor` and existing settlement arithmetic — **this phase changes no settlement or metrics money formula** (see Claude's calls).
- **PII:** customer phone and email never appear in any manager payload except the contact-reveal response; list and detail carry `phoneMasked` (`"••••••3210"`, last 4) only. Full delivery addresses never appear in Phase 7 payloads (locality only). Customer identity never appears in campaign or offer performance (counts only). Walk-the-object tests enforce it.
- **Zone scope:** marketing requests and campaigns by `zone_id` (stamped from the restaurant, or chosen for a seasonal campaign); offers by their eligibility (`coupon_restaurants` / `coupon_zones`); customers by `manager_can_see_customer` (≥ 1 order in scope). Out-of-scope ids answer 404 `not_found`; `zone=` narrows, never widens.
- **Permissions per call** (`managerApiContext(key)` first):

| Call | Key(s) |
|---|---|
| `/api/manager/marketing/*` (read and write) | `manager.marketing.manage` |
| `/api/manager/offers/*` (read and write) | `manager.offers.manage` |
| `/api/manager/customers*` reads | `manager.customers.view` |
| `phone=` search, `POST …/contact` | `manager.customers.view` + `manager.customers.contact` |
| `POST …/customers/[id]/actions` | `manager.customers.view` + `manager.customers.suspend` |
| refund decision (linked from a customer) | Phase 6 route: `manager.finance.view` + `manager.finance.adjust` |
| caller lookup for phone orders | `manager.phone_orders` (web) |

## Claude's calls

- **Marketing requests are built here first, with a shape the Partner branch adopts.** The Partner design names `marketing_requests` but pins no columns; this plan pins them (S1) and adds a "Notes for other branches" entry so Partner phase 6 builds its vendor screens on this table instead of a second one. Vendors insert and read their own requests through RLS (so the Partner app needs no new route to start); managers may also record one **on a vendor's behalf** (`source = 'ops'`) after a phone call.
- **Request statuses** are exactly the spec's: `pending → approved | rejected`, `approved → in_progress → completed`. A request that becomes a campaign follows the campaign: `in_progress` at its start, `completed` at its end. A campaign cancelled **before** it starts sends its request to `rejected` with remarks `"Cancelled: <reason>"`; cancelled or ended early after start sends it to `completed`. Type `other` has no campaign: the manager moves it to `in_progress` / `completed` by hand with remarks.
- **Campaign states vs statuses.** `campaigns.status` stores `approved | in_progress | completed | cancelled` (what happened); the lists the spec asks for (active, expired) are a **state computed from the window**: `scheduled` (approved, before start), `active` (approved/in_progress, inside the window), `expired` (past end, or completed/cancelled). Customer-facing effects are computed **from the window at read time**, never from the stored status, so a missed cron run never leaves a campaign showing or hidden by mistake. A scheduler (`syncCampaignStates(now)`) only advances stored statuses and request statuses and sends the vendor notices; it runs from the dispatch sweep and, throttled to once a minute, from every marketing list read.
- **Featured store** campaigns do **not** write `restaurants.sort_position`. The customer feed applies an overlay at read time: `effectiveVendorPositions(manual, activeFeatured)` puts each active campaign's shop at its `slotPosition` and shifts manually pinned shops down, keeping `SLOT_COUNT = 10`. Two featured campaigns may not hold the same slot in overlapping windows (`slot_taken`, checked under an advisory lock). Admin → Vendors → Slots shows campaign-held slots as read-only "Campaign" rows.
- **Banner and seasonal** campaigns own one `banners` row (created by the campaign RPC with `starts_at`/`ends_at` = the window, `kind = 'sponsored'` when vendor-funded, `sponsor_name` = shop, `target_zones` = the zone slug); cancel or end early sets it `archived`. A seasonal campaign may cover several vendors (`campaign_vendors`) and may link one offer code whose validity is set to the campaign window.
- **Sponsored product** campaigns mark 1–20 dishes of one vendor. Dish ranking adds a fixed bonus (`SPONSORED_BOOST = 20` on top of the existing score in `src/lib/search/dishes.ts`) and every surface that shows the dish labels it **"Sponsored"** (honest labelling; web and the customer app). Featured-store cards held by a campaign show **"Featured"**.
- **Attribution.** Customer clients report impressions and clicks of campaign surfaces (`POST /api/campaigns/track`, stamped with the signed-in customer when there is one; anonymous impressions count, anonymous clicks attribute nothing). Banner clicks keep going to `/api/banners/track`, which now also stamps `customer_id`. An order is **attributed** to a campaign when it is non-cancelled, placed inside the window, and either (a) redeemed the campaign's linked offer code, or (b) is at the campaign's vendor (sponsored: contains a campaign dish) and its customer clicked the campaign's surface within the **24 h** before the order. Each order counts once per campaign. Featured and sponsored performance also shows the vendor's orders and sales in the window against the same-length period before it ("Before / During"), labelled as a comparison, not attribution.
- **Budget and funding are recorded, not billed.** `budget` (rupees) and `funded_by` (`vendor | deligro | shared`, with `vendor_share_pct` 1–99 for shared) are campaign records for §8.9. Offer discounts keep the existing `coupons.funded_by` (`platform | vendor`), which settlement maths already honours; a "shared" offer is not introduced (it would change settlement arithmetic — out of scope, noted for later).
- **Vendor consent.** A manager may create a **vendor-funded** offer, or a campaign funded `vendor`/`shared`, only by approving that vendor's marketing request (`request_id` required, request's vendor must match). Platform-funded offers and `deligro`-funded campaigns need no request. Platform-wide offers (no vendor and no zone restriction) are admin-only.
- **Offer eligibility.** New join tables `coupon_restaurants`, `coupon_zones`, `coupon_items`; the existing single `coupons.restaurant_id` keeps working (a code with `restaurant_id` set behaves as one row in `coupon_restaurants`). With `coupon_items`, the discount is computed on the **eligible lines' subtotal** only, and `min_order` is checked against the whole basket. `preview_coupon` gains an items-aware overload so checkout previews agree with the bill.
- **Change log by trigger.** `coupon_changes` is written by an `after insert or update or delete` trigger on `coupons` (and its three join tables), so vendor edits from the Partner app and admin edits are recorded too, actor from `auth.uid()` or `deligro.actor_id`. Manager writes additionally write `ops_audit_log` in their RPC.
- **No re-enabling an expired offer.** `activate` refuses `expired` unless the same edit sets a future `expiresAt`; managers must give every offer an `expiresAt` (≤ 366 days ahead).
- **Customer visibility for managers** = a customer with at least one order in the manager's zones (`manager_can_see_customer`). The blanket `"profiles — manager read"` (0023) is replaced by: self; customers visible as above; drivers via Phase 2's `manager_can_see_rider`; shop owners of restaurants in scope. The phone desk's caller lookup moves to `ops_lookup_caller(p_phone)` (security definer, manager/admin only, returns name and is-staff only) because a first-time caller has no order yet.
- **Suspended vs restricted.** `restricted`: can sign in, cannot place orders. `suspended`: cannot sign in and cannot place orders. Enforcement: a `before insert` trigger on `orders` refuses any customer whose `account_status <> 'active'` (every path, including phone orders and service role, error `account_restricted`); `/api/auth/otp/verify` and `/api/auth/password-login` refuse a suspended customer with 403 `account_suspended` before creating a session; after the suspend RPC commits, the route sets the user's Supabase Auth `ban_duration` to `"876000h"` (blocks email/password and refresh) and signs out their sessions; reactivate clears the ban (`"none"`). A ban failure returns 502 `effect_failed` with the status saved, retry-safe. Only `profiles.role = 'customer'` accounts can be changed here (`not_a_customer`).
- **Contact reveal** requires a reason from a short list (`order_issue | refund | complaint | delivery | other` + text for other); each reveal is one RPC returning the contact and writing `customer.contact_reveal`.
- **Retention** (§10.6) over the range and scope: `customers` (distinct with ≥ 1 non-cancelled order in range), `newCustomers` (first-ever in-scope order inside range), `returningCustomers` (= customers − new), `repeatRate` (customers with ≥ 2 non-cancelled orders in range ÷ customers), `ordersPerCustomer`, `aovPerCustomer`; monthly cohorts by IST month of first order (last 6 cohorts ending at `to`): `r30/r60/r90` = share of the cohort whose second non-cancelled order came within 30/60/90 days of the first, `null` until the cohort is that old.

## API contract (pinned — both halves code to this)

All responses JSON. Errors `{ "error": "<code>", ...extra }`: 400 `bad_request` (`field`), 403 `permission_denied`, 404 `not_found`, 409 `stale` (`current`), 409 conflict codes named per endpoint, 422 `reason_required`. A replayed `clientActionId` returns 200 with the current object and changes nothing. Cursor paging as Phase 3 (`cursor`, `limit` ≤ 100, keyset `(created_at desc, id desc)`).

### Shared shapes

```jsonc
// Ref
{ "id": "uuid", "name": "Spice Hub" }
// MarketingRequest
{ "id": "uuid", "number": 41, "vendor": Ref, "zone": Ref, "source": "vendor|ops",
  "type": "featured_store|banner|seasonal|sponsored_product|discount_offer|other",
  "title": "Diwali top slot", "details": "…", "preferredStart": "2026-11-01|null", "preferredEnd": "2026-11-07|null",
  "budget": 5000 /* or null */, "items": [Ref], "proposedOffer": OfferTerms /* or null; discount_offer only */,
  "attachmentUrl": "signed 60 s|null", "status": "pending|approved|rejected|in_progress|completed",
  "remarks": "…|null", "requestedBy": { "id": "uuid", "name": "…", "role": "restaurant|manager|admin" },
  "decidedBy": Ref /* or null */, "decidedAt": "…|null", "campaignId": "uuid|null", "offerCode": "DIWALI50|null",
  "createdAt": "…", "updatedAt": "…" }
// BannerFields
{ "headline": "1–60", "description": "0–140", "ctaLabel": "1–20", "targetType": "restaurant|product|category|food|external",
  "targetValue": "slug|url|null", "imageUrl": "https://…|null", "placements": ["home_top"] }
// CampaignSummary
{ "id": "uuid", "kind": "featured_store|banner|seasonal|sponsored_product", "title": "…", "zone": Ref,
  "vendors": [Ref], "status": "approved|in_progress|completed|cancelled", "state": "scheduled|active|expired",
  "startsAt": "…", "endsAt": "…", "budget": 5000, "fundedBy": "vendor|deligro|shared", "vendorSharePct": 40 /* or null */,
  "slotPosition": 2 /* or null */, "offerCode": "…|null", "requestId": "uuid|null",
  "headline": { "impressions": 1200, "clicks": 84, "attributedOrders": 9, "attributedSales": 3420 } }
// CampaignDetail = CampaignSummary & {
  "items": [Ref], "banner": BannerFields /* or null */, "notes": "…|null", "createdBy": Ref, "createdAt": "…", "updatedAt": "…",
  "cancelledReason": "…|null", "allowed": { "edit": true, "editWindowOnly": false, "cancel": true, "endNow": false, "uploadImage": true } }
// CampaignPerformance
{ "from": "2026-11-01", "to": "2026-11-07", "impressions": 1200, "clicks": 84, "ctr": 7.0,
  "redemptions": 12, "discountGiven": 960, "attributedOrders": 9, "attributedSales": 3420, "attributedCustomers": 8,
  "comparison": { "beforeOrders": 31, "beforeSales": 10450, "duringOrders": 44, "duringSales": 15210 } /* featured/sponsored, else null */,
  "daily": [{ "date": "2026-11-01", "impressions": 200, "clicks": 12, "attributedOrders": 1, "attributedSales": 380 }] }
// OfferTerms (also the body shape for create)
{ "code": "DIWALI50", "label": "Diwali ₹50 off|null", "kind": "percent|flat", "value": 50, "minOrder": 199,
  "maxDiscount": 100 /* or null */, "startsAt": "…|null", "expiresAt": "…", "maxPerCustomer": 1 /* or null */,
  "maxRedemptions": 500 /* or null */, "vendorIds": ["uuid"], "zoneIds": ["uuid"], "itemIds": ["uuid"],
  "fundedBy": "platform|vendor", "requestId": "uuid|null" }
// OfferSummary
{ "code": "DIWALI50", "label": "…|null", "kind": "percent|flat", "value": 50, "minOrder": 199, "maxDiscount": 100,
  "state": "scheduled|active|expired|inactive|exhausted", "active": true, "startsAt": "…|null", "expiresAt": "…|null",
  "fundedBy": "platform|vendor", "vendors": [Ref], "zones": [Ref], "itemCount": 0,
  "redemptions": 120, "maxRedemptions": 500, "discountGiven": 6000, "createdBy": Ref /* or null */, "updatedAt": "…" }
// OfferDetail = OfferSummary & { "maxPerCustomer": 1, "items": [Ref], "requestId": "uuid|null", "campaignIds": ["uuid"],
  "allowed": { "edit": true, "activate": false, "deactivate": true } }
// OfferUsage
{ "from": "…", "to": "…", "redemptions": 120, "uniqueCustomers": 110, "newCustomers": 41, "orders": 118,
  "cancelledRedemptions": 2, "discountGiven": 6000, "discountByFunder": { "vendor": 0, "platform": 6000 },
  "customerPaid": 48210, "remainingRedemptions": 380 /* or null */,
  "byVendor": [{ "vendor": Ref, "redemptions": 70, "discountGiven": 3500 }],
  "daily": [{ "date": "…", "redemptions": 9, "discountGiven": 450 }] }
// OfferChange
{ "id": "bigint-as-string", "at": "…", "actor": { "id": "uuid", "name": "…", "role": "admin|manager|restaurant|system" } /* or null */,
  "op": "insert|update|delete", "target": "coupon|vendor|zone|item",
  "fields": [{ "field": "maxDiscount", "before": "80", "after": "100" }], "reason": "…|null" }
// CustomerSummary
{ "id": "uuid", "shortId": "a1b2c3d4", "name": "Priya S.|null", "phoneMasked": "••••••3210|null",
  "status": "active|suspended|restricted", "memberSince": "…", "orders": 14, "spent": 5230, "lastOrderAt": "…|null",
  "zones": [Ref] }
// CustomerDetail = CustomerSummary & {
  "statusReason": "…|null", "statusChangedAt": "…|null", "statusChangedBy": Ref /* or null */,
  "localities": ["Station Road, Bemetara"], "cancelledOrders": 1, "aov": 374, "firstOrderAt": "…",
  "ratingsGiven": 6, "avgRatingGiven": 4.3, "openComplaints": 1, "pendingRefunds": 0,
  "allowed": { "revealContact": false, "suspend": false, "restrict": false, "reactivate": false, "decideRefunds": false } }
```

### Marketing — requests
- `GET /api/manager/marketing/requests?status&type&vendor&zone&cursor&limit` → `{ "items": [MarketingRequest], "nextCursor": "…|null", "counts": { "pending": 3, "approved": 1, "rejected": 2, "in_progress": 1, "completed": 9 } }` (counts ignore `status`, honour the rest).
- `GET /api/manager/marketing/requests/[id]` → `{ "request": MarketingRequest, "campaign": CampaignSummary|null, "offer": OfferSummary|null }`.
- `POST /api/manager/marketing/requests` (on behalf) body `{ "vendorId", "type", "title", "details", "preferredStart", "preferredEnd", "budget", "itemIds", "proposedOffer", "clientActionId" }` → 201 `{ "request": MarketingRequest }`.
- `POST /api/manager/marketing/requests/[id]/decide` body `{ "decision": "approve|reject", "expected": "pending", "remarks": "required for reject, 3–1000; optional for approve", "campaign": CampaignInput /* required to approve featured_store|banner|seasonal|sponsored_product */, "offer": OfferTerms /* required to approve discount_offer; fundedBy may be vendor, requestId = this request */, "clientActionId" }` → 200 `{ "request", "campaign": CampaignSummary|null, "offer": OfferSummary|null }`. 409 `stale`, `slot_taken` (`{ "slot": 2, "campaignId": "uuid" }`), `code_taken`.
- `POST /api/manager/marketing/requests/[id]/progress` (type `other` only) body `{ "status": "in_progress|completed", "remarks", "clientActionId" }` → 200 `{ "request" }`. 409 `invalid_transition`.

### Marketing — campaigns
`CampaignInput` = `{ "kind", "title" (3–80), "zoneId", "vendorIds" (featured_store/sponsored_product: exactly 1; banner: 0–1; seasonal: 0–50), "itemIds" (sponsored_product: 1–20 of that vendor), "startsAt", "endsAt" (end > start, ≤ 180 days, start ≥ now − 5 min), "budget" (≥ 0 or null), "fundedBy", "vendorSharePct" (1–99 iff shared), "slotPosition" (1–10, featured_store only), "banner": BannerFields (banner/seasonal), "offerCode" (seasonal, optional, existing in-scope offer), "requestId", "notes" }`.
- `GET /api/manager/marketing/campaigns?state=scheduled|active|expired|all&kind&vendor&zone&cursor&limit` → `{ "items": [CampaignSummary], "nextCursor", "counts": { "scheduled": 2, "active": 3, "expired": 11 } }`.
- `GET /api/manager/marketing/campaigns/[id]?from&to` → `{ "campaign": CampaignDetail, "performance": CampaignPerformance }` (default range = the window clipped to today).
- `POST /api/manager/marketing/campaigns` body `CampaignInput & { "clientActionId" }` → 201 `{ "campaign": CampaignDetail }`. 409 `slot_taken`, `consent_required` (vendor/shared funding without a matching approved request).
- `PATCH /api/manager/marketing/campaigns/[id]` body `{ "expectedUpdatedAt", "changes": Partial<CampaignInput>, "reason" (required once started), "clientActionId" }` → 200 `{ "campaign" }`. Before start: any field but `kind`/`requestId`; after start: only `endsAt`, `budget`, `notes`, `banner`. 409 `stale`, `locked_field`.
- `POST /api/manager/marketing/campaigns/[id]/actions` body `{ "action": "cancel|end_now", "reason", "clientActionId" }` → 200 `{ "campaign" }`. `cancel` before start, `end_now` while active.
- `POST /api/manager/marketing/campaigns/[id]/image` multipart `file` (jpeg/png ≤ 2 MB, magic-byte checked) → 200 `{ "imageUrl": "https://…/banner-images/…" }`.

### Customer-side tracking (public)
- `POST /api/campaigns/track` body `{ "campaignId": "uuid", "kind": "impression|click", "itemId": "uuid|null" }` → 200 `{ "ok": true, "recorded": bool }` always (beacon semantics as `/api/banners/track`; rate limit 120/min per IP; recorded only while the campaign is inside its window).
- Restaurant feed items gain `"featured": { "campaignId": "uuid" } | null`; dish payloads gain `"sponsored": { "campaignId": "uuid" } | null` (web data layer and the JSON routes `apps/customer` reads).
- `POST /api/coupons/validate` body gains optional `"items": [{ "menuItemId": "uuid", "qty": 2 }]`; response unchanged plus error `not_started`, `wrong_zone`, `no_eligible_items`.

### Offers
- `GET /api/manager/offers?state=scheduled|active|expired|inactive|exhausted|all&vendor&zone&q&cursor&limit` → `{ "items": [OfferSummary], "nextCursor", "counts": { "scheduled": 1, "active": 6, "expired": 20, "inactive": 3, "exhausted": 1 } }`. Visible: offers whose vendors or zones intersect scope, plus platform-wide offers (read-only for managers: `allowed` all false).
- `GET /api/manager/offers/[code]?from&to` → `{ "offer": OfferDetail, "usage": OfferUsage, "changes": [OfferChange] }` (changes newest first, last 100).
- `POST /api/manager/offers` body `OfferTerms & { "clientActionId" }` → 201 `{ "offer": OfferDetail }`. 409 `code_taken`, `consent_required`, `out_of_scope` (a vendor/zone/item outside scope), `platform_wide_admin_only`; 400 `field` (`expiresAt` missing or > 366 days, `value` > 90 for percent, item not of an eligible vendor).
- `PATCH /api/manager/offers/[code]` body `{ "expectedUpdatedAt", "changes": Partial<OfferTerms> /* never code */, "reason", "clientActionId" }` → 200 `{ "offer" }`. 409 `stale`.
- `POST /api/manager/offers/[code]/actions` body `{ "action": "activate|deactivate", "reason", "clientActionId" }` → 200 `{ "offer" }`. 409 `expired` (activate past `expiresAt`), `exhausted`.

### Customers
- `GET /api/manager/customers?q&phone&status&zone&sort=recent|orders|spend&cursor&limit` → `{ "items": [CustomerSummary], "nextCursor" }`. `q` = a customer uuid or an 8+ hex prefix of it, or a name fragment (≥ 2 chars). `phone` (10 digits) needs `customers.contact` (else 403) and is audited as `customer.phone_search`.
- `GET /api/manager/customers/[id]` → `{ "customer": CustomerDetail }`.
- Order history: Phase 3's `GET /api/manager/orders` gains `customer=<uuid>` (scope check: the customer must be visible; out-of-scope → 404). The app reuses its Orders list.
- `GET /api/manager/customers/[id]/complaints?cursor` → `{ "items": [TicketSummary], "nextCursor" }` (tickets whose requester is the customer, in scope).
- `GET /api/manager/customers/[id]/refunds?cursor` → `{ "items": [RefundItem], "nextCursor" }` (Phase 6 shape; viewing needs only `customers.view`; deciding uses Phase 6's decide route).
- `GET /api/manager/customers/[id]/feedback?cursor` → `{ "reviews": [{ "id", "vendor": Ref, "orderCode", "rating": 4, "comment": "…|null", "createdAt", "flagged": false, "reply": "…|null" }], "riderRatings": [{ "id", "rider": { "id", "name", "code" }, "orderCode", "rating": 5, "comment": "…|null", "createdAt" }], "nextCursor" }` (`riderRatings` empty when `rider_ratings` doesn't exist).
- `POST /api/manager/customers/[id]/contact` body `{ "reason": "order_issue|refund|complaint|delivery|other", "note": "required for other, 3–200", "clientActionId" }` → 200 `{ "phone": "+919876543210|null", "email": "…|null" }`.
- `POST /api/manager/customers/[id]/actions` body `{ "action": "suspend|restrict|reactivate", "expected": "active|suspended|restricted", "reason", "clientActionId" }` → 200 `{ "customer": CustomerDetail }`. 409 `stale`, `not_a_customer`; 502 `effect_failed` (status saved, auth ban not applied; retry is safe).
- `GET /api/manager/customers/retention?from&to&zone` → `{ "from", "to", "summary": { "customers": 812, "newCustomers": 140, "returningCustomers": 672, "repeatRate": 38.2, "ordersPerCustomer": 2.1, "aovPerCustomer": 352 }, "cohorts": [{ "cohort": "2026-05", "customers": 120, "r30": 41.7, "r60": 50.0, "r90": 55.8 }] }` (percentages one decimal; `null` when not matured).

## Requirement coverage

| Spec item | Tasks |
|---|---|
| §8.1 view all vendor marketing requests | S1, S5, A2 |
| §8.2 approve or reject · §8.3 approval/rejection remarks | S1 `ops_decide_marketing_request`, S5, A2 |
| §8.4 schedule featured store promotions | S1, S4 `effectiveVendorPositions`, S8 feed overlay, A3 |
| §8.5 manage banner campaigns | S1 (campaign-owned `banners` row), S5 image upload, A3 |
| §8.6 seasonal and festival promotions | S1 (`seasonal`, multi-vendor, linked offer), A3 |
| §8.7 review sponsored product requests | S1 (`sponsored_product` request → campaign), S8 boost + label, A2, A3 |
| §8.8 campaign start and end dates | S1 window checks, S4 state, S5 scheduler, A3 |
| §8.9 budgets and funding responsibility | S1 (`budget`, `funded_by`, `vendor_share_pct`, consent), A3 |
| §8.10 monitor campaign performance · §8.11 promotion usage and attributed sales | S1 `campaign_events`, `banner_events.customer_id`, S4 attribution, S5, S6 offer usage, S8 tracking, A3, A4; Phase 6 `marketing` report source |
| §8.12 expired and active campaigns | S4 `campaignState`, S5 list `state`, A3 |
| §8 statuses Pending/Approved/Rejected/In Progress/Completed | S1 check + transitions, S5 scheduler, A2 tabs |
| §9.1 create campaigns subject to permissions | S2 `ops_upsert_offer`, S6, A4 |
| §9.2 validity · §9.8 prevent unauthorized or expired | S2 `starts_at`, `price_coupon` re-declared, S6 validate route, A4 |
| §9.3 eligible vendors and products | S2 join tables + eligible subtotal, S6, S8 checkout items, A4 |
| §9.4 minimum order · §9.5 discount and redemption limits | S2 (existing columns), S6, A4 |
| §9.6 who funds | S2 consent rule, S6, A4 |
| §9.7 monitor usage · §9.9 campaign performance | S4 `offerUsage`, S6, A3/A4 |
| §9.10 record changes to promotional rules | S2 `coupon_changes` trigger + audit, S6, A4 |
| §10.1 view accounts, basic permitted info | S3 policy, S7, A5 |
| §10.2 search by id / contact where authorized | S3 `ops_reveal_customer_contact`, S7, A5 |
| §10.3 order history | S7 (`customer=` on Phase 3 orders), A5 |
| §10.4 complaints · §10.5 refund requests | S7, A5 (+ Phase 6 decide) |
| §10.6 repeat orders and retention | S3 facts RPC, S4 `src/lib/metrics/customers.ts`, S7, A5 |
| §10.7 ratings and feedback | S7 feedback, A5 |
| §10.8 suspend/restrict with authorization and reasons | S3 RPC + order guard, S7 auth ban + login refusals, S8 customer surfaces, A5 |
| §10.9 protect personal information | Global PII rule, S3 policy, S7 walk tests, A5 |

## Review Focus

1. **Suspended customers still ordering or signing in** — a suspended customer's existing session posts `/api/orders` → 403 `account_restricted` (DB guard), OTP verify → 403 `account_suspended` before any session, email/password sign-in in the Flutter customer app fails (ban); a phone order for a restricted customer is refused; reactivate restores both. (S3 PGlite, S7 QA, S8 Flutter test.)
2. **PII leaking** — no manager payload outside `/contact` carries a key matching `/phone$|email|address_line|lat|lng/` for a customer (walk test on every customer, campaign and offer serializer); a manager without `customers.contact` gets 403 on `phone=` and `/contact`; every reveal leaves exactly one audit row even on replay. (S7 QA.)
3. **Discount wrongly granted** — a not-yet-started, expired, deactivated, exhausted, wrong-zone or wrong-vendor code is refused by `apply_coupon_to_order` even when the client skips preview; an item-restricted code discounts only eligible lines and preview equals the bill for the same basket; two concurrent redemptions of a 1-use code still yield one (0056 lock kept). (S2 PGlite.)
4. **Campaign effects at the wrong time** — a featured campaign whose cron never ran still shows "Featured" at its slot only inside its window and stops at `endsAt`; overlapping campaigns cannot take the same slot; a cancelled campaign's banner is archived in the same transaction. (S1 PGlite, S4/S8 QA.)
5. **Consent and scope** — a manager creating a vendor-funded offer or a vendor-funded campaign without that vendor's approved request → 409 `consent_required`; an offer naming an out-of-zone vendor, zone or dish → 409 `out_of_scope`; a zone-A manager cannot see zone-B requests, campaigns, offers (except platform-wide, read-only) or customers who only ordered in zone B. (S1/S2/S3 PGlite, S5–S7 QA.)

---

### Task P0: Ready the branch (in `F:\hub26\deligro-manager`)

- [ ] **Step 1:** Confirm Phases 5 and 6 are integrated: `0151` (account status), `0156` and `src/lib/reports/registry.ts` present. If not, stop and finish them first.
- [ ] **Step 2:** `git merge feat/vendor-app` and `git merge feat/rider-app` if either has new commits. Check whether the Partner branch has landed `marketing_requests` or `coupons.starts_at`; if so, S1/S2 keep its columns and add only what is missing (write the finding under `## P0 result` in this plan). Diff every function either branch re-declares against the 0141–0159 copies (`guard_order_update`, `price_coupon`, `apply_coupon_to_order`, profile locks) and reconcile in the later migration; re-run every `scripts/qa/sql/migration-*.mjs`. Commit merge and reconciliation separately.
- [ ] **Step 3:** `git worktree add -b feat/manager-p7-server F:/hub26/deligro-manager-p7s HEAD`, same for `p7a`; copy `.env.local` and `apps/manager/env/*.json` (and `apps/customer/env/*.json`) into both.

## P0 result (2026-10-22, merge `1255510`)

**Merged:** `feat/rider-app` (its 0084–0087 and app phases 2–8). `feat/vendor-app` had nothing new. Reconciliation is in the merge commit; the points that change this plan:

- **`marketing_requests` exists — Partner `0064` owns it.** Columns: `id, number (identity), restaurant_id, requested_by, kind ('featured','banner','discount_offer','festival_campaign','sponsored_product'), title, details, budget (integer, rupees), starts_on, ends_on (dates), status ('pending','approved','in_progress','completed','rejected','cancelled'), admin_remarks, created_at, updated_at`; timeline table `marketing_request_updates (request_id, status, remarks, actor_id, created_at)`; owner read policies; data layer `src/lib/data-access/marketing.ts` (`listShopMarketing`, `createMarketingRequest`, `cancelMarketingRequest`, `listAllMarketing`, `decideMarketingRequest`) used by the Partner routes and Admin → Marketing. **S1 therefore does not create the table.** 0160 only adds what is missing: `decided_by`, `decided_at`, `campaign_id`, `offer_code`, `proposed_offer jsonb`, `attachments text[]`, `zone_id` (stamped from the shop, locked), a zone-scoped manager read policy on both tables, and the campaigns/tracking tables. Map the plan's kinds onto 0064's: plan `seasonal` ↔ 0064 `festival_campaign`, plan `featured_store` ↔ `featured`; keep 0064's values in the database and translate in the contract module. 0064's sixth status `cancelled` stays (the vendor withdrawing a pending request); the five client statuses are the others. `ops_decide_marketing_request` must write a `marketing_request_updates` row in the same transaction (0064's timeline), and `decideMarketingRequest` in `marketing.ts` becomes a thin caller of it so Admin and the Manager app share one decision path.
- **`coupons.starts_at` exists — 0064 owns it**, with the `coupons_window` check and `refresh_due_offers()`. **S2 does not add it.** 0064 re-declares `price_coupon` (with the start check); 0161's `price_coupon` / `apply_coupon_to_order` must start from 0064's body (diff it; keep the start refusal and 0056's lock).
- **Support, inbox, announcements:** one shared copy (0064 / 0087; `support.ts` merged — the Partner app's path-upload flow is a section of it). Customer complaints in §10 read `support_tickets` by requester through the existing staff functions.
- **Account status:** 0151's `profiles.account_status` is present; 0162 reuses it for customers as planned.
- Every SQL proof, the rider sequence proof and migration-order pass on the merged tree (deploy order now `0061 → 0063 → 0064 → 0081 → … → 0087 → 0141`); `tsc`, `next build`, `flutter analyze` and 463 Flutter tests pass.

# Part S — server and customer surfaces (worktree `deligro-manager-p7s`)

### Task S1: Migration 0160 — marketing requests, campaigns, tracking

**Files:** Create `supabase/migrations/0160_marketing_campaigns.sql`, `scripts/qa/sql/migration-0160.mjs`; Modify `docs/DATABASE.md`.

**Interfaces — Produces (database):**
- `marketing_requests (id uuid pk default gen_random_uuid(), number bigint generated always as identity unique, restaurant_id uuid not null → restaurants on delete cascade, zone_id uuid → delivery_zones (stamped from the restaurant by trigger), requested_by uuid not null → profiles, source text not null default 'vendor' check in ('vendor','ops'), type text not null check in ('featured_store','banner','seasonal','sponsored_product','discount_offer','other'), title text not null check length 3–120, details text not null default '' check length ≤ 2000, preferred_start date, preferred_end date, budget integer check ≥ 0, menu_item_ids uuid[] not null default '{}', proposed_offer jsonb, attachment_path text, status text not null default 'pending' check in ('pending','approved','rejected','in_progress','completed'), remarks text, decided_by uuid, decided_at timestamptz, campaign_id uuid, offer_code text, created_at, updated_at)`; indexes `(status, created_at desc)`, `(restaurant_id, created_at desc)`, `(zone_id, status)`. RLS: vendor `insert` when `owns_restaurant(restaurant_id)` and `status = 'pending'`, `source = 'vendor'`, `requested_by = auth.uid()`, decision columns null; vendor `select` own; manager `select` `manager_can_see_zone(zone_id)`; admin all; a `before update` guard lets only service role/admin change anything but nothing for vendors (vendors cannot edit after submit). Private bucket `marketing-attachments` (5 MB, jpeg/png/pdf), vendor insert under `<restaurant_id>/…` of own shop.
- `campaigns (id uuid pk, kind text check in ('featured_store','banner','seasonal','sponsored_product'), title text, zone_id uuid not null, restaurant_id uuid null (featured/sponsored/banner single vendor), status text not null default 'approved' check in ('approved','in_progress','completed','cancelled'), starts_at timestamptz not null, ends_at timestamptz not null check (ends_at > starts_at), budget integer check ≥ 0, funded_by text not null check in ('vendor','deligro','shared'), vendor_share_pct smallint check (funded_by = 'shared') = (vendor_share_pct between 1 and 99), slot_position smallint check between 1 and 10, banner_id uuid → banners on delete set null, offer_code text → coupons(code) on delete set null, request_id uuid → marketing_requests, notes text, created_by uuid not null, cancelled_reason text, cancelled_by uuid, cancelled_at timestamptz, created_at, updated_at)`; `campaign_vendors (campaign_id, restaurant_id, pk both)`, `campaign_items (campaign_id, menu_item_id, pk both)`; `campaign_events (id bigint identity pk, campaign_id uuid not null, kind text check in ('impression','click'), customer_id uuid null, menu_item_id uuid null, created_at)` with index `(campaign_id, kind, created_at)` and `(customer_id, created_at) where customer_id is not null`. RLS on all: manager select by `manager_can_see_zone(zone_id)` (join tables and events through their campaign); anon/authenticated insert into `campaign_events` **revoked** (the track route writes as service role); customers read nothing. Public bucket `banner-images` (2 MB, jpeg/png), writes service-role only.
- `banner_events.customer_id uuid null` + index `(banner_id, kind, created_at)`; `recordBannerEvent` passes it.
- RPCs (service role only, each `_ops_set_actor`, `ops_require_staff` on the zone, `_ops_log`, replay-safe):
  - `ops_create_marketing_request(p_actor, p_restaurant, p_type, p_title, p_details, p_preferred_start, p_preferred_end, p_budget, p_items uuid[], p_proposed_offer jsonb, p_client_action_id) returns jsonb` — `source = 'ops'`; items must belong to the shop; audit `marketing.request_create`.
  - `ops_create_campaign(p_actor, p_input jsonb, p_client_action_id) returns uuid` — validates per `CampaignInput`; consent (`vendor`/`shared` → `request_id` of the same vendor with status `approved` or being approved in this transaction) else `consent_required`; featured slot conflict under `pg_advisory_xact_lock(hashtext('featured-slot'))` → `slot_taken`; banner/seasonal create the `banners` row; seasonal with `offer_code` sets that coupon's `starts_at`/`expires_at` to the window (offer must be in scope); audit `campaign.create`.
  - `ops_decide_marketing_request(p_actor, p_request, p_decision, p_expected, p_remarks, p_campaign jsonb, p_offer jsonb, p_client_action_id) returns jsonb` — locks the request, `stale` if status ≠ `p_expected`; reject needs remarks; approve sets `approved`, `decided_by/at`, remarks, and in the same transaction calls the campaign creator (`p_campaign`) or `ops_upsert_offer`'s internal (`p_offer`, defined in 0161 — so 0160 declares a forward stub `_ops_create_offer_internal` replaced by 0161) and stores `campaign_id`/`offer_code`; audit `marketing.request_approve|reject`.
  - `ops_progress_marketing_request(p_actor, p_request, p_status, p_remarks, p_client_action_id)` — type `other` only, `approved → in_progress → completed`.
  - `ops_update_campaign(p_actor, p_campaign, p_expected_updated_at, p_changes jsonb, p_reason, p_client_action_id)` — field locks per contract; keeps the banner row and linked offer window in step; audit with before/after.
  - `ops_campaign_action(p_actor, p_campaign, p_action, p_reason, p_client_action_id)` — `cancel` (before start) / `end_now` (active, sets `ends_at = now()`); archives the banner; moves the request per Claude's calls; audit.
  - `ops_sync_campaign_states(p_now timestamptz) returns jsonb` (service role, no actor): `approved` inside window → `in_progress`, past end → `completed`; linked requests follow; returns the ids changed (for notices).

- [ ] **Step 1: Write `migration-0160.mjs`** (0141 preamble; stub roles): vendor inserts a pending request for own shop, cannot for another shop, cannot insert `status='approved'`, cannot update after submit; zone-B manager sees no zone-A request; decide-reject without remarks → `reason_required`; approve featured with slot 2 → request `approved`, campaign created, audit rows 2; second featured campaign on slot 2 overlapping → `slot_taken`, non-overlapping → ok; vendor-funded campaign with no request → `consent_required`; banner campaign creates a `banners` row with the window and `kind 'sponsored'`; cancel before start → banner `archived`, request `rejected` with "Cancelled:" remarks; `ops_sync_campaign_states` at start → `in_progress` (request too), at end → `completed`; replayed `client_action_id` → one campaign; authenticated insert into `campaign_events` → permission error; `ops_update_campaign` changing `startsAt` after start → `locked_field`.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration** (header in house style, rollback block). **Step 4: Run every SQL proof — PASS.**
- [ ] **Step 5: Commit** `feat(db): 0160 marketing requests, campaigns and campaign tracking`.

### Task S2: Migration 0161 — offers: validity, eligibility, change log

**Files:** Create `supabase/migrations/0161_offers_eligibility_changes.sql`, `scripts/qa/sql/migration-0161.mjs`; Modify `docs/DATABASE.md`.

**Interfaces — Produces (database):**
- `coupons.starts_at timestamptz null` (if not exists — Partner design's name), `coupons.updated_at timestamptz not null default now()` (touch trigger), `coupons.created_by` kept.
- `coupon_restaurants (code → coupons on delete cascade on update cascade, restaurant_id, pk)`, `coupon_zones (code, zone_id, pk)`, `coupon_items (code, menu_item_id, pk)`; backfill `coupon_restaurants` from `coupons.restaurant_id`. RLS: vendor select own-shop rows, manager select per offer visibility, writes service role/admin only (vendor single-shop codes keep using `coupons.restaurant_id`; a trigger mirrors it into `coupon_restaurants`).
- `coupon_changes (id bigint identity, code text, target text check in ('coupon','vendor','zone','item'), op text, before jsonb, after jsonb, actor_id uuid, reason text, created_at)` written by `log_coupon_change()` triggers on the four tables (actor `coalesce(auth.uid(), deligro.actor_id)`, reason from `deligro.reason` session setting); insert-only (update/delete refused for every role). Manager select through offer visibility.
- `price_coupon(c coupons, subtotal integer, rid uuid, customer uuid, p_zone uuid default null, p_eligible_subtotal integer default null)` re-declared keeping every 0041/0056 rule: adds `not_started` (`starts_at > now()`), vendor list (`coupon_restaurants` non-empty and `rid` not in it → `wrong_restaurant`), zone list (→ `wrong_zone`), and when `coupon_items` exist the discount base is `p_eligible_subtotal` (`no_eligible_items` when 0) while `min_order` checks `subtotal`. Old 4-arg callers keep working via the defaults.
- `apply_coupon_to_order` re-declared (keep 0056's ownership check, `placed` check, advisory lock, redemption insert, funded-by write): passes `o.zone_id` and the eligible subtotal from `order_items` joined to `coupon_items`. `preview_coupon(p_code text, p_restaurant uuid, p_items jsonb)` new overload pricing lines from `menu_items` (server prices, available only), same session requirement and grants as the 3-arg version.
- Visibility helper `manager_can_see_offer(p_code text) returns boolean`: platform-wide (no restaurant, no zone rows) → any manager; else any listed restaurant/zone in scope. Select policy `"coupons — manager read"`.
- RPCs: `ops_upsert_offer(p_actor, p_code, p_terms jsonb, p_expected_updated_at timestamptz /* null = create */, p_reason, p_client_action_id) returns jsonb` — sets `deligro.reason`; validates per contract (scope of every vendor/zone/item via `ops_require_staff`; platform-wide → actor must be admin; `fundedBy = 'vendor'` → `p_terms.requestId` must be an approved/being-approved `discount_offer` request of that single vendor, else `consent_required`; managers must set `expiresAt`); writes coupon + join rows; audit `offer.create|update`. `_ops_create_offer_internal` (called by 0160's decide) is this function's body. `ops_offer_action(p_actor, p_code, p_action, p_reason, p_client_action_id)` — `activate` refuses `expired`/`exhausted`; audit `offer.activate|deactivate`.

- [ ] **Step 1: Write `migration-0161.mjs`:** preview for a not-started code → `not_started`; apply at a non-listed vendor → `wrong_restaurant`, other zone → `wrong_zone`; item-restricted 20% code on a basket with one eligible ₹200 line and one ₹300 line → discount 40, min_order 400 passes on the ₹500 basket; preview overload equals apply for the same basket; expired/inactive/exhausted refused at apply even without preview; two concurrent 1-use applies → one redemption (keep 0056 test); vendor updating own code writes a `coupon_changes` row with the vendor as actor; manager `ops_upsert_offer` with an out-of-zone item → `out_of_scope`; vendor-funded without request → `consent_required`; with approved request → ok; platform-wide by a manager → `platform_wide_admin_only`; activate past expiry → `expired`; `coupon_changes` delete → error; zone-B manager reads no zone-A offer, reads a platform-wide one.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration** (replace 0160's stub; header, rollback block restoring 0056's coupon functions). **Step 4: Run every SQL proof — PASS.**
- [ ] **Step 5: Commit** `feat(db): 0161 offers — start dates, vendor/zone/item eligibility, change log, audited offer RPCs`.

### Task S3: Migration 0162 — customers: scoped reads, contact, status, retention facts

**Files:** Create `supabase/migrations/0162_manager_customers.sql`, `scripts/qa/sql/migration-0162.mjs`; Modify `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md` (log row: profiles policy change).

**Interfaces — Produces (database):**
- Index `orders (customer_id, created_at)`. `manager_can_see_customer(p_customer uuid) returns boolean` (stable, security definer): admin, or exists an order with that `customer_id` and `manager_can_see_zone(zone_id)`.
- Drop `"profiles — manager read"` (0023); create `"profiles — manager scoped read"`: `id = auth.uid()` or (`role = 'customer'` and `manager_can_see_customer(id)`) or (`role = 'driver'` and `manager_can_see_rider(id)`) or (`role = 'restaurant'` and exists an owned restaurant with `manager_can_see_restaurant`). Verify the web `/manager` board (customer names on in-scope orders, `listRiders`) still reads what it needs.
- `ops_lookup_caller(p_phone text) returns jsonb` (security definer, `authenticated` allowed, refuses unless `is_admin()` or `is_manager()`): `{ name, is_staff }` or null.
- `ops_reveal_customer_contact(p_actor, p_customer, p_reason, p_note, p_client_action_id) returns jsonb` — `ops_require_staff` against any in-scope zone of the customer (else `forbidden`); returns `{ phone, email }`; audit `customer.contact_reveal` with reason (contact values **not** stored in the audit row). `ops_log_phone_search(p_actor, p_phone_last4, p_results int, p_client_action_id)` — audit `customer.phone_search`.
- `ops_set_customer_account(p_actor, p_customer, p_action, p_expected, p_reason, p_client_action_id) returns jsonb` — role must be `customer` (`not_a_customer`); transitions `active → suspended|restricted`, `restricted → suspended|active`, `suspended → active|restricted`; writes 0151's columns; audit `customer.suspend|restrict|reactivate`.
- `guard_order_customer_status()` `before insert on orders`: when the customer's `account_status <> 'active'` raise `account_restricted` (errcode `P0001`, message `account_restricted`). Applies to every role including service role.
- `ops_customer_order_facts(p_zones uuid[] /* null = all */, p_from timestamptz, p_to timestamptz) returns table (customer_id uuid, first_order_at timestamptz, second_order_at timestamptz, orders_in_range int, last_order_at timestamptz)` (service role; non-cancelled orders; first/second over all time within the zones).

- [ ] **Step 1: Write `migration-0162.mjs`:** zone-A manager selects a customer with a zone-A order, not one who only ordered in zone B, not a never-ordered customer; still selects own profile and zone-A riders; `ops_lookup_caller` by a manager returns the never-ordered customer's name only, by a customer → refused; reveal without reason → `reason_required`, with reason → contact + one audit row whose `after` has no phone; replay → one row; suspend a vendor account → `not_a_customer`; suspend customer → status `suspended`; then an order insert as that customer and as service role → `account_restricted`; reactivate → insert ok; stale expected → `stale`; customer updating own `account_status` → error (0151 lock kept); facts RPC on a fixture (first, second, in-range counts) matches hand-computed values.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration** (header, rollback restoring 0023's policy). **Step 4: Run every SQL proof — PASS.**
- [ ] **Step 5: Commit** `feat(db): 0162 customers for managers — scoped reads, contact reveal, suspension, retention facts`.

### Task S4: Pure rules — campaigns, attribution, offers, retention

**Files:** Create `src/lib/marketing/campaign-rules.ts`, `src/lib/marketing/attribution.ts`, `src/lib/ops/offer-rules.ts`, `src/lib/metrics/customers.ts` (export from `src/lib/metrics/index.ts`), `scripts/qa/manager-marketing-rules.ts` (add `"test:manager-marketing-rules"`).

**Interfaces — Produces:**
```ts
export type CampaignState = "scheduled" | "active" | "expired";
export function campaignState(c: { status: string; startsAt: string; endsAt: string }, now: Date): CampaignState;
export function validateCampaignInput(input: unknown, now: Date): { ok: true; value: CampaignInput } | { ok: false; field: string };
export function campaignEditable(c, now: Date): { edit: boolean; editWindowOnly: boolean; cancel: boolean; endNow: boolean };
export function effectiveVendorPositions(manual: Map<string, number>, featured: { restaurantId: string; slot: number }[]): Map<string, number>; // SLOT_COUNT 10
export const ATTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export function attributeOrders(campaign: AttributionCampaign, orders: AttrOrder[], clicks: AttrClick[]): { orderIds: string[]; orders: number; sales: number; customers: number };
export function campaignPerformance(campaign, events, orders, redemptions, range, before?): CampaignPerformance;
export type OfferState = "scheduled" | "active" | "expired" | "inactive" | "exhausted";
export function offerState(o: { active: boolean; startsAt: string | null; expiresAt: string | null; maxRedemptions: number | null; redemptions: number }, now: Date): OfferState;
export function validateOfferTerms(input: unknown, now: Date): { ok: true; value: OfferTerms } | { ok: false; field: string };
export function offerUsage(redemptions, orders, range): OfferUsage;
export function maskPhone(e164: string | null): string | null; // "••••••" + last 4
export function retentionSummary(facts: CustomerFact[], orders: MetricOrder[], range: DateRange): RetentionSummary;
export function retentionCohorts(facts: CustomerFact[], to: string, months?: number /* 6 */): Cohort[];
```
- [ ] **Step 1: Write the QA script** with the spec's values: `campaignState` at start − 1 ms → `scheduled`, at start → `active`, at end → `expired`, cancelled inside window → `expired`; `effectiveVendorPositions` with manual {A:1,B:2} and featured C@1 → {C:1,A:2,B:3}, an 11th shop drops off; attribution: click 23 h before order at the vendor → counted, 25 h → not, click after the order → not, cancelled order → not, same order with code + click → counted once, sponsored order without a campaign dish → not; `offerState` precedence inactive > expired > exhausted > scheduled > active; `validateOfferTerms` percent 95 → `field: "value"`, no `expiresAt` → `field: "expiresAt"`, 400 days → field; `maskPhone("+919876543210")` → `"••••••3210"`; retention on a 5-customer fixture (two new, one repeat inside range, cohort r30 50.0, r90 null for an immature cohort); empty input → zeros, never `NaN`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; eslint on touched paths.**
- [ ] **Step 5: Commit** `feat(marketing): pure rules for campaign state, attribution, offers and retention`.

### Task S5: Marketing — data layer, routes, scheduler, notices, report source, admin page

**Files:**
- Create: `src/lib/ops/marketing-contract.ts` (types + serialisers), `src/lib/data-access/manager-marketing.ts`, `src/lib/marketing/schedule.ts`, `src/lib/notifications/marketing.ts`, routes `src/app/api/manager/marketing/requests/route.ts`, `…/requests/[id]/route.ts`, `…/requests/[id]/decide/route.ts`, `…/requests/[id]/progress/route.ts`, `…/campaigns/route.ts`, `…/campaigns/[id]/route.ts`, `…/campaigns/[id]/actions/route.ts`, `…/campaigns/[id]/image/route.ts`, `src/app/admin/marketing/page.tsx` (+ `request-decide.tsx`), `scripts/qa/manager-marketing.ts` (add `"test:manager-marketing"`).
- Modify: `src/lib/dispatch/sweep.ts` (call `syncCampaigns(now)`), `src/lib/reports/builders/marketing.ts` (campaigns source fills `budget`, `fundedBy`, `status`; attribution via `attributeOrders`), `src/components/admin/admin-nav.ts` (Marketing), `src/app/admin/vendors/slots/*` (campaign-held slots read-only), `src/lib/data-access/banners.ts` (`recordBannerEvent(…, { placement, customerId })`), `src/app/api/banners/track/route.ts` (stamp `customerId` from the session when present).

**Interfaces — Produces:**
```ts
export async function listMarketingRequests(scope: ManagerScope, q: RequestQuery): Promise<{ items: MarketingRequest[]; nextCursor: string | null; counts: Record<RequestStatus, number> }>;
export async function getMarketingRequest(scope: ManagerScope, id: string): Promise<{ request: MarketingRequest; campaign: CampaignSummary | null; offer: OfferSummary | null } | null>;
export async function decideMarketingRequest(actor: OpsActor, id: string, body: DecideBody): Promise<OpsResult<{ request; campaign; offer }>>;
export async function listCampaigns(scope, q): Promise<{ items: CampaignSummary[]; nextCursor; counts }>;
export async function getCampaign(scope, id, range): Promise<{ campaign: CampaignDetail; performance: CampaignPerformance } | null>;
export async function createCampaign(actor, input, clientActionId); updateCampaign(actor, id, body); campaignAction(actor, id, body); uploadCampaignImage(actor, id, file: File);
export async function syncCampaigns(now: Date): Promise<{ changed: string[] }>; // throttled 60 s in-process; calls ops_sync_campaign_states, then notices
export async function activeFeaturedCampaigns(now: Date): Promise<{ campaignId: string; restaurantId: string; slot: number }[]>; // cached 60 s
export async function activeSponsoredItems(now: Date): Promise<Map<string /* menuItemId */, string /* campaignId */>>; // cached 60 s
```
- Notices (deferred, after commit; `user_notifications` when the table exists, push always): vendor on request decision and on campaign start/end; zone managers on a new vendor request (Phase 8's `marketing_request_new` alert reuses `notifyMarketingRequestNew`).
- [ ] **Step 1: Write `scripts/qa/manager-marketing.ts`:** pure — query parsing (bad `status`, `state`, uuid → `field`), `mapMarketingRpcError` covers every RPC code, serializer emits the pinned keys and no customer identity (walk test), `allowed` per state; structural — every route opens with `managerApiContext("manager.marketing.manage")`, writes rate-limited, no `select("*")`, image route checks magic bytes and 2 MB; the report builder's columns unchanged and campaign rows present for a fixture. Live (skip without `BASE`/`QA_MANAGER_*`): 401 unauthenticated; zone-B id → 404; approve → 200 then replay → 200 unchanged.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; eslint; `npm run test:platform`; open `/admin/marketing` in `next dev` and screenshot.**
- [ ] **Step 5: Commit** `feat(api): manager marketing — requests, campaigns, scheduler, performance, admin page`.

### Task S6: Offers — routes, admin promotions on the audited path, validate with items

**Files:**
- Create: `src/lib/ops/offer-contract.ts`, `src/lib/data-access/manager-offers.ts`, routes `src/app/api/manager/offers/route.ts`, `…/offers/[code]/route.ts`, `…/offers/[code]/actions/route.ts`, `scripts/qa/manager-offers.ts` (add `"test:manager-offers"`).
- Modify: `src/lib/data-access/promotions.ts` (`createPromotion`/`updatePromotion`/`setPromotionActive` call `ops_upsert_offer`/`ops_offer_action` with the admin as actor; `deletePromotion` stays admin-only and is logged by the trigger), `src/lib/data-access/coupons.ts` (`evaluateCoupon(code, subtotal, restaurantId, items?)` uses the items overload when `items` is given; maps `not_started`, `wrong_zone`, `no_eligible_items` to customer sentences in English/Hindi), `src/app/api/coupons/validate/route.ts` (accept `items`, validate shape, max 100 lines), `src/components/checkout/checkout-view.tsx` (send the cart items).

**Interfaces — Produces:** `listOffers(scope, q)`, `getOffer(scope, code, range)`, `createOffer(actor, terms, clientActionId)`, `updateOffer(actor, code, body)`, `offerAction(actor, code, body)` returning the pinned shapes; `mapOfferRpcError`.
- [ ] **Step 1: Write the QA script:** pure — body validation per contract, error mapping, serializer keys, `allowed` false for platform-wide offers seen by a manager, `offerUsage` totals equal the sum of `daily`; structural — routes open with `managerApiContext("manager.offers.manage")`, `promotions.ts` has no direct `coupons` insert/update; validate route rejects 101 items; live (skip as S5): create → 201, `PATCH` with stale `expectedUpdatedAt` → 409, `activate` an expired code → 409 `expired`, `/api/coupons/validate` with a not-started code → error `not_started`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; eslint; `next build`.**
- [ ] **Step 5: Commit** `feat(api): manager offers — eligibility, limits, funding consent, usage and change history`.

### Task S7: Customers — routes, orders filter, caller lookup, login and order enforcement

**Files:**
- Create: `src/lib/ops/customer-contract.ts`, `src/lib/data-access/manager-customers.ts`, `src/lib/auth/account-status.server.ts`, routes `src/app/api/manager/customers/route.ts`, `…/customers/[id]/route.ts`, `…/[id]/complaints/route.ts`, `…/[id]/refunds/route.ts`, `…/[id]/feedback/route.ts`, `…/[id]/contact/route.ts`, `…/[id]/actions/route.ts`, `…/customers/retention/route.ts`, `scripts/qa/manager-customers.ts` (add `"test:manager-customers"`).
- Modify: Phase 3 `parseOrderQuery` + `listManagerOrders` (`customer` filter, scope-checked), `src/lib/data-access/manager-phone-orders.ts` (`lookupCaller` → `ops_lookup_caller`), `src/app/api/auth/otp/verify/route.ts` and `src/app/api/auth/password-login/route.ts` (refuse suspended **customers** with 403 `account_suspended` before a session is issued; staff roles unaffected here), `src/app/api/orders/route.ts` (map `account_restricted` → 403 `{ error: "account_restricted", message }` in the customer's language), `src/app/api/me/route.ts` (adds `accountStatus`), `src/lib/data-access/admin-customers.ts` + `src/app/admin/customers/**` (status column and suspend/restrict/reactivate through the same function, admin as actor), `src/components/auth/otp-login.tsx` (shows the suspended sentence).

**Interfaces — Produces:**
```ts
export async function setCustomerAccount(actor: OpsActor, id: string, body: { action; expected; reason; clientActionId }): Promise<OpsResult<CustomerDetail>>; // RPC, then applyAuthBan(id, action) — ban "876000h" on suspend, "none" otherwise; signs out sessions on suspend
export async function applyAuthBan(userId: string, action: "suspend" | "restrict" | "reactivate"): Promise<void>; // account-status.server.ts, server-only
export async function customerLoginRefusal(userIdOrPhone: { userId?: string; phone?: string }): Promise<"account_suspended" | null>;
```
- [ ] **Step 1: Write `scripts/qa/manager-customers.ts`:** pure — query parsing (`q` uuid / 8-hex prefix / name; `phone` 9 digits → `field`), serializers walk-tested against `/phone$|email|address_line|lat|lng/` except the contact response, `allowed` per permission, retention route numbers equal `retentionSummary` on a fixture; structural — `phone=` path checks `manager.customers.contact` before querying and calls `ops_log_phone_search`; `/contact` and `/actions` are rate-limited (10/min per manager); `lookupCaller` has no `from("profiles")`; otp-verify and password-login call `customerLoginRefusal` before `verifyOtp`/`signInWithPassword`; orders route maps `account_restricted`. Live (skip as S5): out-of-scope customer → 404; reveal without permission → 403; suspend → 200, then that customer's `POST /api/orders` → 403 `account_restricted`; reactivate → 200.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; eslint; `npm run test:idor`; `next build`; walk `docs/SECURITY_AUDIT.md` (auth path + profiles policy change) and log it.**
- [ ] **Step 5: Commit** `feat(api): manager customers — scoped search, contact reveal, history, retention, suspension enforced at sign-in and checkout`.

### Task S8: Customer surfaces — featured and sponsored, tracking, item codes, account refusals

**Files:**
- Modify (web): `src/lib/data-access/vendor-positions.ts` (`applyVendorOrder` takes the featured overlay from `effectiveVendorPositions`), the customer feed data layer and restaurant card (`featured` field, "Featured" label), `src/lib/search/dishes.ts` (`SPONSORED_BOOST = 20`, `sponsored` field, "Sponsored" label in dish cards), `src/app/api/restaurants/**` JSON (`featured`, `sponsored` fields), new `src/app/api/campaigns/track/route.ts`, client beacons on featured cards and sponsored dishes (impression once per view, click on tap; never in admin previews).
- Modify (`apps/customer`): models gain `featured`/`sponsored`; labels on the restaurant card and dish tile; `CampaignTracker` (impression once per session per campaign, click on tap) posting `/api/campaigns/track`; checkout sends `items` to `/api/coupons/validate`; order placement shows the server's `account_restricted` message; login shows the `account_suspended` sentence; tests `test/campaign_labels_test.dart`, `test/account_status_test.dart`.

- [ ] **Step 1: Write failing tests:** `scripts/qa/customer-campaigns.ts` (feed overlay puts the campaign shop at its slot only inside the window; a sponsored dish outranks an equal unsponsored one by exactly `SPONSORED_BOOST`; track route ignores a campaign outside its window and `placement: "preview"`), and the two Flutter tests (label rendered when the field is present; tracker posts one impression for two builds; restricted refusal shows the server message, not a generic error).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; eslint; `next build`; in `apps/customer`: `flutter analyze`, `flutter test`, release APK built and smoke-tested on `deligro_test` (home shows; no crash in logcat).**
- [ ] **Step 5: Commit** `feat(customer): featured and sponsored labels, campaign tracking, item-eligible codes, account refusals`.

# Part A — Manager app (worktree `deligro-manager-p7a`, `apps/manager/` only)

### Task A1: Models, repositories, fixtures

**Files:** Create `lib/models/{marketing,campaigns,offers,customers}.dart`, `lib/data/{marketing_repository,offers_repository,customers_repository}.dart`, `test/fixtures/api/{marketing_requests,marketing_request_detail,campaigns_list,campaign_detail,offers_list,offer_detail,customers_list,customer_detail,customer_feedback,customer_complaints,customer_refunds,retention}.json`, `test/fakes/fake_marketing_offers_customers.dart`, `test/marketing_offers_customers_models_test.dart`.

**Interfaces — Produces:** lenient `fromJson` models for every pinned shape (unknown enum → `.unknown`); repositories with one method per endpoint, all writes taking a `clientActionId` reused on retry; `ActionOutcome` mapping of 409/422/502 codes (Phase 3 type).
- [ ] **Step 1: Write the test:** each fixture parses; unknown `status` → `.unknown`; `OfferTerms.toJson()` round-trips; `CampaignInput.toJson()` omits `slotPosition` for non-featured kinds; repository retry reuses the same `clientActionId`.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: `flutter analyze`, `flutter test` — PASS. Step 5: Commit** `feat(manager-app): marketing, offers and customers models and repositories`.

### Task A2: Marketing requests

**Files:** Create `lib/features/marketing/{marketing_screen,request_detail_screen,request_decide_sheet,request_new_screen}.dart`, `lib/state/marketing.dart`, `test/marketing_requests_test.dart`; Modify `lib/router.dart` (`/more/marketing` real, `/more/marketing/requests/:id`, `/more/marketing/requests/new`; remove the Phase 7 placeholder), `lib/features/home/*` (Pending Marketing Requests tile → `/more/marketing?status=pending`).

**Interfaces — Produces:** Marketing screen with two tabs **Requests · Campaigns**; Requests has status chips with counts (Pending, Approved, Rejected, In progress, Completed), type and vendor filters, infinite scroll; detail shows every request field, attachment, items, proposed offer, linked campaign/offer; **Approve** opens the decide sheet that pre-fills a `CampaignInput` (or `OfferTerms` for `discount_offer`) from the request (preferred dates, budget, items, vendor-funded) and lets the manager adjust; **Reject** requires remarks; type `other` shows Progress actions; "Record a request for a vendor" (vendor picker in scope).
- [ ] **Step 1: Write the test:** Pending chip count from fixture; reject with 2-char remarks keeps the button disabled; approving a `featured_store` request without a slot shows the field error; `slot_taken` shows "Slot 2 is taken by <campaign>"; `stale` refreshes and says someone else decided it.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS + analyze. Step 5: Commit** `feat(manager-app): marketing requests — review, approve with campaign or offer, reject with remarks`.

### Task A3: Campaigns

**Files:** Create `lib/features/marketing/{campaigns_tab,campaign_detail_screen,campaign_form_screen,slot_picker,item_picker}.dart`, `test/campaigns_test.dart`; Modify `lib/router.dart` (`/more/marketing/campaigns/:id`, `/more/marketing/campaigns/new`).

**Interfaces — Produces:** state chips **Active · Scheduled · Expired** with counts, kind filter; form adapts per kind (featured: vendor + slot 1–10 picker; banner/seasonal: banner fields, image upload via `image_picker` → `/image`, live card preview in our tokens; seasonal: vendors multi-pick, optional offer link; sponsored: vendor + dish picker ≤ 20), dates with IST pickers, budget, funding (shared → share % slider), notes; after start only the allowed fields are editable and a reason is asked; detail shows window, funding, linked request/offer, performance (impressions, clicks, CTR, redemptions, discount, attributed orders/sales, Before/During comparison for featured/sponsored) with an `fl_chart` daily line, range picker, Cancel / End now with reason.
- [ ] **Step 1: Write the test:** shared funding requires a share; end before start disables Save; a started campaign's form disables kind/vendor/start; `consent_required` shows "Vendor-funded campaigns need the vendor's approved request"; performance renders `—` for a null comparison and no `NaN` for zero impressions.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS + analyze. Step 5: Commit** `feat(manager-app): campaigns — schedule, edit, performance, cancel`.

### Task A4: Offers

**Files:** Create `lib/features/offers/{offers_screen,offer_detail_screen,offer_form_screen}.dart`, `lib/state/offers.dart`, `test/offers_test.dart`; Modify `lib/router.dart` (`/more/offers` real, `/more/offers/:code`, `/more/offers/new`).

**Interfaces — Produces:** list with state chips (Active, Scheduled, Expired, Inactive, Exhausted) and search; form: code (upper-cased, A–Z 0–9), label, percent/flat + value, min order, max discount, start and expiry, per-customer and total limits, eligibility (vendors, zones, dishes — pickers limited to scope), funding (vendor only when opened from an approved request); detail: terms, usage figures and daily chart, by-vendor table, **Change history** (field, before → after, who, when, reason), Activate/Deactivate with reason; platform-wide offers shown read-only with a note.
- [ ] **Step 1: Write the test:** percent 95 blocked; missing expiry blocked; edit sends `expectedUpdatedAt` and asks for a reason; `expired` on activate shows "Set a new expiry first"; change history renders before → after.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS + analyze. Step 5: Commit** `feat(manager-app): offers — create, limits, eligibility, usage and change history`.

### Task A5: Customers and retention

**Files:** Create `lib/features/customers/{customers_screen,customer_detail_screen,contact_reveal_sheet,account_action_sheet,retention_screen}.dart`, `lib/state/customers.dart`, `test/customers_test.dart`; Modify `lib/router.dart` (`/more/customers` real, `/more/customers/:id`, `/more/customers/retention`), Phase 3 orders list widget accepts an initial `customer` filter.

**Interfaces — Produces:** list with search (id or name; a **phone** field only when `manager.customers.contact`), status chips, sort; detail: masked phone with **Reveal** (reason picker; revealed contact shown with Call/Copy and never cached to disk), status with reason and who, member since, orders/spent/AOV/cancelled, localities, sections Orders (embedded Phase 3 list filtered by customer), Complaints (ticket list → Phase 4 thread), Refunds (Phase 6 `RefundItem` rows; Decide opens Phase 6's decide sheet only when `allowed.decideRefunds`), Feedback (reviews and rider ratings); Suspend / Restrict / Reactivate with reason and a plain explanation of each; Retention screen (summary figures, cohort table r30/r60/r90 with `—` for immature, zone and range pickers).
- [ ] **Step 1: Write the test:** no phone field without the permission; reveal requires a reason and shows the number only after the call returns; suspend dialog explains "cannot sign in or order"; `effect_failed` shows "Saved, but sign-in block failed — try again"; retention renders `—` for null cohorts.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS + analyze. Step 5: Commit** `feat(manager-app): customers — search, contact reveal, history, complaints, refunds, feedback, suspension, retention`.

### Task A6: Release build check (app half)

- [ ] **Step 1:** `flutter analyze` clean; `flutter test` all pass; golden/screenshot tests render Marketing (requests and campaigns), a campaign detail, Offers, an offer detail, Customers and a customer detail from fixtures in light and dark and at 900 dp width (list + detail).
- [ ] **Step 2:** Release APK (`--dart-define-from-file=env/prod.json`), install on `deligro_test`, cold start → splash → login, no `FATAL`/`E/flutter` in logcat; save the screenshots under the scratchpad and list them in the commit body.
- [ ] **Step 3: Commit** `chore(manager-app): phase 7 release check`.

### Task I1: Integrate, contract check, phase exit (in `F:\hub26\deligro-manager`)

- [ ] **Step 1:** Merge `feat/manager-p7-server`, then `feat/manager-p7-app`; resolve conflicts (none expected outside `package.json`).
- [ ] **Step 2: Contract check.** Extend `scripts/qa/manager-contract-emit.ts` to run the S5/S6/S7 serialisers on in-file fixture rows (a request in each status, each campaign kind and state with and without comparison, offers in each state including platform-wide, customers in each status with and without contact permission, a retention payload with a null cohort) and write `apps/manager/test/fixtures/api/generated/{marketing_requests,campaign_detail,campaigns_list,offers_list,offer_detail,customers_list,customer_detail,retention}.json`; extend `contract_test.dart` to parse each with the A1 models. Run `npx tsx scripts/qa/manager-contract-emit.ts && cd apps/manager && flutter test test/contract_test.dart` — PASS. Commit the generated fixtures.
- [ ] **Step 3: Phase exit:** every `scripts/qa/sql/migration-*.mjs`, every `npm run test:manager-*`, `npm run test:platform`, `npm run test:idor`, `npx tsc --noEmit`, `npm run lint`, `next build`; `flutter analyze` + `flutter test` in `apps/manager` and `apps/customer`; release APKs of both smoke-tested on `deligro_test`. Commit `chore(manager-app): phase 7 integrated`; remove both worktrees and branches.

## Notes for other branches and later phases

- **Partner branch (phase 6):** build the vendor Marketing screens on `marketing_requests` from `0160` (vendors insert/read through RLS; the `marketing-attachments` bucket is ready) and use `coupons.starts_at`, `coupon_items` and `preview_coupon(code, restaurant, items)` from `0161` rather than adding new ones. Vendor coupon edits are already logged in `coupon_changes` by trigger. A vendor discount needing Deligro's approval is a `discount_offer` request whose `proposed_offer` holds `OfferTerms`.
- **Phase 8** reuses `notifyMarketingRequestNew` for the `marketing_request_new` alert, `ops_log_phone_search`/`customer.contact_reveal` audit actions in the Audit log screen, and the customer complaints list query for the generic ticket list.
- **Phase 9** fraud rules read `coupon_redemptions` + `profiles.account_status` (suspension is the action a fraud alert links to).
- **Later:** a "shared" funding split on offers would need `orders.discount_platform_amount` and a settlement-maths change; not built (campaign funding is recorded only).

## Part S execution notes (2026-10-23)

Commits on `feat/manager-p7-server`: 0160–0164 migrations, marketing/offers/customers rules and routes, featured and sponsored placements on web and in the customer app, suspended-account refusals, and the finance-parity fixture fix below.

**Checks run, all passing:** SQL proofs 0160 (52), 0161 (42), 0162 (35), 0163 (16), 0164 (9) and migration-order (33); manager-marketing 62, marketing-rules 51, offers 34, customers 44, customer-campaigns 15, plus every other manager QA script; `tsc` (8 GB) clean; eslint clean on every changed file; `next build` exit 0.

**Customer app:** the release APK builds (61 MB) and cold-starts on `deligro_test` to the real home screen with no FATAL or Flutter errors. It was built with the Manager app's env file passed by path; nothing was copied into `apps/customer`. The suspended-account refusal screen was **not** seen on the device (it needs a suspended customer account); it is covered by tests only.

**Part A notes, answered:**
1. Banner image: the upload route only returns the URL. The app then PATCHes it onto the banner. That PATCH is audited and replay-safe (a repeated client action id does nothing), so repeating it is harmless.
2. A banner image can only be added once the campaign exists (upload needs the campaign id). Kept.
3. `GET /api/manager/orders?customer=<id>` is accepted. A customer outside the manager's zones answers not found.
4. A customer's refunds use Phase 6's `RefundItem` shape; Decide goes through Phase 6's refund route.
5. A customer's complaints use Phase 4's `TicketSummary` shape.
6. Retention with no dates defaults to the last 90 days (IST) and answers `{from, to}`. A campaign with no dates defaults to its own window up to today.

**JSON deviations from the pinned contract:** none.

**Fixed along the way:** `scripts/qa/manager-finance-sql-parity.ts` built its own test table for rider bonus awards without `trigger_earning_id`, which migration 0157 now uses (after the Rider branch merge, a bonus is dated by the earning that triggered it). The parity check crashed with "column does not exist". Added the column to the test table; 234 checks pass again.

**Not a Phase 7 problem, seen in passing:**
- `manager-contract-phase5.ts` fails ("history items exist and carry no earning") on the main branch too; it reads platform settings with no database. Left for the Phase 8 or 10 integration.
- Running dozens of QA scripts back to back on this machine sometimes kills one silently. Each passes when run alone.

**Not verified:** anything that needs a signed-in manager against a real database. The test login is refused by the database, and migrations 0141 onward aren't applied there.
