# Rider App — Phase 7: Help, Safety and Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Riders contact Deligro, raise and follow support tickets with photos, escalate safety emergencies, report incidents; receive every §11 notification as push and in an in-app inbox, with per-category preferences the server honours; admins answer tickets, see incidents first, and send announcements; high-demand, pickup-reminder and delay alerts fire.

**Architecture:** Migration `0087` adds role-generic `support_tickets`, `support_messages`, `user_notifications`, `announcements` and the private `support-attachments` bucket — shared with the Partner app (see the spec's *Shared with the Partner app*; before writing, check `F:\hub26\deligro-vendor` branch `feat/vendor-app` for an existing migration creating any of these tables and, if present, merge that commit instead of re-creating them, adapting this task to its shape). One notification writer (`notifyUser`) records the inbox row and sends the push, respecting preferences. Admin Support and Announcements pages. App: Help, Safety, Notifications screens and the SOS button.

**Spec:** `docs/superpowers/specs/2026-10-21-rider-app-design.md` (*Notifications (§11)*, *Help, safety (§13, §15)*, *Shared with the Partner app*)

## Global Constraints

- Earlier phases' Global Constraints and rulings apply. SECURITY_AUDIT walk logged (new bucket, new readable tables).
- Ticket categories (rider): `vendor_not_handing_over`, `customer_unreachable`, `incorrect_address`, `delivery_payment`, `cash_reconciliation`, `accident_emergency`, `app_technical`, `other` (document §13.3 order); safety categories: `unsafe_situation`, `accident`, `vehicle_breakdown`, `harassment_threat`, `suspicious_order_location`. Priority `normal | high | emergency`; `accident_emergency` and every safety category default to `emergency`.
- Attachments: up to 4 images per message, JPEG/PNG ≤ 5 MB, magic-byte checked, private bucket `support-attachments`, signed URLs.
- Emergency wording (§15): "Call 112" dials 112 on the phone and says so; "Alert Deligro" says "Deligro ops have been alerted" — the app never says emergency services were contacted unless the rider dialled them.
- Notification categories and whether a rider may switch them off: `offers` (no), `cancellations` (no), `safety` (no), `pickup_reminders`, `delivery_updates` (instructions changed, delay alerts), `payouts`, `incentives`, `announcements`, `support`, `cash`, `documents`, `high_demand` (yes). Preferences live in `rider_profiles.notification_prefs` (Phase 6) and are enforced in `notifyUser`.
- Every push a rider receives also creates a `user_notifications` row (except ring stop signals).
- High demand: `platform_settings.high_demand_ratio` (default 2.0 waiting orders per online idle rider, minimum 3 waiting) checked by the sweep; pushed to offline riders who were online in the last 14 days, at most once per 30 min per rider.
- Pickup reminder: an accepted delivery with the order `ready` and no `arrived_pickup_at` after `platform_settings.pickup_reminder_minutes` (default 10) → rider push (once). Delay alert: a picked-up delivery past its ETA by `platform_settings.delay_alert_minutes` (default 10) → rider and ops push (once each).

## Review Focus

1. **SOS pressed with no internet** → the 112 call and the emergency-contact call still work (they are phone calls); "Alert Deligro" queues and shows "Not sent yet — trying again", then sends with the last known location (Task 5 test).
2. **A rider switches off payouts notifications** → the push is suppressed but the inbox entry is still written, so the record is never lost (Task 2 test).
3. **A customer's delivery instructions change while the rider is carrying the order** → the rider gets a `delivery_updates` push and the active screen shows the new text highlighted (Task 2 + Task 5 tests).
4. **Ticket attachments by another user** → signed URL refused (Task 1 proof, Task 2 contract).
5. **Ten emergency alerts in a minute from one rider (panic tapping)** → one ticket, later taps add location updates to it, every manager and admin rung once (Task 2 test on dedupe window 10 min).

---

### Task 1: Migration 0087 — tickets, messages, inbox, announcements, demand settings

**Files:** `supabase/migrations/0087_support_notifications.sql`, `scripts/qa/sql/migration-0087.mjs`, `docs/DATABASE.md`

- `support_tickets (id uuid pk, number bigint generated identity unique, requester_id uuid not null, requester_role text not null, category text not null, priority text not null default 'normal' check in ('normal','high','emergency'), subject text not null, order_id uuid, cash_dispute_id uuid, lat double precision, lng double precision, status text not null default 'open' check in ('open','in_progress','waiting_on_requester','resolved','closed'), assigned_to uuid, created_at, updated_at, resolved_at)`.
- `support_messages (id uuid pk, ticket_id uuid not null → support_tickets on delete cascade, author_id uuid not null, author_role text not null, body text not null check ≤ 4000, attachments text[] not null default '{}' check cardinality ≤ 4, internal boolean not null default false, created_at)`; requesters never see `internal` messages.
- `user_notifications (id uuid pk, user_id uuid not null, role text not null, category text not null, title text not null, title_hi text, body text not null, body_hi text, data jsonb not null default '{}', read_at timestamptz, created_at)`, index `(user_id, created_at desc)`; the user selects own and may update only `read_at` (column-level grant).
- `announcements (id uuid pk, audience text check in ('rider','vendor','manager','all'), title, title_hi, body, body_hi, starts_at timestamptz default now(), ends_at timestamptz, created_by, created_at)`; readable by authenticated users whose role matches the audience.
- `platform_settings`: `high_demand_ratio numeric(4,2) default 2.0`, `pickup_reminder_minutes int default 10`, `delay_alert_minutes int default 10`, `support_phone text default ''`, `support_whatsapp text default ''` (if not already present — reuse the existing support contact settings the customer help page reads when they exist).
- Stamps on `deliveries`: `pickup_reminded_at`, `delay_alerted_at`.
- Bucket `support-attachments` private, 5 MB, jpeg/png.
- RLS: requester selects own tickets and non-internal messages; admins (and managers for rider tickets with `emergency` or delivery categories) select all; inserts through the service role (API).
- Proof: requester can't see internal messages or others' tickets; `read_at` is the only updatable inbox column; announcement audience filter; message attachment count > 4 raises.
- Commit `feat(db): 0087 support tickets, inbox notifications, announcements`.

### Task 2: Server — notifyUser, tickets, SOS, incidents, announcements, demand/reminder/delay sweeps

**Files:** Create `src/lib/notifications/notify-user.ts`, `src/lib/rider/notification-prefs.ts` (pure), `src/lib/data-access/support.ts`, `src/lib/data-access/announcements.ts`, `src/lib/data-access/user-notifications.ts`, routes `src/app/api/rider/support/tickets/route.ts` (GET list, POST create with first message + attachments), `src/app/api/rider/support/tickets/[id]/route.ts` (GET thread), `src/app/api/rider/support/tickets/[id]/messages/route.ts` (POST reply), `src/app/api/rider/sos/route.ts`, `src/app/api/rider/notifications/route.ts` (GET paged, POST mark read / all read), `src/app/api/rider/announcements/route.ts`, `src/app/api/orders/[id]/instructions/route.ts` (customer PATCH while not delivered → rider `delivery_updates` push), `scripts/qa/support-notifications.ts`; Modify `src/lib/notifications/order-events.ts` (every rider push goes through `notifyUser` with a category; ring stop stays raw), `src/lib/dispatch/sweep.ts` (high demand, pickup reminders, delay alerts), Phase 5 cash disputes create a linked `cash_reconciliation` ticket.

**Interfaces:**
```ts
export type NotificationCategory = "offers" | "cancellations" | "safety" | "pickup_reminders" | "delivery_updates" | "payouts" | "incentives" | "announcements" | "support" | "cash" | "documents" | "high_demand";
export async function notifyUser(userId: string, role: string, category: NotificationCategory, text: { title: PushText; body: PushText }, opts?: PushOptions & { url?: string; data?: Record<string, unknown> }): Promise<void>; // writes the inbox row, then pushes unless the category is muted
export function pushAllowed(prefs: Record<string, boolean>, category: NotificationCategory): boolean; // offers/cancellations/safety always true
export async function createTicket(user: { id: string; role: string }, input: { category: string; subject: string; message: string; orderId?: string; attachments?: File[]; lat?: number; lng?: number }): Promise<{ ok: true; id: string; number: number } | { ok: false; error: string }>;
export async function raiseSos(driverId: string, input: { kind: "alert" | "unsafe_situation" | "accident" | "vehicle_breakdown" | "harassment_threat" | "suspicious_order_location"; lat?: number; lng?: number; note?: string; orderId?: string }): Promise<{ ok: true; ticketId: string; deduped: boolean }>;
```
- SOS: creates (or within 10 min appends a location message to) an `emergency` ticket; rings every manager and admin through the ops ring id `ops:sos:<ticketId>`; includes rider name, phone, rider ID, active order code, location link. Never contacts any outside service.
- Admins' and managers' replies push the rider (`support` category); status changes likewise.
- [ ] Steps: tests (Review Focus 2, 5; `pushAllowed` table; sweep thresholds as pure functions `isHighDemand`, `needsPickupReminder`, `needsDelayAlert`) and route contracts → FAIL → implement → script, tsc, lint, idor; SECURITY_AUDIT logged → commit `feat(support): tickets, SOS, inbox notifications, announcements and demand alerts`.

### Task 3: Admin — Support desk, emergencies, announcements; manager emergencies

**Files:** Create `src/app/admin/support/page.tsx`, `src/app/admin/support/[id]/page.tsx`, `src/app/admin/support/actions.ts`, `src/app/admin/announcements/page.tsx` + `actions.ts`; Modify `src/components/admin/admin-nav.ts`, admin home (emergencies banner on top with sound), manager board (emergencies banner, read-only ticket link and call rider), admin rider detail (tickets and incidents list).
- Support desk: filters (role, category, priority, status), emergencies pinned and red, thread view with attachments (signed URLs), reply (public or internal note), status change, assign to self; announcement composer (audience, English + Hindi, schedule) with a preview and a list of sent announcements (each fan-outs through `notifyUser` with category `announcements`).
- [ ] Steps: action parser tests + non-admin forbidden → FAIL → implement → tsc, lint, platform; screenshots → commit `feat(admin): support desk, emergencies and announcements`.

### Task 4: App — Help and Notifications

**Files:** Create `apps/rider/lib/features/help/{help_screen,new_ticket_screen,ticket_thread_screen}.dart`, `apps/rider/lib/features/notifications/notifications_screen.dart`, `apps/rider/lib/data/support_repository.dart`, `apps/rider/lib/data/notifications_repository.dart`; Modify More (Help, Notifications with unread badge), Settings (notification categories with locked ones explained), header bell on Home with unread count, push tap routing by `data.category`/`data.url` (jobs, ticket, earnings, cash, documents, announcements).
- Help: call / WhatsApp Deligro support (settings numbers), FAQ for riders (bilingual, static, factual about the app), raise a ticket (category list in §13.3 order, optional order picker from recent history, message, up to 4 photos), tickets list with status, thread with replies and attachments, reply.
- Notifications: inbox grouped by day, unread dot, mark all read, announcements pinned at top while active.
- [ ] Steps: widget tests (categories order; 5th photo refused; thread shows staff replies but no internal notes (server already filters — the test uses a fixture); unread badge; muted categories saved; locked ones can't be switched; Hindi; light/dark/1.3×) → FAIL → implement → analyze, test, release build, emulator screenshots → commit `feat(rider-app): Help desk and notification inbox`.

### Task 5: App — Safety and SOS

**Files:** Create `apps/rider/lib/features/safety/{safety_screen,sos_sheet,incident_report_screen}.dart`, `apps/rider/lib/data/safety_repository.dart`; Modify the active-delivery screen (SOS button in the header), Home (Safety row), More (Safety), the action queue (SOS alerts queue with highest priority and retry every 15 s).
- SOS sheet: **Call 112** ("This calls 112 from your phone"), **Alert Deligro** (sends location; shows "Deligro ops have been alerted" only after the server confirms, otherwise "Not sent yet — trying again"), **Call my emergency contact** (from profile; hidden when not set, with a link to add one), **Call Deligro support**. Safety screen: the same plus report forms (unsafe situation, accident, breakdown, harassment or threats, suspicious order or location) with note, photos and location.
- [ ] Steps: widget tests (Review Focus 1; wording assertions — no string anywhere in the safety feature claims emergency services were contacted; emergency contact missing state; Hindi; light/dark/1.3×) → FAIL → implement → analyze, test, release build, emulator screenshots → commit `feat(rider-app): Safety screen and SOS`.

---

## Phase exit

Proofs and QA pass; SECURITY_AUDIT logged; tsc, lint, idor, platform; Flutter analyze/test; release walkthrough including an SOS round trip on the fixture build; report.
