# Vendor App — Phase 2: Orders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Requirements §3 (order management) complete in the Partner app: a live board with the six statuses, every order field, accept with prep time, start preparing, ready, reject with reason, status history, past and cancelled orders, instant notification and an audible ring, reminders for orders left waiting.

**Architecture:** Extend the existing vendor order data access (no second path); thin vendor routes over it; the app polls the board every 8 s while open and rings natively (a Kotlin port of `mobile/native/RingService.java` plus the OneSignal extension) on the existing `{ring, ringId}` push protocol.

**Spec:** `docs/superpowers/specs/2026-10-21-vendor-app-design.md` (Statuses table; §3).

## Global Constraints

- Phase 1's constraints apply (worktree, AGENTS.md rules, `tr()` pairs, release-APK emulator check).
- App statuses map as in the design's Statuses table: New = `placed`; Accepted = `kitchen` ∧ `preparing_at` null; Preparing = `kitchen` ∧ `preparing_at` set; Ready = `ready`; Completed = `on_the_way` | `delivered`; Cancelled = `cancelled`. One shared definition per side: `src/lib/orders/kitchen-stage.ts` (server) and `lib/models/order.dart` (app).
- Status changes go through `PATCH /api/orders/[id]/status` (pushes, dispatch, refunds, ring stop) or `start_preparing` — never a direct table write from the app.
- Customer phone numbers are shown only while an order is active (`placed`…`on_the_way`), per §15.8.
- Prep time: 1–180 minutes (0061 constraint).

## Review Focus

1. Two vendors' phones (or the web board) act on the same order → the second gets `invalid_transition` and the app refreshes instead of showing a stale card.
2. An online order not yet paid → never on the board (existing PAID_OR_COD filter), so the kitchen never cooks unpaid food.
3. The app is killed or in the background when an order arrives → the native ring still sounds (push extension), and stops on every phone when the order is accepted or rejected anywhere.
4. Network drops while the board is open → the last board stays visible with a "can't refresh" notice; actions show the error; nothing is silently lost.
5. Reject feature switched off for the shop → no Reject button, and the server still refuses.

---

### Task 1: Server — board, detail, prep time, start preparing
Files: `src/lib/orders/kitchen-stage.ts` (new, pure), `src/lib/data-access/vendor-orders.ts`, `src/lib/roles-data.ts` (KitchenOrder fields), `src/app/api/vendor/orders/board/route.ts`, `src/app/api/vendor/orders/[id]/route.ts`, `src/app/api/vendor/orders/[id]/preparing/route.ts`, `src/app/api/orders/[id]/status/route.ts`, `scripts/qa/kitchen-stage.ts`.
- `kitchenStage({status, preparingAt}) → "new"|"accepted"|"preparing"|"ready"|"completed"|"cancelled"`; `parsePrepMinutes(unknown) → number|null` (integer 1–180).
- KitchenOrder gains `createdAt`, `preparingAt`, `prepMinutes`, `itemsSubtotal`, `deliveryFee`, `taxAmount`, `tip`, `discount`, `couponCode`, `discountFundedBy`, `cancellationReason`, `channel`, `stage`. 0061 columns behind their own probe group.
- `updateKitchenOrderStatus(id, status, reason?, prepMinutes?)` writes `prep_minutes` with the accept.
- `startPreparing(id)` → rpc `start_preparing`; `invalid_transition` → 409.
- `getVendorOrderDetail(id, restaurantId)` → order + `events[]` (order_status_events) + pickup code + rider; phone dropped unless active.
- Routes: `GET /api/vendor/orders/board` → `{orders, serverTime}`; `GET /api/vendor/orders/:id`; `POST /api/vendor/orders/:id/preparing` (rate-limited 60/min/user); status route accepts `prepMinutes`.
- QA: `scripts/qa/kitchen-stage.ts` (mapping table, prep parsing bounds).

### Task 2: Server — reminders for waiting orders
`src/lib/dispatch/sweep.ts`, `src/lib/notifications/order-events.ts`: when the sweep's kitchen-slow alarm fires (3 min unaccepted), the vendor also gets "Order #X is still waiting" (en/hi), with a fresh ring start so a silenced phone rings again.

### Task 3: App — order models, repository, live board state
`lib/models/order.dart`, `lib/data/orders_repository.dart`, `lib/state/orders.dart`, `test/orders_model_test.dart`.
- `VendorOrder.fromJson`, `OrderStage` enum with `fromStatus(status, preparingAt)` mirroring kitchen-stage.ts; money getters.
- Repository: `board()`, `history(kind, range, date, search)`, `detail(id)`, `accept(id, prepMinutes)`, `startPreparing(id)`, `markReady(id)`, `reject(id, reason)`.
- `boardProvider`: polls every 8 s while listened to; keeps the last good board on a failed poll and exposes `stale`.

### Task 4: App — Orders tab
`lib/features/orders/orders_screen.dart`, `order_card.dart`, `history_view.dart`, `test/orders_screen_test.dart`.
- Live: chips All · New · Accepted · Preparing · Ready · Out for delivery, with counts; search by order ID or customer name; cards with ID, time, item count, delivery/pickup, stage pill, payment chip, amount; pull to refresh; stale notice.
- Past: Completed / Cancelled with All · This month · Last month · Pick a date, and search (existing history API).

### Task 5: App — order detail and actions
`lib/features/orders/order_detail_screen.dart`, `accept_sheet.dart`, `reject_sheet.dart`, `test/order_detail_test.dart`.
- Every §3 field: ID, date/time, items with qty and item prices, subtotal, discount (and who funds it), delivery fee, tax, tip, total, payment method and status, delivery address or pickup, customer (call button while active), cancellation reason, status timeline from events, pickup code and rider at Ready.
- Actions by stage: New → Accept (prep time chips 10/15/20/30/45/60 + custom, default the shop's) and Reject (reasons + other, hidden when `vendor.reject_orders` is off); Accepted → Start preparing; Preparing → Mark ready.

### Task 6: App — the ring
`android/app/src/main/kotlin/com/ractrotech/deligro/partner/{RingService.kt,RingNotificationExtension.kt,MainActivity.kt}`, `res/raw/deligro_ring.wav` (rendered from the web's two-tone chime), manifest permissions + service + OneSignal extension meta-data, `lib/core/ring.dart` (MethodChannel `deligro/ring`: start, stop, setup, openSettings), board-driven ring while the app is open, ring readiness card in Orders/Settings, `test/ring_test.dart`.
