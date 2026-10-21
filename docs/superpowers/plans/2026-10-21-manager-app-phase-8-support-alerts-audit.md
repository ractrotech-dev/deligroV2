# Manager App — Phase 8: Support, alerts & audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager works every vendor, rider and customer ticket in their zones end to end (filter, assign, attach, note, respond, escalate, resolve, measure, spot recurring problems — §11); receives the thirteen §14 alerts plus rider inactivity and failed deliveries (§6.7–6.8) once each, scoped to their zones and honouring their notification preferences (§15.7), with configurable thresholds; has an in-app inbox; and can read an audit log in which every sensitive action of phases 1–7 provably appears and nothing can be edited, with no personal data in any payload they are not entitled to (§16).

**Architecture:** Task P0 merges the sibling branches and records whether Rider `0087` (tickets, `user_notifications`) has landed. Four migrations: `0165` (ticket assignment, priority, ticket events, legal transitions, ticket metrics RPC, audited ticket RPCs), `0166` (`ops_alert_rules`, `ops_alerts`, raise/clear/acknowledge/resolve/rule RPCs, default rules), `0167` (inbox: `user_notifications` with the Rider 0087 shape if absent; manager read paths), `0168` (audit read indexes and any audit gaps found by S7); `0169` is held for fixes. One pure alert catalog and evaluator (`src/lib/ops/alerts/*`) reuse Phase 3's `liveSignals`, Phase 5's rider rules and Phase 6's `finance-rules.ts`; one staff notifier (`src/lib/notifications/ops-notify.ts`) replaces the zone-blind `notifyOps`. The Flutter app adds Support, Alerts, Inbox, Alert thresholds and Audit log, coded against the JSON pinned below with fake repositories.

**Tech Stack:** Supabase Postgres (RPCs, RLS, triggers, storage), Next.js route handlers (read `node_modules/next/dist/docs/` first), OneSignal (existing `sendPush`), Flutter 3.47 / Riverpod 3 / go_router, `fl_chart`, `image_picker`, `file_picker`.

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (§11, §14, §6.7–6.8, §15.7, §16, Alerts, Audit log, Permissions). Earlier plans: phases 1–7 — Phase 1 (`managerApiContext`, `applyZoneScope`, `narrowScope`, `ops_audit_log` + `_ops_log`, `notification_preferences`, `OPS_ALERT_KINDS`, `GET/PUT /api/manager/notification-prefs`, "My activity"), Phase 2 fix `0144` (ops metrics rollups), Phase 3 (`ops_require_staff`, `_ops_set_actor`, `0143` tickets + `escalated`, `src/lib/ops/live-rules.ts` `liveSignals` and thresholds, `OpsActor`, contract emitter), Phase 4 (`support_tickets.restaurant_id`, `TicketSummary`, ticket thread / messages / status endpoints, `ops_add_ticket_message`, `ops_set_ticket_status`, `TicketsRepository`, `/more/tickets/:id`), Phase 5 (`rider-rules.ts`, `cash_deposits`, cash disputes, `delivery_exceptions` decisions, `payment_requests`), Phase 6 (`finance-rules.ts` issue types and thresholds, cash reconciliation states, report registry `support` builder), Phase 7 (`marketing_requests` with `status = 'pending'`, `ops_decide_marketing_request`). Neighbouring: Rider phase 7 plan (`0087` shapes, `notifyUser`, sweep changes).

## Execution layout — two halves in parallel

| Half | Worktree | Branch | Touches |
|---|---|---|---|
| **Part S (server)** | `F:\hub26\deligro-manager-p8s` | `feat/manager-p8-server` | `supabase/`, `scripts/`, `src/`, `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md` |
| **Part A (app)** | `F:\hub26\deligro-manager-p8a` | `feat/manager-p8-app` | `apps/manager/` only |

P0 runs first in `F:\hub26\deligro-manager` on `feat/manager-app`; both halves branch from the commit that closes P0. They share no files. When both are done: merge S, then A, into `feat/manager-app`, then run **Task I1**. Remove both worktrees afterwards (`git worktree remove`, `git branch -d`). Copy `.env.local` and `apps/manager/env/*.json` into each new worktree (gitignored).

## Global Constraints

- Phase 1–7 Global Constraints apply (AGENTS.md rules; migrations 0141–0199, this phase **0165–0169**; F:\dev build env; release-APK smoke test; commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never touch `F:\hub26\deligro`, `deligro-rider`, `deligro-vendor`; never bare `git stash`.
- **English only on the manager side (owner rule).** No `tr(en, hi)` in any code this phase adds; plain English strings in the app. Every push, inbox row and alert title/body addressed to a manager or admin is English only (`title_hi`/`body_hi` null; a bilingual `PushText` is sent with `hi` equal to `en`). Notifications to vendors, riders and customers (ticket replies, status changes) keep whatever language handling their own app uses — this rule does not change them.
- **Every audited write is one RPC that changes and logs in the same transaction** (`_ops_log`). RPC pattern from 0142: `security definer set search_path = public`, `_ops_set_actor`, `ops_require_staff(actor, zone)` first, replay-safe on `p_client_action_id`, `revoke execute … from public, anon, authenticated; grant execute … to service_role`.
- **Permissions:** tickets (list, thread, reply, assign, priority, escalate, status, metrics, attachments) → `manager.support.manage`; alerts list/acknowledge/resolve/raise incident and inbox → any manager (no switch; scope still applies); alert thresholds read → any manager, write → `manager.alerts.configure`; audit log → `manager.audit.view_zone` (own activity stays in Profile without it). Admins have all.
- **Zone scope** on every read: tickets by `support_tickets.zone_id`; alerts by `ops_alerts.zone_id` (`null` = platform-wide: visible to admins, and to managers only for kind `incident`); audit by `ops_audit_log.zone_id` (`null`-zone rows are admin-only); inbox by `user_id = caller`. Out-of-scope ids → **404 `not_found`**.
- **Alert audiences** add a permission filter on top of zone: `settlement_delayed`, `rider_payout_issue`, `cash_discrepancy` → recipients need `manager.finance.view`; `marketing_request_new` → `manager.marketing.manage`; `complaint_high_priority` → `manager.support.manage`. The alerts list applies the same filter, so a manager never sees an alert they could not act on.
- **Internal notes never reach a requester**: not in requester API payloads, pushes, inbox rows, emails, or ticket `subject`. Asserted in S1 (RLS) and S8 (payload scan).
- Polling: Alerts and Support queue every 15 s while visible; unread badge every 30 s; paused in background.

## Claude's calls

- **Ticket statuses.** The database keeps 0087's `open | in_progress | waiting_on_requester | resolved | closed` plus 0143's `escalated`. The app shows the client's five statuses; `waiting_on_requester` is displayed as "In Progress · waiting on requester". Legal transitions (enforced in `ops_set_ticket_status`, re-declared): `open → in_progress | waiting_on_requester | escalated | resolved`; `in_progress → waiting_on_requester | escalated | resolved`; `waiting_on_requester → in_progress | escalated | resolved`; `escalated → in_progress | waiting_on_requester | resolved`; `resolved → closed | in_progress` (reopen, reason required); `closed` is final. `resolved` requires `resolution` 3–1000 chars; `closed` reuses it (required only if not already set). A requester reply on a `resolved` ticket reopens it to `in_progress` (trigger).
- **Escalation** = `escalation_level + 1` (max 3) and status `escalated`; level 1 notifies the zone's managers with `support.manage`, level ≥ 2 also every admin; reason required. Assignment: assignee must be an admin, or a manager with `manager.support.manage` and the ticket's zone in their `staff_zones` (`assignee_ineligible`); `team` is free text from a fixed list (`operations`, `finance`, `vendor_support`, `rider_support`, `customer_support`). Assigning pushes the assignee.
- **Priority changes** by staff need a reason; raising to `emergency` opens a `complaint_high_priority` alert immediately.
- **Ticket history** = new `support_ticket_events` (status, assignment, team, priority, escalation, reopen, first response, attachment added) written by trigger on `support_tickets` updates and `support_messages` inserts; the thread endpoint merges events and messages chronologically. `ops_audit_log` keeps its own rows for staff actions (who, why); events give the requester-safe history (internal-message events are flagged `internal` and filtered from requester views).
- **Metrics:** first-response time = `first_response_at − created_at`; resolution time = `resolved_at − created_at` (first resolution; a reopen does not reset it but the ticket counts as `reopened`). Averages and medians over tickets **created** in the range; open tickets excluded from resolution averages, reported as `openOverSla` instead. Recurring problems over the range: top 5 categories, vendors (`restaurant_id`), riders (the order's delivery rider, or the requester when role `driver`), zones, and orders with ≥ 2 tickets — each with count and share.
- **Alert lifecycle.** One row per `dedupe_key` (e.g. `order_unassigned:<order_id>`, `high_cancellation_rate:<zone_id>:<yyyy-mm-dd-hh>`); `ops_raise_alert` upserts — an open/acknowledged alert is updated (severity may rise, `last_seen_at` moves), never duplicated; a resolved alert with the same key reopens the same row (`reopen_count + 1`) and **does not push again inside a 15-minute cooldown** (anti-flap). The evaluator resolves (`resolved_by = null`, `resolution = 'cleared'`) every open alert of an evaluated kind whose condition no longer holds. Manual resolve requires a note; acknowledged alerts keep evaluating and auto-resolve when cleared.
- **Muting.** `notification_preferences(kind).push = false` suppresses the push only; the inbox row is still written and the alert still shows on screen. `incident` and `complaint_high_priority` at `critical` severity (emergency tickets) cannot be muted — the prefs endpoint refuses them (`not_mutable`) and the notifier ignores a stored mute.
- **Evaluation cadence.** `evaluateAlerts()` runs from `sweepDispatch()` (cron route and the boards' throttled `maybeSweepDispatch`), throttled to once per 60 s platform-wide by a `claimAlarm`-style lease row (`ops_alert_runs`), plus immediate event hooks for the event-shaped kinds (`delivery_failed`, `marketing_request_new`, `complaint_high_priority`, `incident`, `cash_discrepancy` on dispute). The existing `notifyOpsKitchenSlow` / `notifyOpsNoRider` / `notifyOpsStuck` calls in `sweep.ts` are replaced by raising `order_needs_intervention` / `order_unassigned`; the vendor re-ring (`notifyVendorStillWaiting`) stays.
- **The thirteen kinds** (thresholds per zone; `null`-zone rule is the default; units fixed):

| Kind (§14 #) | Condition | Threshold (default) | Window | Severity | Dedupe |
|---|---|---|---|---|---|
| `order_needs_intervention` (1) | `placed` not accepted for ≥ T min (COD at once, online once paid); or a `delivery_exceptions` row `pending` ≥ T min; or an active order with no status change ≥ 3·T min ("stuck") | 5 min | — | warning; critical at 3·T | `…:<order_id>` |
| `order_unassigned` (2) | Phase 3 `order_unassigned` signal, minutes ≥ T | 5 min | — | warning; critical ≥ 3·T | `…:<order_id>` |
| `delivery_delayed` (3) | Phase 3 `delivery_delayed`, late by ≥ T | 10 min | — | warning; critical ≥ 3·T | `…:<order_id>` |
| `high_cancellation_rate` (4) | zone cancelled ÷ placed over the window ≥ T % and placed ≥ 5 | 20 % | 60 min | warning; critical ≥ 2·T | `…:<zone>:<window start hour>` |
| `vendor_downtime` (5) | vendor inside its scheduled hours (0062) but closed (`is_open = false` or `closed_until > now`) for ≥ T min, or ≥ 2 orders auto-cancelled/unaccepted in the window | 30 min | 60 min | warning | `…:<restaurant_id>:<IST date>` |
| `rider_shortage` (6) | active orders without a rider ÷ max(1, online idle riders) ≥ T, or online riders = 0 while any active order exists | 2.0 | — | warning; critical when 0 riders | `…:<zone>` |
| `delivery_failed` (7) | a delivery becomes `failed` (event hook; sweep backstop for the last 2 h) | — | — | critical | `…:<delivery_id>` |
| `settlement_delayed` (8) | Phase 6 `settlement_delayed` issue for a vendor | cycle + 3 d (Phase 6 constant) | — | per `issueSeverity` | `…:<restaurant_id>` |
| `rider_payout_issue` (9) | Phase 6 `rider_payout_delayed`, or a `rider_payout` `payment_requests` row `pending_approval` ≥ 48 h | 35 d / 48 h | — | per `issueSeverity` | `…:<rider_id>` |
| `marketing_request_new` (10) | `marketing_requests.status = 'pending'` (event hook on insert) | — | — | info | `…:<request_id>` (cleared when decided) |
| `complaint_high_priority` (11) | ticket priority `high`/`emergency` not resolved/closed; or any ticket with no first response after T min | 30 min | — | warning; critical for `emergency` | `…:<ticket_id>` |
| `cash_discrepancy` (12) | Phase 6 cash reconciliation `pending` with gap ≥ ₹T older than 12 h, or `disputed` | ₹500 | 12 h | warning; critical when disputed | `…:<rider_id>:<IST date>` |
| `incident` (13) | an `obs_incidents` row not `resolved`/`closed` (zone null), or a manager-raised incident | — | — | from the incident (`critical`/`high` → critical) | `…:obs:<id>` / `…:manual:<uuid>` |
| `rider_inactive` (§6.7) | Phase 3 `rider_inactive` signal (active delivery, last fix older than T) | 5 min | — | warning | `…:<rider_id>:<delivery_id>` |

  `fraud_suspected` and `sla_breach` stay in the catalog with `enabled = false` defaults; Phase 9 adds their evaluators.

## API contract (pinned — both halves code to this)

JSON; errors `{ "error": "<code>", …extra }`; timestamps ISO-8601 UTC; ids uuid unless stated.

### Shared shapes

```jsonc
// TicketListItem = Phase 4 TicketSummary plus
{ "zoneId": "uuid|null", "restaurant": { "id": "uuid", "name": "…" } /* or null */,
  "requester": { "id": "uuid", "name": "…", "role": "restaurant|driver|customer|manager|admin" },
  "assignee": { "id": "uuid", "name": "…" } /* or null */, "team": "operations|finance|vendor_support|rider_support|customer_support|null",
  "escalationLevel": 0, "firstResponseAt": "…|null", "resolvedAt": "…|null", "ageMinutes": 42,
  "awaitingFirstResponse": true, "unreadForStaff": 2 }
// TicketEvent
{ "id": 91, "at": "…", "kind": "created|status|assigned|team|priority|escalated|reopened|first_response|attachment",
  "from": "…|null", "to": "…|null", "actor": { "id": "uuid", "name": "…", "role": "…" } /* or null */, "reason": "…|null", "internal": false }
// Alert
{ "id": "uuid", "kind": "order_needs_intervention|order_unassigned|delivery_delayed|high_cancellation_rate|vendor_downtime|rider_shortage|delivery_failed|settlement_delayed|rider_payout_issue|marketing_request_new|complaint_high_priority|cash_discrepancy|incident|rider_inactive|fraud_suspected|sla_breach",
  "severity": "info|warning|critical", "status": "open|acknowledged|resolved",
  "title": "Order AB12CD34 has no rider", "body": "Ready for 9 min at Spice Hub.",
  "zoneId": "uuid|null", "entity": { "type": "order|delivery|restaurant|rider|ticket|marketing_request|settlement|payment_request|cash_day|zone|incident", "id": "string" },
  "openedAt": "…", "lastSeenAt": "…", "reopenCount": 0,
  "acknowledgedBy": { "id": "uuid", "name": "…" } /* or null */, "acknowledgedAt": "…|null",
  "resolvedAt": "…|null", "resolution": "cleared|<note>|null", "resolvedBy": { "id": "uuid", "name": "…" } /* null when cleared */ }
// AlertRule
{ "kind": "…", "zoneId": "uuid|null", "inherited": true, "enabled": true, "threshold": 5, "unit": "minutes|percent|ratio|rupees|none",
  "windowMinutes": 60 /* or null */, "updatedBy": { "id": "uuid", "name": "…" } /* or null */, "updatedAt": "…|null", "label": "Unassigned orders", "description": "…" }
// InboxItem
{ "id": "uuid", "category": "<alert kind>|ticket_activity|system", "title": "…", "body": "…", "data": { "url": "/orders/…", "alertId": "uuid" },
  "readAt": "…|null", "createdAt": "…" }
// AuditEntry
{ "id": 1203, "at": "…", "actor": { "id": "uuid", "name": "…", "role": "manager|admin|system" }, "action": "delivery.reassign",
  "entityType": "order", "entityId": "…", "zoneId": "uuid|null", "reason": "…|null",
  "before": { } /* or null */, "after": { } /* or null */, "clientActionId": "…|null" }
```

### Tickets (extends Phase 4)

- `GET /api/manager/tickets` — query `status` (comma list of db statuses, or `active` = open,in_progress,waiting_on_requester,escalated), `category`, `priority` (comma), `requesterRole` (comma), `from`, `to` (created_at), `zone`, `assignee` (`me|unassigned|<uuid>`), `team`, `vendor`, `rider`, `q` (ticket number or subject substring ≥ 3 chars), `cursor`, `limit` (≤ 100, default 50). Order: `escalated` and `emergency` first, then `created_at desc`. 200 `{ "items": [TicketListItem], "nextCursor": "…|null", "counts": { "open": 4, "in_progress": 2, "waiting_on_requester": 1, "escalated": 1, "resolved": 9, "closed": 30, "unassigned": 3, "mine": 2 } }`. 400 `bad_request` (`field`).
- `GET /api/manager/tickets/[id]` — Phase 4 body plus `"ticket": { …, "assignee", "team", "requester", "allowedTransitions": ["in_progress", …] }` and `"events": [TicketEvent]`; `messages[].attachments` unchanged (signed 60 s).
- `POST /api/manager/tickets/[id]/messages` — Phase 4 JSON body **or** `multipart/form-data` with `body`, `internal`, `clientActionId`, `files[]` (≤ 4, jpeg/png/webp/pdf, ≤ 5 MB each) → 201 `{ "ok": true }`. 400 `bad_file`.
- `POST /api/manager/tickets/[id]/status` — Phase 4 body plus `"reason"` (required for reopen `resolved → in_progress`). 409 `invalid_transition` (`{ "allowed": [...] }`).
- `POST /api/manager/tickets/[id]/assign` `{ "assigneeId": "uuid|null", "team": "…|null", "clientActionId": "uuid" }` → 200 `{ "ok": true }`; 409 `assignee_ineligible`.
- `POST /api/manager/tickets/[id]/priority` `{ "priority": "normal|high|emergency", "reason": "3–300", "clientActionId": "uuid" }` → 200.
- `POST /api/manager/tickets/[id]/escalate` `{ "reason": "3–300", "clientActionId": "uuid" }` → 200 `{ "ok": true, "level": 2 }`; 409 `max_level`.
- `GET /api/manager/tickets/assignees?zone=` → `{ "staff": [{ "id": "uuid", "name": "…", "role": "manager|admin", "openAssigned": 3 }], "teams": ["operations", …] }`.
- `GET /api/manager/tickets/metrics?from&to&zone` → `{ "range": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }, "created": 40, "resolved": 31, "reopened": 2, "openOverSla": 3,
  "firstResponse": { "avgMinutes": 22, "medianMinutes": 15, "count": 38 }, "resolution": { "avgMinutes": 410, "medianMinutes": 180, "count": 31 },
  "byStatus": { "open": 4, … }, "byPriority": { "normal": 30, "high": 8, "emergency": 2 }, "byRequesterRole": { "customer": 25, "restaurant": 9, "driver": 6 },
  "recurring": { "categories": [{ "key": "order_issue", "label": "Order issue", "count": 12, "share": 0.3 }], "vendors": [{ "id": "uuid", "name": "…", "count": 5, "share": 0.125 }],
                 "riders": [{ "id": "uuid", "name": "…", "code": "DR-0004|null", "count": 3, "share": 0.075 }], "zones": [{ "id": "uuid", "name": "…", "count": 40, "share": 1 }],
                 "orders": [{ "id": "uuid", "code": "AB12CD34", "count": 2 }] },
  "daily": [{ "date": "YYYY-MM-DD", "created": 3, "resolved": 2 }], "generatedAt": "…" }`. Range ≤ 366 days (400 `range_too_long`).

### Alerts and thresholds

- `GET /api/manager/alerts` — query `status` (`open|acknowledged|resolved`, comma; default `open,acknowledged`), `kind` (comma), `severity` (comma), `zone`, `from`, `to` (opened_at; resolved defaults to last 7 days), `cursor`, `limit` → `{ "items": [Alert], "nextCursor": "…|null", "counts": { "open": 5, "acknowledged": 2, "critical": 1 } }` (critical first, then `lastSeenAt desc`).
- `GET /api/manager/alerts/[id]` → `{ "alert": Alert, "history": [{ "at": "…", "event": "opened|escalated_severity|acknowledged|resolved|cleared|reopened", "actor": { "id", "name" } | null, "note": "…|null" }] }`.
- `POST /api/manager/alerts/[id]/actions` `{ "action": "acknowledge|resolve", "note": "required for resolve, 3–300", "clientActionId": "uuid" }` → 200 `{ "alert": Alert }`; 409 `already_resolved`.
- `POST /api/manager/alerts/incident` `{ "title": "3–120", "body": "3–1000", "severity": "warning|critical", "zoneId": "uuid", "clientActionId": "uuid" }` → 201 `{ "alert": Alert }` (kind `incident`, entity `{ "type": "incident", "id": "manual:<uuid>" }`).
- `GET /api/manager/alert-rules?zone=` → `{ "rules": [AlertRule] }` — one per kind; for a zone, its own rule or the inherited default (`inherited: true`).
- `PUT /api/manager/alert-rules` `{ "kind": "…", "zoneId": "uuid|null", "enabled": true, "threshold": 7, "windowMinutes": 60, "clientActionId": "uuid" }` → 200 `{ "rule": AlertRule }`. `zoneId: null` (platform default) admin-only (403 `permission_denied`); threshold bounds per unit (minutes 1–1440, percent 1–100, ratio 0.5–20, rupees 50–100000) else 400 `bad_threshold`. `DELETE /api/manager/alert-rules?kind&zone` (zone required) → revert to inherited.
- `GET /api/manager/notification-prefs` (Phase 1) adds `"locked": ["incident", "complaint_high_priority"]` (critical delivery cannot be muted; the switch shows on but disabled); `PUT` with a locked kind and `push:false` → 400 `not_mutable`.

### Inbox

- `GET /api/manager/notifications?cursor&unread=1` → `{ "items": [InboxItem], "nextCursor": "…|null", "unread": 7 }`.
- `GET /api/manager/notifications/unread-count` → `{ "unread": 7, "openAlerts": 5, "criticalAlerts": 1 }`.
- `POST /api/manager/notifications/read` `{ "ids": ["uuid"] }` or `{ "all": true }` → 200 `{ "unread": 0 }`.

### Audit log

- `GET /api/manager/audit` — query `actor` (uuid), `action` (exact or prefix ending `.*`, e.g. `order.*`), `entityType`, `entityId`, `zone`, `from`, `to`, `cursor`, `limit` → `{ "items": [AuditEntry], "nextCursor": "…|null" }` (newest first). 403 `permission_denied` without `manager.audit.view_zone`.
- `GET /api/manager/audit/[id]` → `{ "entry": AuditEntry, "diff": [{ "path": "status", "before": "ready", "after": "kitchen" }] }`.
- `GET /api/manager/audit/actions` → `{ "actions": [{ "code": "delivery.reassign", "label": "Rider reassigned", "group": "Orders" }] }` (the S7 catalog).
- `before`/`after` never contain phone numbers, emails, addresses, bank or document numbers (S7 asserts the RPCs strip them; S8 asserts the route redacts `phone|mobile|email|address|account|ifsc|aadhaar|pan` keys as a backstop).

## Requirement coverage

| Spec item | Task |
|---|---|
| §11.1 view all vendor, rider, customer tickets | S5 (list), A2 |
| §11.2 filter by issue type, status, date, priority | S5, A2 (+ requester role, zone, assignee) |
| §11.3 assign to personnel or teams | S1 (`ops_assign_ticket`), S5, A2 |
| §11.4 attachments and issue history | S1 (`support_ticket_events`), S5 (multipart, thread events), A2 |
| §11.5 update ticket status | S1 (transitions), S5, A2 |
| §11.6 internal notes | Phase 4 (`internal`), S1 (RLS re-assert, events flag), S8, A2 |
| §11.7 respond to complaints | Phase 4 reply + S3 (requester inbox/push via `notifyUser`), A2 |
| §11.8 escalate unresolved issues | S1 (`ops_escalate_ticket`), S4 (`complaint_high_priority`), S5, A2 |
| §11.9 record resolution details | S1 (resolution required), A2 |
| §11.10 average resolution time | S1 (`ops_ticket_metrics`), S5, A2 (metrics screen); Phase 6 `support` report reuses it |
| §11.11 recurring operational problems | S1 (`recurring`), S5, A2 |
| §11 statuses Open, In Progress, Escalated, Resolved, Closed | S1, A2 (display mapping) |
| §14.1 new orders requiring intervention | S4 `order_needs_intervention` |
| §14.2 unassigned orders | S4 `order_unassigned` |
| §14.3 delayed deliveries | S4 `delivery_delayed` |
| §14.4 high cancellation rates | S4 `high_cancellation_rate` |
| §14.5 vendor downtime | S4 `vendor_downtime` |
| §14.6 rider shortages | S4 `rider_shortage` |
| §14.7 failed deliveries / §6.8 | S4 `delivery_failed` (event hook + backstop) |
| §14.8 vendor settlement delays | S4 `settlement_delayed` |
| §14.9 rider payout issues | S4 `rider_payout_issue` |
| §14.10 new marketing requests | S4 `marketing_request_new` |
| §14.11 high-priority complaints | S4 `complaint_high_priority` |
| §14.12 cash reconciliation discrepancies | S4 `cash_discrepancy` |
| §14.13 technical or operational incidents | S4 `incident` (obs + manual), S6, A3 |
| §14 configurable thresholds | S2 (`ops_alert_rules`, `ops_set_alert_rule`), S6, A4; admin page S6 |
| §6.7 rider inactivity alerts | S4 `rider_inactive` |
| §15.7 notification preferences (server-side) | S3 (`ops-notify.ts` honours prefs, locked kinds), S6, A3 |
| §16.1 record important manager actions | S7 (catalog + structural + PGlite spot checks), S6 (viewer), A4 |
| §16.2 order reassignment | Phase 3 `ops_reassign_delivery`; S7 asserts |
| §16.3 vendor & rider status changes | Phases 4/5 RPCs; S7 asserts |
| §16.4 commission or settlement adjustments | Phase 6 RPCs; S7 asserts |
| §16.5 offer and campaign changes | Phase 7 RPCs + `coupon_changes`; S7 asserts |
| §16.6 payment approvals | Phases 5/6 `payment_requests` RPCs; S7 asserts |
| §16.7 timestamps & account ids | 0141 schema; S6 viewer shows both |
| §16.8 prevent unauthorised modification | S7 structural test (no manager write route writes tables directly; every route opens with its permission) |
| §16.9 restrict sensitive financial actions | S7 (route → permission map vs catalog defaults off) |
| §16.10 protect customer & rider personal information | S8 (payload scan across permission sets), audit redaction |
| §16 audit not editable by ordinary managers | 0141 trigger (re-asserted in S2 proof) |

## Review Focus

1. **Alert storms and duplicates.** The cron sweep and two boards' `maybeSweepDispatch` run at the same moment, and a condition flaps (rider assigned, then unassigned) → one alert row per `dedupe_key`, one push per opening, no re-push within the 15-min cooldown after a reopen; the 60 s lease keeps evaluation single-flight. (S2 PGlite concurrent upsert; S4 QA with two parallel `evaluateAlerts` calls; S4 flap test.)
2. **Zone and permission leaks through alerts, pushes and inbox.** A zone-A manager never gets a zone-B alert, push or inbox row; a manager without `finance.view` never sees `cash_discrepancy`/`settlement_delayed`/`rider_payout_issue`; platform-wide (`null` zone) alerts reach managers only for `incident`. (S3 recipient QA, S6 route QA, S2 RLS proof.)
3. **Internal notes reaching a requester.** An internal message never appears in the requester's thread, push, inbox row or the ticket list's last-message preview; events for internal messages are hidden from the requester. (S1 PGlite, S8 payload scan, A2 widget test for the internal label.)
4. **Muted or locked preferences.** A muted kind produces no push but still an inbox row and an on-screen alert; `incident` and emergency `complaint_high_priority` push even when a mute was stored before the lock existed. (S3 QA, S6 prefs route test.)
5. **The audit trail is incomplete or editable.** A manager write path added in phases 3–7 that bypasses its RPC, an audited action with no `_ops_log` call, or an update/delete on `ops_audit_log` → S7 fails naming the path/action; `before`/`after` never carries a phone, address or bank detail. (S7 structural + PGlite, S8 redaction test.)

---

## Task P0: Merge siblings, reconcile, record what landed (main worktree)

**Files:** Modify: this plan (append `## P0 result`), whatever the merges touch.

- [ ] **Step 1:** In `F:\hub26\deligro-manager`: `git merge feat/vendor-app`, `git merge feat/rider-app`. Resolve conflicts keeping both sides' behaviour.
- [ ] **Step 2:** Record under `## P0 result`: whether `0087` (`support_tickets`, `support_messages`, `user_notifications`, `announcements`, `support-attachments`) is on the branch; whether `src/lib/notifications/notify-user.ts` (`notifyUser`) exists; whether Rider phase 7's `sweep.ts` changes (high demand, pickup reminders, delay alerts) landed.
- [ ] **Step 3:** Diff every function re-declared across ≥ 2 migrations (at least `guard_order_update`, `ops_set_ticket_status`, `ops_add_ticket_message`, `log_delivery_event`, ticket RLS policies) and make the latest definition on the branch carry every behaviour; run every `scripts/qa/sql/migration-*.mjs` and all `scripts/qa/manager-*.ts` that run offline — all pass.
- [ ] **Step 4:** Commit the merges, then `fix(db): reconcile re-declared functions after merging sibling work` (if any), then `docs(manager-app): phase 8 P0 result`. Create both worktrees from that commit.

---

# Part S — server (worktree `deligro-manager-p8s`)

### Task S1: Migration 0165 — ticket operations

**Files:** Create `supabase/migrations/0165_support_ops.sql`, `scripts/qa/sql/migration-0165.mjs`; Modify `docs/DATABASE.md`.

**Interfaces — Consumes:** `support_tickets`/`support_messages` (0087 or 0143), `support_tickets.restaurant_id` (0145), `ops_require_staff`, `_ops_set_actor`, `_ops_log`, `manager_can_see_zone`, `ops_add_ticket_message`, `ops_set_ticket_status` (0145).
**Produces (database):**
- `support_tickets` gains `assigned_to uuid → profiles on delete set null`, `assigned_at timestamptz`, `reopened_count smallint not null default 0`; index `(zone_id, status, created_at desc)`, `(assigned_to, status)`.
- `support_ticket_events (id bigint identity pk, ticket_id uuid not null → support_tickets on delete cascade, kind text not null check in ('created','status','assigned','team','priority','escalated','reopened','first_response','attachment'), from_value text, to_value text, actor_id uuid, reason text, internal boolean not null default false, created_at timestamptz not null default now())`, index `(ticket_id, created_at)`; written only by triggers `log_ticket_event` (after insert/update on `support_tickets`) and `log_ticket_message_event` (after insert on `support_messages`: `first_response` and `attachment` kinds; `internal` copied from the message); actor `coalesce(auth.uid(), deligro.actor_id)`. RLS: select for admins, `manager_can_see_zone(ticket zone)`, and the requester for `internal = false` rows; writes revoked.
- Trigger `reopen_on_requester_reply` (after insert on `support_messages`): author = requester and ticket `resolved` → `in_progress`, `reopened_count + 1`.
- Re-declare `ops_set_ticket_status(p_actor, p_ticket, p_status, p_resolution, p_reason text, p_client_action_id)` from its latest definition, enforcing the transition table in *Claude's calls* (`invalid_transition`, detail = allowed list), reopen reason required, `resolution` rules; old signature kept as a wrapper passing `p_reason => null` so Phase 4 callers keep working.
- `ops_assign_ticket(p_actor, p_ticket, p_assignee uuid, p_team text, p_client_action_id)` — eligibility per *Claude's calls* (`assignee_ineligible`); `assigned_at = now()`; action `ticket.assign`.
- `ops_set_ticket_priority(p_actor, p_ticket, p_priority text, p_reason text, p_client_action_id)` — reason required; action `ticket.priority`.
- `ops_escalate_ticket(p_actor, p_ticket, p_reason, p_client_action_id) returns int` (new level) — `max_level` at 3; status `escalated`; action `ticket.escalate`.
- `ops_ticket_metrics(p_zone_ids uuid[], p_all boolean, p_from date, p_to date) returns jsonb` (service role only) — the metrics shape above minus names (route joins names), IST dates.
- Rollback block.

- [ ] **Step 1: Write `migration-0165.mjs`** (apply chain as 0145's proof does). Assertions (`ok`/`FAIL`, exit 1): every legal transition succeeds and each illegal one raises `invalid_transition`; `resolved` without resolution → `reason_required`; reopen without reason → `reason_required`; requester reply on resolved → `in_progress`, `reopened_count = 1`, a `reopened` event; assign to a zone-B manager → `assignee_ineligible`, to a zone-A manager with support permission (flag row present/default) → ok, `assigned` event, audit row `ticket.assign`; escalate 3× → level 3, 4th → `max_level`; priority change without reason → `reason_required`; internal message creates an `internal = true` event invisible to the requester (authenticated role select returns 0) and visible to a zone-A manager; zone-B manager sees no events; replayed `client_action_id` changes nothing; `ops_ticket_metrics` on fixtures (3 tickets: responded after 10/20/30 min, resolved after 60/120 min, one open) → avg first response 20, median 20, avg resolution 90, `openOverSla` per 30 min rule, recurring vendors sorted by count; nobody can update/delete `support_ticket_events` as authenticated.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration. Step 4: Run every SQL proof — PASS.**
- [ ] **Step 5: Commit** `feat(db): 0165 support operations — assignment, priority, events, transitions, metrics`.

### Task S2: Migration 0166 — alerts

**Files:** Create `supabase/migrations/0166_ops_alerts.sql`, `scripts/qa/sql/migration-0166.mjs`; Modify `docs/DATABASE.md`.

**Produces (database):**
- `ops_alert_rules (id bigint identity pk, kind text not null, zone_id uuid null → delivery_zones on delete cascade, enabled boolean not null default true, threshold numeric, window_minutes int, updated_by uuid, updated_at timestamptz default now(), unique nulls not distinct (kind, zone_id))`; seeded with one `zone_id null` row per kind with the defaults in the table above (`fraud_suspected`, `sla_breach` disabled).
- `ops_alerts (id uuid pk default gen_random_uuid(), kind text not null, severity text not null check in ('info','warning','critical'), status text not null default 'open' check in ('open','acknowledged','resolved'), title text not null, body text not null, zone_id uuid null, entity_type text not null, entity_id text not null, dedupe_key text not null unique, opened_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), reopen_count int not null default 0, last_pushed_at timestamptz, acknowledged_by uuid, acknowledged_at timestamptz, resolved_by uuid, resolved_at timestamptz, resolution text)`; indexes `(zone_id, status, severity, last_seen_at desc)`, `(kind, status)`.
- `ops_alert_events (id bigint identity pk, alert_id uuid → ops_alerts cascade, event text check in ('opened','escalated_severity','acknowledged','resolved','cleared','reopened'), actor_id uuid, note text, created_at)` — written by the RPCs below.
- `ops_alert_runs (name text pk, leased_until timestamptz)` + `ops_claim_alert_run(p_name text, p_seconds int) returns boolean` (atomic lease).
- `ops_raise_alert(p_kind, p_severity, p_title, p_body, p_zone uuid, p_entity_type, p_entity_id, p_dedupe_key) returns jsonb` `{ id, push: boolean }` — upsert by `dedupe_key`; new → `push = true`; open/acknowledged → update `last_seen_at`, raise severity (event `escalated_severity`, `push = true` only when it becomes `critical`); resolved → reopen (`reopen_count + 1`, event `reopened`), `push = (last_pushed_at is null or last_pushed_at < now() - interval '15 minutes')`.
- `ops_clear_alerts(p_kind text, p_keep_keys text[]) returns int` — resolves (`resolution = 'cleared'`) every open/acknowledged alert of the kind whose key is not in the list; events `cleared`.
- `ops_mark_alert_pushed(p_id uuid)`.
- `ops_ack_alert(p_actor, p_alert, p_client_action_id)`, `ops_resolve_alert(p_actor, p_alert, p_note, p_client_action_id)` (note required), `ops_raise_incident(p_actor, p_zone, p_title, p_body, p_severity, p_client_action_id) returns uuid`, `ops_set_alert_rule(p_actor, p_kind, p_zone, p_enabled, p_threshold, p_window, p_client_action_id)`, `ops_reset_alert_rule(p_actor, p_kind, p_zone, p_client_action_id)` — all audited (`alert.acknowledge`, `alert.resolve`, `alert.incident`, `alert_rule.set`, `alert_rule.reset`; rule actions carry before/after); platform-default rules (`p_zone null`) require an admin actor (`forbidden`).
- RLS: `ops_alerts`, `ops_alert_events` select for admins; managers where `zone_id` in their zones, or `zone_id is null and kind = 'incident'`; `ops_alert_rules` select for managers (all rows; thresholds are not sensitive), writes revoked. The finance/marketing/support audience filters are applied in the route (permissions live in the flag catalog, not SQL).
- Re-assert in the proof that `ops_audit_log` refuses update/delete for every role.

- [ ] **Step 1: Write `migration-0166.mjs`:** raise twice with one key → one row, second call `push = false`; severity warning → critical → `push = true` once; clear with keep list → resolved `cleared`; raise again within 15 min → reopened, `push = false`; after `last_pushed_at` 16 min ago → `push = true`; ack/resolve audited, resolve without note → `reason_required`; zone-A manager sees zone-A alerts and null-zone `incident`, not null-zone `rider_shortage` nor zone-B; manager setting a zone-A rule ok and audited, null-zone rule → `forbidden`, admin null-zone ok; two concurrent `ops_claim_alert_run('evaluate', 60)` → exactly one true; audit log immutability re-asserted.
- [ ] **Step 2: Run — FAIL. Step 3: Write. Step 4: All SQL proofs PASS.**
- [ ] **Step 5: Commit** `feat(db): 0166 ops alerts — rules, dedupe, lifecycle, audited actions`.

### Task S3: Migration 0167 and the staff notifier — inbox, prefs, zone-scoped pushes

**Files:** Create `supabase/migrations/0167_ops_inbox.sql`, `scripts/qa/sql/migration-0167.mjs`, `src/lib/notifications/ops-notify.ts`, `scripts/qa/manager-ops-notify.ts` (add `"test:manager-ops-notify"`); if P0 found it absent, create `src/lib/notifications/notify-user.ts` with the Rider plan's exact exports; Modify `src/lib/notifications/order-events.ts` (`notifyOps` → delegates to `notifyStaff`), `src/lib/features/catalog.ts` or wherever `OPS_ALERT_KINDS` lives (add `ticket_activity`, `locked` set).

**Produces:**
- 0167: if `user_notifications` is absent, create it with **Rider 0087's exact columns, index, RLS and column grant** (`create table if not exists`; header note as 0143's). Add index `(user_id, read_at) where read_at is null`. Nothing else.
- `notifyUser(userId, role, category, text, opts?)` — the Rider plan's signature; if it already exists, reuse unchanged.
- ```ts
  export type StaffAudience = { zoneId: string | null; kind: OpsAlertKind | "ticket_activity"; permission?: FeatureKey; adminsOnly?: boolean; userIds?: string[] };
  export async function staffRecipients(a: StaffAudience): Promise<{ id: string; onesignalId: string | null; muted: boolean }[]>;
  export async function notifyStaff(a: StaffAudience, text: { title: string; body: string }, data: { url: string; alertId?: string; ticketId?: string }): Promise<{ inbox: number; pushed: number }>;
  export const LOCKED_KINDS: readonly string[]; // ["incident", "complaint_high_priority"] — locked only when severity is critical
  ```
  Recipients = admins ∪ managers whose `staff_zones` contain `zoneId` (all managers when `zoneId` null **only** for `incident`), filtered by `permission` through the flag resolver (default-off honoured), minus `muted` for push (inbox row always written, category = kind). Push text English only. `notifyOps(...)` keeps its signature but resolves the order's zone and calls `notifyStaff`.

- [ ] **Step 1: Write the QA script** (pure resolver over in-memory fixtures + structural): zone-A alert → admins + zone-A managers only; null-zone `rider_shortage` → admins only; null-zone `incident` → admins + every manager; finance kind → only managers with `finance.view` (default off → excluded unless a per-person flag row enables it); muted manager gets an inbox row and no push; muted + critical `complaint_high_priority` still pushed; text has no Devanagari (`/[\u0900-\u097F]/` absent) and `title_hi`/`body_hi` null in inbox inserts; structural: `order-events.ts` contains no `.in("role", ["admin", "manager"])` any more.
- [ ] **Step 2: Run — FAIL. Step 3: Implement (migration + proof first). Step 4: SQL proofs, QA, `npx tsc --noEmit`, eslint — PASS.**
- [ ] **Step 5: Commit** `feat(notifications): zone- and permission-scoped staff notifications with inbox`.

### Task S4: Alert catalog, evaluator, engine, hooks

**Files:** Create `src/lib/ops/alerts/catalog.ts`, `src/lib/ops/alerts/evaluate.ts`, `src/lib/ops/alerts/facts.ts`, `src/lib/ops/alerts/engine.ts`, `scripts/qa/manager-alerts.ts` (add `"test:manager-alerts"`); Modify `src/lib/dispatch/sweep.ts`, the delivery-failure path (Rider `advanceDelivery` / exception approval), marketing request insert path (Phase 7 data layer), ticket create/priority/escalate paths, cash dispute path (Phase 5), `src/app/api/cron/dispatch-sweep/route.ts` (result includes alert counts).

**Produces:**
```ts
export type OpsAlertKind = "order_needs_intervention" | "order_unassigned" | "delivery_delayed" | "high_cancellation_rate" | "vendor_downtime"
  | "rider_shortage" | "delivery_failed" | "settlement_delayed" | "rider_payout_issue" | "marketing_request_new" | "complaint_high_priority"
  | "cash_discrepancy" | "incident" | "rider_inactive" | "fraud_suspected" | "sla_breach";
export interface AlertKindDef { kind: OpsAlertKind; label: string; description: string; unit: "minutes" | "percent" | "ratio" | "rupees" | "none";
  defaultThreshold: number | null; defaultWindowMinutes: number | null; audiencePermission?: FeatureKey; mutable: boolean; evaluated: "sweep" | "event" | "both" | "phase9"; }
export const ALERT_KINDS: readonly AlertKindDef[];               // the table in Claude's calls, in that order
export interface ResolvedRule { kind: OpsAlertKind; zoneId: string | null; enabled: boolean; threshold: number | null; windowMinutes: number | null; }
export function effectiveRule(rules: ResolvedRule[], kind: OpsAlertKind, zoneId: string): ResolvedRule;   // zone row else default
export interface AlertFacts { now: Date; zones: { id: string; name: string }[]; orders: …; riders: …; vendors: …; tickets: …; financeIssues: FinanceIssue[];
  cashDays: …; marketingPending: …; incidents: …; exceptionsPending: …; }        // shapes reuse Phase 3/5/6 types
export interface DesiredAlert { kind: OpsAlertKind; severity: "info" | "warning" | "critical"; title: string; body: string; zoneId: string | null;
  entity: { type: string; id: string }; dedupeKey: string; }
export function evaluate(facts: AlertFacts, rules: ResolvedRule[]): Map<OpsAlertKind, DesiredAlert[]>;  // pure; only enabled kinds with evaluated ∈ sweep|both
export async function loadAlertFacts(now: Date): Promise<AlertFacts>;                                  // service role, bounded queries (active orders, last 2 h events, open tickets, current finance issues)
export async function evaluateAlerts(now?: Date): Promise<{ raised: number; cleared: number; pushed: number } | { skipped: "lease" }>;
export async function raiseEventAlert(a: DesiredAlert): Promise<void>;                                  // event hooks; raise + notify, never throws (logs to obs)
```
`evaluateAlerts` = claim lease (60 s) → load facts → `evaluate` → for each kind: `ops_raise_alert` per desired alert, `notifyStaff` when `push`, `ops_mark_alert_pushed`; then `ops_clear_alerts(kind, keys)`. Titles/bodies are English, specific ("Order AB12CD34 has no rider — ready 9 min at Spice Hub").

- [ ] **Step 1: Write the QA script** with fixture facts (house style): one case per kind proving it fires at the threshold and not one unit below (e.g. unassigned 4 min → none, 5 min → warning, 15 → critical; cancellation 1/4 placed → none (sample < 5), 2/8 = 25 % → warning, 4/8 → critical; downtime inside hours 29 → none, 30 → fire, outside hours → none; shortage 4 unassigned / 2 idle → fire, 3/2 → none at ratio 2, 0 riders with 1 order → critical; cash gap ₹499 → none, ₹500 at 13 h → warning, disputed → critical; rider fix 6 min old on active delivery → `rider_inactive`, idle rider → none); a zone rule overriding the default changes the outcome only in that zone; disabled kind → no alerts; `fraud_suspected`/`sla_breach` never emitted; dedupe keys stable across two evaluations of the same facts; English-only text; structural: `sweep.ts` no longer imports `notifyOpsKitchenSlow`/`notifyOpsNoRider`/`notifyOpsStuck` and calls `evaluateAlerts`; each event path calls `raiseEventAlert`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: QA, `npx tsc --noEmit`, eslint — PASS; live (skip when no server/DB): two concurrent cron calls → one evaluates, the other `{ skipped: "lease" }`.**
- [ ] **Step 5: Commit** `feat(ops): alert engine — thirteen kinds plus rider inactivity, thresholds, dedupe, auto-clear`.

### Task S5: Ticket routes — queue, assign, priority, escalate, attachments, metrics

**Files:** Create `src/lib/ops/support-contract.ts`, `src/app/api/manager/tickets/route.ts`, `…/[id]/assign/route.ts`, `…/[id]/priority/route.ts`, `…/[id]/escalate/route.ts`, `…/assignees/route.ts`, `…/metrics/route.ts`, `scripts/qa/manager-support.ts` (add `"test:manager-support"`); Modify `src/lib/data-access/manager-tickets.ts` (Phase 4), `…/[id]/route.ts`, `…/[id]/messages/route.ts`, `…/[id]/status/route.ts`.

**Produces:**
```ts
export async function listTickets(scope: ManagerScope, viewer: OpsActor, q: TicketQuery): Promise<{ items: TicketListItem[]; nextCursor: string | null; counts: TicketCounts }>;
export function parseTicketQuery(sp: URLSearchParams): TicketQuery | { error: "bad_request"; field: string };
export async function opsAssignTicket(actor: OpsActor, id: string, assigneeId: string | null, team: string | null, cid: string): Promise<OpsResult>;
export async function opsTicketPriority(actor: OpsActor, id: string, priority: string, reason: string, cid: string): Promise<OpsResult>;
export async function opsEscalateTicket(actor: OpsActor, id: string, reason: string, cid: string): Promise<OpsResult<{ level: number }>>;
export async function ticketMetrics(scope: ManagerScope, range: { from: string; to: string }, zone?: string): Promise<TicketMetrics>;
export async function listAssignees(scope: ManagerScope, zone?: string): Promise<Assignee[]>;
```
After each RPC: requester notified via `notifyUser` on status change and non-internal reply (their category `support`), assignee via `notifyStaff({ userIds: [assignee], kind: "ticket_activity" })`, escalation via `notifyStaff` (level ≥ 2 `adminsOnly` + zone managers), priority → `emergency` → `raiseEventAlert(complaint_high_priority)`. Uploads go to `support-attachments/<ticket>/<uuid>.<ext>`, recorded on the message.

- [ ] **Step 1: Write the QA script:** `parseTicketQuery` rejects bad status/priority/role/uuid/cursor/`limit 101`; `active` alias expands; `assignee=me` uses the caller; ordering puts escalated/emergency first; structural: each route opens with `managerApiContext("manager.support.manage")` and each write calls its `ops_*` RPC (no `.from("support_tickets").update`); multipart rejects `text/html`, 6 MB, 5 files; requester-facing notifier never receives an internal body (spy); live (skip as before): unauthenticated → 401 on every route.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: QA, tsc, eslint — PASS.**
- [ ] **Step 5: Commit** `feat(api): manager support queue — filters, assignment, priority, escalation, attachments, metrics`.

### Task S6: Alerts, thresholds, inbox and audit routes; admin console pages

**Files:** Create `src/lib/ops/alerts-contract.ts`, `src/lib/data-access/manager-alerts.ts`, `src/lib/data-access/manager-inbox.ts`, `src/lib/data-access/manager-audit.ts`, routes `src/app/api/manager/alerts/route.ts`, `…/alerts/[id]/route.ts`, `…/alerts/[id]/actions/route.ts`, `…/alerts/incident/route.ts`, `…/alert-rules/route.ts`, `…/notifications/route.ts`, `…/notifications/unread-count/route.ts`, `…/notifications/read/route.ts`, `…/audit/route.ts`, `…/audit/[id]/route.ts`, `…/audit/actions/route.ts`, admin pages `src/app/admin/alerts/page.tsx` (+ row actions), `src/app/admin/settings/alerts/page.tsx` (thresholds per zone), `src/app/admin/audit/page.tsx`; nav entries in `src/components/admin/admin-nav.ts`; `scripts/qa/manager-alerts-routes.ts` (add `"test:manager-alerts-routes"`); Modify `src/app/api/manager/notification-prefs/route.ts` (`locked`, `not_mutable`).

- Admin pages follow AGENTS.md console rules (two shells, `PageHeader`/`Toolbar`/`DataTable`/`StatusText`, tokens only, `@container` sizes, `Empty` for filtered-empty). Admin actions call the same `ops_*` RPCs with the admin as actor.
- Audit route: `before`/`after` passed through `redactAuditPayload()` (keys matching `/phone|mobile|email|address|account|ifsc|aadhaar|pan|upi/i` → `"[redacted]"`); `diff` computed server-side (flat dotted paths).

- [ ] **Step 1: Write the QA script:** alert list applies the audience filter (fixture manager without `finance.view` gets no finance kinds; with it, gets them); null-zone non-incident hidden from managers; resolve without note → 400 `reason_required`; rule PUT bounds per unit → `bad_threshold`; null-zone PUT by manager → 403; prefs PUT locked kind `push:false` → `not_mutable`; inbox `read {all:true}` → unread 0 (fake repo); audit route without `audit.view_zone` → 403; `redactAuditPayload` redacts nested keys; `diff` of `{status:"ready",x:{y:1}}` → `{status:"kitchen",x:{y:2}}` gives two paths; structural: every write route opens with `managerApiContext` and rate-limits; admin pages contain no `.device`/`StatusBar`/`md:`/`dark:` (run `npm run test:platform`).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: QA, `npm run test:platform`, tsc, eslint, `next build` — PASS.**
- [ ] **Step 5: Commit** `feat(api): manager alerts, thresholds, inbox and audit log; admin alerts, thresholds and audit pages`.

### Task S7: Audit coverage — every sensitive action provably logged

**Files:** Create `src/lib/ops/audit-catalog.ts`, `scripts/qa/manager-audit-coverage.ts` (add `"test:manager-audit-coverage"`); Create if gaps are found `supabase/migrations/0168_audit_coverage.sql` + `scripts/qa/sql/migration-0168.mjs` (always: indexes `ops_audit_log (zone_id, created_at desc)`, `(actor_id, created_at desc)`, `(action, created_at desc)`, `(entity_type, entity_id)`); Modify any write path found unaudited.

**Produces:**
```ts
export interface AuditActionDef { code: string; label: string; group: "Orders" | "Deliveries" | "Vendors" | "Products" | "Riders" | "Finance" | "Marketing" | "Offers" | "Customers" | "Support" | "Alerts" | "Access"; sensitive: boolean; }
export const AUDIT_ACTIONS: readonly AuditActionDef[];   // every action code any RPC passes to _ops_log
```
- [ ] **Step 1: Write the coverage script**, three checks, each listing offenders and exiting 1:
  1. **Catalog ↔ SQL.** Parse every `supabase/migrations/01[4-6]*.sql` for `_ops_log(` action literals; every literal is in `AUDIT_ACTIONS` and every catalog code appears in some migration. The design's Audit list maps to required codes, at minimum: `order.advance`, `order.cancel`, `order.correct.*`, `order.note`, `order.escalate`, `delivery.assign`, `delivery.reassign`, `vendor.status`, `vendor.document`, `vendor.onboard`, `product.flag`, `product.hide`, `product.approve`, `product.stock`, `rider.status`, `rider.document`, `rider.onboard`, `rider.adjustment`, `payment_request.create`, `payment_request.decide`, `settlement.*`, `refund.decide`, `cash.deposit.decide`, `cash.dispute.resolve`, `exception.decide`, `marketing_request.decide`, `campaign.*`, `offer.*`, `customer.status`, `customer.contact_reveal`, `ticket.*`, `alert.*`, `alert_rule.*`, `zone.*`, `staff_zone.*`, `feature_flag.*`, `session.revoke` (use the exact codes the earlier phases chose; the list is the floor, not the spelling).
  2. **Routes → RPCs.** For every `src/app/api/manager/**/route.ts` exporting `POST|PUT|PATCH|DELETE`, follow its data-access import and require an `.rpc("ops_` (or an allowlisted non-audited write: `notification-prefs`, `notifications/read`, `password` — each named with a reason in the script); fail on any `.from(<table>).insert|update|upsert|delete` on a business table inside manager data-access. Same for `src/app/manager/**/actions.ts` (web portal) and admin actions that Phase 1–7 moved onto RPCs.
  3. **Routes → permissions.** Each manager write route's `managerApiContext(key)` key equals the Phase-plan permission for it (table in the script, copied from phases 3–7 Global Constraints); keys that are `defaultOn: false` in the catalog are exactly the design's ten sensitive ones.
  Plus PGlite spot checks in `migration-0168.mjs` (always written): for five representative RPCs (reassign, vendor status, payment decision, offer change, customer suspension), one call → exactly one audit row with `actor_id`, `zone_id`, `created_at`, reason; a raised exception inside the RPC → zero audit rows (same transaction).
- [ ] **Step 2: Run — expect FAIL on whatever is missing (at least the catalog file). Step 3: Write the catalog; fix every gap the script names (new RPC or `_ops_log` call in 0168, or route rewiring). Step 4: Run — PASS; all SQL proofs PASS.**
- [ ] **Step 5: Commit** `test(audit): every sensitive manager action is logged, atomically, behind its permission` (+ `feat(db): 0168 …` if a migration was needed).

### Task S8: Personal data review of every manager payload (§16.10)

**Files:** Create `scripts/qa/manager-pii.ts` (add `"test:manager-pii"`); Modify serialisers it flags.

- [ ] **Step 1: Write the scan:** import every manager contract serialiser (`orders`, `live`, `vendors`, `products`, `riders`, `finance`, `reports`, `marketing`, `offers`, `customers`, `support`, `alerts`, `audit`, `inbox`) and run each over the Phase 3 contract-emitter fixtures under three permission sets — *minimal* (all default-off keys off, `call_customer` off), *default*, *full*. Walk each payload; any key matching `/phone|mobile|email|address|landmark|lat|lng|account|ifsc|aadhaar|pan|upi|dob/i` must be on that endpoint's allowlist **for that permission set** (e.g. `orders/[id].customer.phone` only with `call_customer`; `customers/[id].phone` only masked unless `customers.contact` and a reveal; rider `lat/lng` only for online/active riders; `drop.address` allowed on order detail; never in list items except vendor pickup addresses). Also: no requester-facing support payload contains an `internal: true` message; no inbox/push text contains a phone number (`/\+?\d{10,}/`).
- [ ] **Step 2: Run — FAIL on anything over-shared. Step 3: Fix the serialisers (omit keys, never null them). Step 4: Run — PASS; tsc; eslint.**
- [ ] **Step 5: Commit** `test(privacy): manager payloads carry personal data only where a permission and a live need allow`.

---

# Part A — app (worktree `deligro-manager-p8a`, `apps/manager/` only)

Part A never calls a real server in tests; every screen reads through `SupportRepository`, `AlertsRepository`, `InboxRepository`, `AuditRepository` with fakes in tests. **English only:** no `tr(...)` in new code; plain English strings. Routes: `/more/support` (queue), `/more/support/metrics`, `/more/tickets/:id` (Phase 4 screen, extended), `/alerts`, `/alerts/:id`, `/inbox`, `/more/settings/alerts` (thresholds), `/more/audit`, `/more/audit/:id`. Replace the Phase 1 placeholders for Support, Alerts and Audit log.

### Task A1: Models, repositories, fixtures

**Files:** Create `apps/manager/lib/models/{support_ops,alerts,inbox,audit}.dart`, `apps/manager/lib/data/{support_repository,alerts_repository,inbox_repository,audit_repository}.dart`, `apps/manager/test/fixtures/api/{tickets_list,ticket_thread_v2,ticket_metrics,alerts_list,alert_detail,alert_rules,inbox,audit_list,audit_entry,unread_count}.json`, `apps/manager/test/fakes/fake_ops_repositories.dart`, `apps/manager/test/ops_models_test.dart`.

**Produces:** models `TicketListItem`, `TicketEvent`, `TicketMetrics` (+ `RecurringRow`), `Assignee`, `Alert`, `AlertHistoryEntry`, `AlertRule`, `InboxItem`, `UnreadCount`, `AuditEntry`, `AuditDiffRow`, `AuditActionDef` — lenient `fromJson`, unknown enums → `.unknown`; `TicketStatusX.displayLabel` maps `waiting_on_requester` → "In Progress · waiting on requester", others to the five client labels. `abstract interface class SupportRepository { Future<TicketPage> list(TicketFilters f, {String? cursor}); Future<TicketThread> thread(String id); Future<void> reply(String id, String body, bool internal, String cid, {List<XFile> files}); Future<void> setStatus(String id, String status, {String? resolution, String? reason, required String cid}); Future<void> assign(String id, String? assigneeId, String? team, String cid); Future<void> priority(String id, String p, String reason, String cid); Future<int> escalate(String id, String reason, String cid); Future<AssigneeList> assignees({String? zone}); Future<TicketMetrics> metrics(DateRange r, {String? zone}); }` (extends Phase 4 `TicketsRepository` or replaces it — one interface, delete the other); `AlertsRepository { list; detail; act; raiseIncident; rules; setRule; resetRule }`; `InboxRepository { list; unreadCount; markRead({List<String>? ids, bool all}) }`; `AuditRepository { list; entry; actions }`; `Api*` implementations.

- [ ] **Step 1: Write `ops_models_test.dart`:** each fixture parses; unknown alert kind → `.unknown` without throwing; display labels for all six db statuses; `AlertRule.inherited` parsed; money/threshold units parsed as `num`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: `flutter analyze`, `flutter test` — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): support, alerts, inbox and audit models and repositories`.

### Task A2: Support — queue, ticket operations, metrics

**Files:** Create `apps/manager/lib/features/support/{support_queue_screen,ticket_filters_sheet,assign_sheet,support_metrics_screen}.dart`, `apps/manager/lib/state/support.dart`, `apps/manager/test/support_test.dart`; Modify `apps/manager/lib/features/support/ticket_thread_screen.dart` (Phase 4), `apps/manager/lib/router.dart`, More menu entry "Support" (gated by `manager.support.manage`).

- Queue: status chips with counts (Active default, Escalated, Unassigned, Mine, Resolved, Closed), filters sheet (category, priority, requester role, date range, zone, team, vendor, rider), search by number/subject, infinite scroll, each row: number, subject, requester role icon, priority mark (emergency red, high amber), status as dot + word, age, assignee or "Unassigned", escalation level badge; tablet ≥ 840 dp → queue + thread side by side.
- Thread (extended): header with status (display label), priority, team, assignee, level; actions menu limited to `allowedTransitions` and permissions — Assign (sheet: staff list with open counts, team picker), Change priority (reason), Escalate (reason; disabled at level 3), Resolve (resolution required), Close, Reopen (reason); composer with **Internal note** toggle (internal messages shown on a tinted background labelled "Internal — not visible to requester"), attach up to 4 images/PDFs; a History tab rendering `events` chronologically.
- Metrics: range chips (7 / 30 / 90 days, custom) + zone; figures in JetBrains Mono — average and median first response, average and median resolution, created, resolved, reopened, open over 30 min; daily created vs resolved line chart; recurring problems as five ranked lists (category, vendor, rider, zone, repeated orders) with share bars; each row taps through (vendor → vendor detail, rider → rider detail, order → order detail, category → queue filtered).

- [ ] **Step 1: Write `support_test.dart`:** chip counts render from the fixture; filters sheet produces the expected `TicketFilters`; Resolve with < 3 chars keeps the button disabled; Escalate hidden at level 3; internal toggle → `reply(internal: true)` and the bubble shows the internal label; attaching 5 files shows "Up to 4 attachments"; History tab lists events; metrics screen shows "22 min" average first response from fixture; retry after a network error reuses the same `clientActionId`; `waiting_on_requester` shows "In Progress · waiting on requester".
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: analyze, test — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): support queue, ticket assignment, escalation, attachments, history and metrics`.

### Task A3: Alerts, incidents, inbox, badge, push routing

**Files:** Create `apps/manager/lib/features/alerts/{alerts_screen,alert_detail_screen,raise_incident_sheet}.dart`, `apps/manager/lib/features/inbox/inbox_screen.dart`, `apps/manager/lib/state/{alerts,inbox}.dart`, `apps/manager/lib/widgets/alert_bell.dart`, `apps/manager/lib/core/entity_routes.dart`, `apps/manager/test/alerts_inbox_test.dart`; Modify `apps/manager/lib/router.dart`, `apps/manager/lib/core/push.dart`, Home app bar (Phase 2) and Live tab app bar (Phase 3) to show `AlertBell`.

**Produces:** `String routeForEntity(String type, String id, {Map<String, dynamic>? data})` — `order|delivery` → `/orders/<orderId>`, `restaurant` → `/more/vendors/<id>`, `rider` → `/more/riders/<id>`, `ticket` → `/more/tickets/<id>`, `marketing_request` → the Phase 7 request route, `settlement` → the Phase 6 settlement route, `payment_request` → the Phase 5 approvals route, `cash_day` → the Phase 5 cash route filtered to the rider, `zone`/`incident`/unknown → `/alerts/<alertId>`. Part A reads `router.dart` for the exact Phase 5–7 paths and pins them in the test.

- Alerts screen: segmented Open / Acknowledged / Resolved with counts; severity shown by the mark colour (critical red, warning amber, info blue), title, body, zone name, "seen N min ago", reopen count; swipe or buttons **Acknowledge**, **Resolve** (note required), **Open** (entity route); kind and zone filters; "Raise incident" FAB (title, details, severity, zone from the manager's zones). Detail: history list.
- `AlertBell`: badge = unread inbox count, dot red when `criticalAlerts > 0`; tap → `/inbox` (with an "Alerts" shortcut row at the top showing open counts). Inbox: paged, unread bold, tap marks read and opens `data.url`, "Mark all read".
- Push: alert pushes → `/alerts/<alertId>`; ticket pushes → `/more/tickets/<id>`; inbox pushes → their `url`; unknown → `/inbox`.
- Polling: alerts 15 s while visible; unread count 30 s while foregrounded.
- Notification settings (Phase 1 screen): locked kinds show the switch on and disabled with "Always delivered".

- [ ] **Step 1: Write `alerts_inbox_test.dart`:** list sorted critical first from the fixture; Resolve with empty note disabled; Acknowledge moves the item to Acknowledged (fake repo); `routeForEntity` table test for every entity type; bell badge shows 7 and a red dot when `criticalAlerts: 1`; tapping an inbox item marks it read and navigates; locked kinds' switches disabled; polling pauses when the screen is not visible (fake clock + visibility); an alert push payload routes to `/alerts/<id>`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: analyze, test — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): alerts, incidents, inbox and alert routing`.

### Task A4: Alert thresholds and the audit log

**Files:** Create `apps/manager/lib/features/alerts/alert_thresholds_screen.dart`, `apps/manager/lib/features/audit/{audit_log_screen,audit_entry_screen,audit_filters_sheet}.dart`, `apps/manager/lib/state/audit.dart`, `apps/manager/test/thresholds_audit_test.dart`; Modify More menu ("Alert thresholds" under Settings — visible to all managers read-only, editable with `manager.alerts.configure`; "Audit log" gated by `manager.audit.view_zone`), `router.dart`.

- Thresholds: zone picker (manager's zones; "All zones (default)" read-only for managers, editable for admins); one row per kind in catalog order: label, description, enabled switch, threshold field with unit suffix (min, %, ×, ₹) and bounds validation, window field where the kind has one, "Inherited from default" note with a "Reset to default" action when overridden; saving sends one `setRule` per changed row with its own `clientActionId`; read-only state explains "Ask an admin to give you Configure alerts".
- Audit log: filters sheet (actor picker from the manager's zone staff, action group/code from `actions`, entity type, entity id, zone, date range), infinite list (time, actor name + role, action label, entity, reason excerpt); entry screen: all fields, before/after as a two-column diff table (path, before, after), "Open entity" via `routeForEntity`.

- [ ] **Step 1: Write `thresholds_audit_test.dart`:** threshold 0 minutes → field error "1–1440"; inherited row shows the note and Reset is hidden; overridden row shows Reset; without `alerts.configure` every field is disabled and the explanation shows; audit list renders from fixture; filters sheet builds `action=order.*` for the Orders group; entry diff shows two rows for the fixture; Audit log menu item hidden without `audit.view_zone`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: analyze, test — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): alert thresholds and audit log`.

### Task A5: Release check (app half)

- [ ] **Step 1:** `flutter analyze` clean; `flutter test` all pass; `grep -rn "tr(" apps/manager/lib/features/{support,alerts,inbox,audit}` → nothing added by this phase; `flutter build apk --release --dart-define-from-file=env/prod.json` (F:\dev env).
- [ ] **Step 2:** Install on `deligro_test`; cold start reaches login with no `E/flutter`/FATAL in logcat; golden/screenshot tests from fixtures for Support queue, Ticket thread (with internal note and History), Support metrics, Alerts (open), Alert detail, Inbox, Alert thresholds, Audit log, Audit entry — light and dark, phone and tablet for the queue — saved under the scratchpad and listed in the commit body.
- [ ] **Step 3: Commit** `chore(manager-app): phase 8 release check`.

---

## Task I1: Merge, contract check, phase exit (main worktree)

- [ ] **Step 1:** In `F:\hub26\deligro-manager`: `git merge feat/manager-p8-server`, then `git merge feat/manager-p8-app`; resolve.
- [ ] **Step 2: Contract check.** Extend `scripts/qa/manager-contract-emit.ts` to run the S5/S6 serialisers on in-file fixture rows (ticket in each status with an internal note and attachments, metrics with each recurring list non-empty, alerts of every kind and status, inherited and overridden rules, inbox read/unread, audit entries with nested before/after) writing `apps/manager/test/fixtures/api/generated/{tickets_list,ticket_thread_v2,ticket_metrics,alerts_list,alert_detail,alert_rules,inbox,unread_count,audit_list,audit_entry}.json`; extend `contract_test.dart` to parse each with the A1 models and assert every non-nullable field is present and typed. Run `npx tsx scripts/qa/manager-contract-emit.ts && cd apps/manager && flutter test test/contract_test.dart` — PASS. Commit the generated fixtures.
- [ ] **Step 3: Phase exit.** Every `scripts/qa/sql/migration-*.mjs`; `npm run test:manager-ops-notify`, `test:manager-alerts`, `test:manager-support`, `test:manager-alerts-routes`, `test:manager-audit-coverage`, `test:manager-pii`, `test:platform` and every earlier `test:manager-*`; `npx tsc --noEmit`; eslint on touched paths; `next build`; `flutter analyze`; `flutter test`; release APK cold start on the emulator. Walk `docs/SECURITY_AUDIT.md` (new tables readable by authenticated: `support_ticket_events`, `ops_alerts`, `ops_alert_events`, `ops_alert_rules`, `user_notifications` if created here; new storage paths; new RPCs) and log it.
- [ ] **Step 4:** Remove both worktrees and branches. Commit `docs(manager-app): phase 8 exit — verification log`.

## Notes for other branches

- **Rider / Partner:** if this phase created `user_notifications` (0167) or `notifyUser`, it used Rider 0087's exact shape; Rider phase 7 should merge `feat/manager-app` (or skip its own create via `if not exists`) rather than add a second copy. `support_ticket_events` and the transition rules in `ops_set_ticket_status` apply to tickets from every app — vendor and rider requester views should read events with `internal = false` only.
- **Rider phase 7 sweep changes** (high demand, pickup reminders, delay alerts to riders) stay rider-facing; the ops side of "delay" is `delivery_delayed` here. Whoever merges second keeps both call sites in `sweepDispatch`.
