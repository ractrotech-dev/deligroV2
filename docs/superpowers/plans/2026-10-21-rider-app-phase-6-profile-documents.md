# Rider App — Phase 6: Profile and Documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every §12 item: profile with rider ID, address, vehicle, licence, emergency contact, payout account (stored with credential-grade containment), identity and onboarding documents with verification and expiry reminders, change requests for verified details — and the admin screens that verify and approve them.

**Architecture:** Migration `0086` extends `rider_profiles`, adds `rider_documents`, `rider_payout_accounts` (no client access at all), `rider_profile_change_requests`, and the private `rider-documents` bucket. Server modules behind `/api/rider/profile/*`; a `server-only` payout-account module behind admin checks; the admin rider detail gains Profile and Documents tabs; a daily cron sends expiry reminders. App: Profile & documents under More.

**Spec:** `docs/superpowers/specs/2026-10-21-rider-app-design.md` (*Profile and documents (§12)*)

## Global Constraints

- **Owner override (2026-10-21): the Rider app is ENGLISH ONLY — no Hindi anywhere on the rider side.** Ignore every mention below of Hindi, `tr(en, hi)`, `langProvider`, bilingual copy, `name_hi`/`nameHi`/`title_hi`, Devanagari or a language setting; write plain English strings and English-only tests. (The customer app and website keep their own language support untouched.)
- Earlier phases' Global Constraints and rulings apply. `docs/SECURITY_AUDIT.md` is walked for this phase's tables, bucket and routes and logged (sensitive personal data).
- Document types: `aadhaar`, `pan`, `driving_licence`, `vehicle_rc`, `insurance`, `puc`, `photo`. Required for verification: `aadhaar`, `driving_licence`, `photo` (others optional; Deligro supplies the EV bike, so RC/insurance/PUC apply only when `vehicle_owner = 'rider'`).
- Files: PDF, JPEG or PNG, ≤ 10 MB, magic-byte checked; private bucket `rider-documents`, path `<driverId>/<docType>/<uuid>.<ext>`; read only through 10-minute signed URLs issued to the rider (own) or admins.
- Aadhaar numbers are stored masked (last 4 only) — the full number is never stored; PAN and licence numbers in full.
- Payout account (`rider_payout_accounts`): RLS on, **no policies**, all privileges revoked from `anon` and `authenticated`, service role only, reached only through `src/lib/data-access/rider-payout-accounts.ts` (`server-only`) — the `vendor_login_credentials` containment pattern (AGENTS.md rule 4 explains why it is the exception). The rider sees and submits it masked; admins see it in full only on the rider's Profile tab.
- Verified fields (name, licence number/expiry, vehicle type/registration, payout account) change only through an approved change request; everything else saves directly.
- Expiry reminders at 30, 7 and 1 days before `expires_on`, and on expiry; each sent once (`rider_documents.reminded_*` stamps).

## Review Focus

1. **A rider uploads a 40 MB video renamed .pdf** → `bad_type` (magic bytes) / `too_large`, nothing stored (Task 2 test).
2. **A rider requests another rider's document URL by guessing an id** → 404, no URL (Task 2 contract test; RLS proof).
3. **A rider changes their bank account while a payout is being recorded** → the change is a request; the payout uses the approved account; the admin sees "change pending" next to the account (Task 3 test).
4. **A document expires while the rider is online** → the rider is pushed, the admin rider list flags it; dispatch is not blocked unless the admin setting `block_dispatch_on_expired_docs` is on (default off) (Task 2 test of the eligibility helper).
5. **Names and addresses with non-ASCII characters (accents, Devanagari typed by the rider)** → stored and shown intact, statements and PDFs render them without boxes (Task 4 test) — the app's own copy stays English-only.

---

### Task 1: Migration 0086 — profile fields, documents, payout accounts, change requests

**Files:** `supabase/migrations/0086_rider_profile_documents.sql`, `scripts/qa/sql/migration-0086.mjs`, `docs/DATABASE.md`

- `rider_profiles` columns: `address_line text`, `city text`, `pincode text check ^\d{6}$`, `vehicle_type text check in ('ev_bike','bike','scooter','bicycle','other')`, `vehicle_owner text check in ('deligro','rider') default 'deligro'`, `vehicle_registration text`, `licence_number text`, `licence_expires_on date`, `emergency_name text`, `emergency_phone text check ^\+?\d{10,13}$`, `emergency_relation text`, `verification_status text not null default 'unverified' check in ('unverified','pending','verified','rejected')`, `verified_at`, `verified_by`, `notification_prefs jsonb not null default '{}'`, `nav_app text`, `language text default 'en'`.
- `rider_documents (id uuid pk, driver_id, doc_type, number_masked text, number text, file_path text not null, expires_on date, status text default 'pending' check in ('pending','verified','rejected','expired','replaced'), remarks text, reviewed_by, reviewed_at, reminded_30_at, reminded_7_at, reminded_1_at, reminded_expired_at, created_at)`; partial unique: one non-`replaced` row per `(driver_id, doc_type)`.
- `rider_payout_accounts (driver_id uuid pk, kind text check in ('bank','upi'), holder_name text, account_number text, ifsc text check ^[A-Z]{4}0[A-Z0-9]{6}$, upi_id text, updated_at, updated_by)`; RLS on, no policies, `revoke all … from anon, authenticated`.
- `rider_profile_change_requests (id uuid pk, driver_id, field text check in ('full_name','licence','vehicle','payout_account'), new_value jsonb not null, status text default 'pending' check in ('pending','approved','rejected'), decided_by, decided_at, decision_note, created_at)`; partial unique one pending per `(driver_id, field)`. `new_value` for `payout_account` is stored **only** as a reference to a staged row in `rider_payout_accounts_staged` (same containment as the main table), never in this readable table.
- `platform_settings.block_dispatch_on_expired_docs boolean not null default false`.
- Bucket `rider-documents` private, 10 MB, pdf/jpeg/png; no anon/authenticated policies.
- RLS: rider selects own profile/documents/change requests; admins all; writes service role.
- Proof: `authenticated` (rider and manager) cannot select or insert `rider_payout_accounts` or the staged table; rider sees own documents only; second active document of the same type raises; pincode/IFSC/phone checks.
- Commit `feat(db): 0086 rider profile, documents, payout accounts, change requests`.

### Task 2: Server — profile, documents, change requests, expiry cron

**Files:** Create `src/lib/rider/profile-rules.ts` (pure: validation, masking, which fields need approval, `documentsComplete`, `dispatchBlockedByDocuments`), `src/lib/data-access/rider-profile.ts`, `src/lib/data-access/rider-payout-accounts.ts` (`import "server-only"`), routes `src/app/api/rider/profile/route.ts` (GET, PATCH direct fields), `src/app/api/rider/profile/change-requests/route.ts` (POST, GET), `src/app/api/rider/documents/route.ts` (GET list, POST multipart upload), `src/app/api/rider/documents/[id]/url/route.ts` (GET signed URL), `src/app/api/cron/rider-documents/route.ts` (daily, the existing cron auth pattern), `scripts/qa/rider-profile.ts`; Modify `src/lib/dispatch/eligibility.ts` (respect `block_dispatch_on_expired_docs`), `/api/rider/me` (profile completeness and verification status).

**Interfaces:**
```ts
export interface RiderProfile { riderCode: string | null; name: string | null; phone: string | null; avatarUrl: string | null; address: { line: string | null; city: string | null; pincode: string | null };
  vehicle: { type: string | null; owner: "deligro" | "rider"; registration: string | null }; licence: { number: string | null; expiresOn: string | null };
  emergency: { name: string | null; phone: string | null; relation: string | null }; payoutAccount: { kind: "bank" | "upi"; masked: string } | null;
  verification: "unverified" | "pending" | "verified" | "rejected"; documents: RiderDocument[]; pendingChanges: { field: string; createdAt: string }[] }
export interface RiderDocument { id: string; type: string; numberMasked: string | null; expiresOn: string | null; status: string; remarks: string | null; uploadedAt: string }
export async function getRiderProfile(driverId: string): Promise<RiderProfile>;
export async function updateRiderProfileDirect(driverId: string, patch: Partial<{ address: …; emergency: …; vehicleTypeIfUnverified: string }>): Promise<{ ok: true } | { ok: false; error: string; field?: string }>;
export async function requestProfileChange(driverId: string, field: "full_name" | "licence" | "vehicle" | "payout_account", value: unknown): Promise<{ ok: true; id: string } | { ok: false; error: "duplicate_pending" | "invalid_value"; field?: string }>;
export async function uploadRiderDocument(driverId: string, input: { type: string; number?: string; expiresOn?: string; file: File }): Promise<{ ok: true; id: string } | { ok: false; error: "bad_type" | "too_large" | "invalid_number" | "expiry_required" }>;
export async function riderDocumentUrl(driverId: string, docId: string): Promise<string | null>;
export async function sendDocumentExpiryReminders(now?: Date): Promise<number>;
```
- An upload replaces the previous active document of that type (old → `replaced`), sets profile verification to `pending`. Licence and insurance/PUC require `expiresOn`. Aadhaar input of 12 digits is stored as `XXXX-XXXX-1234` only.
- Routes rate-limited (uploads 10/min, others 30/min); rider id from the session; `driver.profile_edit` off → profile and document writes refused with `featureOffResponse` (reads still work).
- [ ] Steps: tests (Review Focus 1, 2, 4; masking; which fields need approval; documents complete matrix by vehicle owner) → FAIL → implement → script, tsc, lint, idor; SECURITY_AUDIT walk logged → commit `feat(rider): profile, documents, change requests and expiry reminders`.

### Task 3: Admin — Profile and Documents tabs, verification, change approvals

**Files:** Modify `src/app/admin/riders/[id]/page.tsx` (Profile and Documents tabs), `src/app/admin/riders/page.tsx` (verification and expiring-documents columns, filter "Needs review"); Create `src/app/admin/riders/[id]/profile-actions.ts` (`verifyDocumentAction`, `rejectDocumentAction`, `setVerificationAction`, `decideChangeRequestAction`, `editPayoutAccountAction`) and `src/lib/data-access/admin-rider-profile.ts`.
- Documents tab: each document with a signed-URL viewer (PDF inline, images zoomable), number, expiry, Verify / Reject (remarks required); Profile tab: all fields, payout account in full (admin only), pending change requests with old vs new and Approve / Reject; overall verification Verified / Rejected with note. Every decision pushes the rider (`notifyRiderProfileDecision`).
- [ ] Steps: action parser tests and non-admin → forbidden contract → FAIL → implement → tsc, lint, platform; screenshots → commit `feat(admin): rider verification, documents and change approvals`.

### Task 4: App — Profile & documents

**Files:** Create `apps/rider/lib/models/profile.dart`, `apps/rider/lib/data/profile_repository.dart`, `apps/rider/lib/features/profile/{profile_screen,edit_sheets,documents_screen,document_upload_screen,payout_account_sheet}.dart`; Modify More (Profile & documents row with a red dot when something needs attention), Home header (verification badge), `pubspec.yaml` (`file_picker`).
- Profile: photo (existing avatar route), name (change request), phone (existing OTP change flow from the customer app's `updatePhone`), rider ID, address, vehicle, licence, emergency contact (with a Call button), payout account (masked; change request), verification status with reasons; Documents: list by type with status chips, expiry with days left, upload (camera or file), replace, view (signed URL); pending changes listed with "Waiting for Deligro".
- [ ] Steps: widget tests (Review Focus 5; masked account; pending change disables a second request; upload validates type and size before sending; expired document red; Hindi; light/dark/1.3×) → FAIL → implement → analyze, test, release build, emulator screenshots → commit `feat(rider-app): Profile and documents`.

---

## Phase exit

Proofs and QA pass; SECURITY_AUDIT logged; tsc, lint, idor, platform; Flutter analyze/test; release walkthrough; report.
