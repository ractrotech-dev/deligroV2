# Manager menu sheet and photo replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager can bulk-upload a shop's menu from an Excel/CSV sheet and replace a wrong dish photo (phone or Deligro photo library), from the Manager app.

**Architecture:** Two audited RPCs in a new migration do the writes (zone check, restricted-category hold, `menu_item_changes` logged as `ops`, one `ops_audit_log` row). Next.js routes under `/api/manager/*` parse, authorise and call them, reusing the owner sheet parser/planner and the photo library. The Flutter app reuses the stock-sheet screen in a "menu" mode and adds a replace-photo bottom sheet.

**Tech Stack:** Postgres/Supabase (plpgsql), Next.js route handlers (TypeScript), Flutter (Riverpod, go_router, image_picker, file_picker).

**Spec:** `docs/superpowers/specs/2026-10-27-manager-menu-sheet-and-photo-replace-design.md`

## Global Constraints

- Work on `master` in `F:\hub26\deligro`. Never stage `apps/*/ios/Runner.xcodeproj/project.pbxproj`, `apps/vendor/test/bulk_upload_test.dart`, `.lighthouseci/`, `.perf-baseline/` or `apps/customer/third_party/deligro_push_style/pubspec.lock` — they are someone else's uncommitted work. Stage files by name.
- Commit only once the owner has said commits are wanted; otherwise leave changes staged-ready and list them.
- Migration file: `supabase/migrations/0176_manager_menu_sheet_and_photo.sql`.
- New switches, both `defaultOn: false`: `manager.products.bulk_menu` (label "Bulk menu upload", offMeans "Menu sheets stay with the vendor and Admin.") and `manager.products.replace_photo` (label "Replace photos", offMeans "Wrong photos can only be flagged.").
- Dishes from a manager sheet go live at once, except restricted-category rules (new restricted dish → `pending`; price/discount/category change on a restricted dish → held exactly as `guard_menu_item_moderation` holds a vendor's edit).
- A manager may not approve a dish they submitted themselves (`menu_items.submitted_by = p_actor` → refused).
- Sheet limits: the owner's (2 MB, 500 rows; `readSheetUpload`), 10 sheet uploads/minute/manager. Photo: jpeg/png/webp ≤ 5 MB, bytes checked against the claimed type; 30 replaces/minute.
- Stock columns (`stock`, `lowStockAt`) apply only with `manager.products.adjust_stock`, each via `ops_adjust_stock` with the sheet's count as expected value; without it they are left out of the download and listed in `ignoredColumns` on upload.
- Pushes/inbox lines to the shop carry no free text and no manager name: "Deligro updated your menu: N added, M changed" and "Deligro replaced the photo of <dish>".
- Manager side is English only — no Hindi strings anywhere.

## Review Focus

- A sheet whose rows reference a dish id from **another shop** must not touch that dish (the planner matches by the shop's own dishes; the RPC must still check `restaurant_id = p_restaurant` per update) — test in Task 1.
- **Replaying** an apply (same `clientActionId`, e.g. a retried request after a timeout) must not create the new dishes twice — test in Task 1.
- A manager **without** `manager.products.adjust_stock` uploading the shop's full sheet (stock column present) must get no stock changes and see `stock` in `ignoredColumns` — test in Task 3.
- Replacing a photo from a review card **after the vendor changed the photo again** (the card's change is no longer the live photo) must still replace, and must not fail on the stale review id — test in Task 1.
- A photo upload whose bytes are not an image (renamed `.pdf` → `.jpg`) is refused with `bad_file`, not stored — test in Task 4.

---

### Task 1: Migration 0176 — bulk menu and photo replace RPCs, self-approval block

**Files:**
- Create: `supabase/migrations/0176_manager_menu_sheet_and_photo.sql`
- Create: `scripts/qa/sql/migration-0176.mjs` (base: copy the setup of `scripts/qa/sql/migration-0146.mjs`, then exec 0146 and 0176)
- Modify: `package.json` — add `"test:migration-0176": "node scripts/qa/sql/migration-0176.mjs"`
- Modify: `docs/DATABASE.md` — migration table row for 0176

**Interfaces:**
- Produces:
  - column `menu_items.submitted_by uuid null references profiles(id)` — who left the dish pending (set by the bulk RPC, cleared by a decision).
  - `public.ops_bulk_menu_apply(p_actor uuid, p_restaurant uuid, p_updates jsonb, p_inserts jsonb, p_filename text, p_client_action_id text) returns jsonb` → `{"created": int, "updated": int, "held": int, "errors": [{"kind": "update"|"insert", "index": int}]}`. `p_updates` = `[{"id": uuid, "patch": {...}}]`, `p_inserts` = `[{...columns}]`. Allowed keys in a patch/insert: `name, category, price, discount_price, description, veg, available, popular, bestseller, image_url, image_library_id, external_id` — any other key is an error for that row. `held` counts rows left/put `pending`.
  - `public.ops_replace_listing_photo(p_actor uuid, p_item uuid, p_image_url text, p_library_id uuid, p_source text, p_review_change bigint, p_client_action_id text) returns jsonb` → `{"item_id": uuid, "resolved_flags": int}`. `p_source in ('upload','library')`.
  - `public.ops_decide_listing` (same signature as 0146) re-created with: `p_decision = 'approve'` and `submitted_by = p_actor` → `raise exception 'self_approval' using errcode = '42501'`; any decision sets `submitted_by = null`.
  - Error codes for the TS layer: `forbidden` (42501, zone/staff), `self_approval` (42501), `invalid_transition` (22023), `reason_required` (22023).
  - Both new functions `security definer`, `revoke ... from public, anon, authenticated`, `grant ... to service_role` (as 0146 does).

- [ ] **Step 1: Write the failing SQL proof `scripts/qa/sql/migration-0176.mjs`**

Checks (each an `ok(...)` line, using the 0146 proof's ids `M` (manager zone A), `MB` (zone B), `R1` (shop in A), `R2` (shop in B)):
- `bulk: MB on R1 is refused (forbidden) and writes nothing` — no audit row, no new dish.
- `bulk: insert of a plain dish is approved and live` — `approval_status = 'approved'`, `submitted_by is null`.
- `bulk: insert into a restricted category is pending with submitted_by = M` and `held = 1`.
- `bulk: price change on a live restricted dish parks it` — `price` unchanged, `pending_price` = new value, `approval_status = 'pending'`.
- `bulk: price change on a plain dish applies at once`.
- `bulk: an update whose id belongs to R2 is an error row and R2's dish is unchanged`.
- `bulk: a patch key outside the allowed list (stock_qty) is an error row`.
- `bulk: changes are logged in menu_item_changes with source 'ops' and actor M`.
- `bulk: one product.bulk_menu audit row with created/updated/filename in after`.
- `bulk: replay with the same client action id creates nothing new`.
- `decide: M approving a dish M submitted is refused (self_approval)`; `decide: A (admin) approving it succeeds and clears submitted_by`.
- `photo: MB replacing R1's dish photo is refused`.
- `photo: M replaces from upload → image_url set, change logged source 'ops', not in ops_image_review_queue`.
- `photo: with p_review_change the queued review gets an 'ok' row with note 'replaced'`.
- `photo: a stale p_review_change (a later vendor photo exists) still replaces and does not raise`.
- `photo: an open wrong_image flag on the dish is resolved` and `resolved_flags = 1`.
- `photo: library source sets image_library_id`; `photo: p_source 'other' is invalid_transition`.
- `photo: one product.photo_replace audit row with before/after image_url and source`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm i --no-save @electric-sql/pglite@0.2.17; node scripts/qa/sql/migration-0176.mjs`
Expected: throws reading `0176_manager_menu_sheet_and_photo.sql` (file missing).

- [ ] **Step 3: Write the migration**

Approach: inside each RPC call `ops_require_staff(p_actor, zone)`, `_ops_replayed(...)` (return the stored `after` on replay), then `set_config('deligro.ops_moderation','on',true)` and `_ops_set_actor(p_actor, <reason>)` around the writes so `log_menu_item_change` records `ops` + actor, then `_ops_log(...)`. Because the trusted path skips `guard_menu_item_moderation`, the bulk RPC applies the restricted hold itself with `is_restricted_category()`: insert → `approval_status := case restricted then 'pending' else 'approved'`, `submitted_by := case restricted then p_actor`; update on a restricted (old or new category) dish → mirror the guard's category-move / discount / price branches (park price in `pending_price`, set `pending`, `approval_note` = the guard's wording, `submitted_by := p_actor`). Each row runs in its own `begin … exception when others … end` block so one bad row becomes an `errors` entry, not a rollback. The photo RPC: update `image_url`/`image_library_id`; if `p_review_change` is still unreviewed insert `listing_image_reviews(outcome 'ok', note 'replaced')`, otherwise skip silently; resolve open `listing_flags` with `reason = 'wrong_image'` for the dish (same columns `ops_resolve_listing_flag` sets).

- [ ] **Step 4: Run the proof and the existing ones**

Run: `node scripts/qa/sql/migration-0176.mjs; node scripts/qa/sql/migration-0146.mjs; node scripts/qa/sql/migration-order.mjs`
Expected: all `ok`, final line `… passed, 0 failed` for each.

- [ ] **Step 5: Commit** (see Global Constraints)

```bash
git add supabase/migrations/0176_manager_menu_sheet_and_photo.sql scripts/qa/sql/migration-0176.mjs package.json docs/DATABASE.md
git commit -m "feat(manager): 0176 bulk menu and photo replace RPCs, no self-approval"
```

### Task 2: Switches and allowed actions

**Files:**
- Modify: `src/lib/features/catalog.ts` (next to `manager.products.adjust_stock`, line ~83)
- Modify: `src/lib/ops/product-rules.ts:97-112` (`AllowedProductActions`, `allowedProductActions`)
- Modify: `src/lib/ops/vendor-rules.ts:27-46` (`AllowedVendorActions`, `allowedVendorActions`)
- Modify: `src/lib/data-access/manager-product-actions.ts` — map RPC error `self_approval` → `{ ok: false, status: 403, error: "self_approval" }`
- Test: `scripts/qa/manager-vendor-product-rules.ts`

**Interfaces:**
- Produces: `AllowedProductActions.replacePhoto: boolean` (= view && `manager.products.replace_photo`); `AllowedVendorActions.menuSheet: boolean` (= `manager.products.view` && `manager.products.bulk_menu`). Both reach the app through the existing `allowed` objects of the product and vendor detail payloads.

- [ ] **Step 1: Add failing checks** to `scripts/qa/manager-vendor-product-rules.ts`: `replacePhoto false by default`, `replacePhoto true with view + replace_photo`, `replacePhoto false without view`, `menuSheet false by default`, `menuSheet true with view + bulk_menu`, and `both new switches are in the catalog, defaultOn false`.
- [ ] **Step 2: Run** `npx tsx scripts/qa/manager-vendor-product-rules.ts` — Expected: the new checks FAIL.
- [ ] **Step 3: Implement** the two catalog entries (exact labels/offMeans from Global Constraints), the two booleans, and the `self_approval` mapping.
- [ ] **Step 4: Run** the same script plus `npx tsx scripts/qa/role-features.ts` — Expected: `0 failed`.
- [ ] **Step 5: Commit** `feat(manager): bulk menu and replace photo switches`

### Task 3: Menu sheet server

**Files:**
- Modify: `src/lib/bulk/menu-plan.ts` — add `managerMenuColumns(canAdjustStock: boolean): ReadonlySet<ColumnKey>` (= `OWNER_COLUMNS` minus `stock`/`lowStockAt` when false)
- Modify: `src/lib/data-access/bulk-menu.ts` — add `runManagerMenuSheet`, `exportManagerMenuSheet`, `bulkMenuRpcArgs`
- Create: `src/app/api/manager/vendors/[id]/menu-sheet/route.ts`
- Create: `scripts/qa/manager-menu-sheet.ts`; `package.json` `"test:manager-menu-sheet"`

**Interfaces:**
- Consumes: `ops_bulk_menu_apply` (Task 1), `managerShop`, `loadDishes`, `planSheet`, `outcome`, `parseSheetFile`, `opsProductAction(... adjust_stock ...)`, `notifyVendorOps(restaurantId, "listing", {title, body}, url)` via `deferNotify`.
- Produces:
  - `bulkMenuRpcArgs(plan: Plan): { updates: { id: string; patch: Record<string, unknown> }[]; inserts: Record<string, unknown>[]; stock: { dishId: string; stockQty: number | null; expected: number | null; line: number; name: string }[] }` — pure; splits `stock_qty`/`low_stock_at` out of patches into `stock`.
  - `runManagerMenuSheet(args: { actor: OpsActor; scope: ManagerScope; restaurantId: string; bytes: Uint8Array; filename: string; mode: "preview" | "apply"; canAdjustStock: boolean; clientActionId: string }): Promise<BulkOutcome>` — `canCreate: true`, columns from `managerMenuColumns`, photo auto-match for new dishes as `runOwnerSheet` does; apply = one RPC call (chunks of 100 inserts / 100 updates, each chunk its own `clientActionId` suffix `:n`), then stock rows through `opsProductAction`; one shop notice when `created + updated > 0`.
  - `exportManagerMenuSheet(restaurantId: string, format: "csv" | "xlsx", template: boolean, canAdjustStock: boolean)`.
  - Route: `GET ?format=csv|xlsx[&template=1]` needs `manager.products.view`; `POST` multipart `file`, `mode`, `clientActionId` — preview needs view, apply needs `manager.products.bulk_menu` (403 `permission_denied` otherwise); `managerWriteLimit(ctx, "menu-sheet", 10)`; not in scope → 404 `not_found`; reuse `readSheetUpload` / `sheetResponse`.

- [ ] **Step 1: Write failing `scripts/qa/manager-menu-sheet.ts`**: `managerMenuColumns(false)` has `price`, `available`, `imageUrl` and not `stock`/`lowStockAt`; `managerMenuColumns(true)` has `stock`; `planSheet` with `managerMenuColumns(false)` on a sheet carrying `stock` lists `stock` in `ignoredColumns` and no patch has `stock_qty`; `bulkMenuRpcArgs` moves `stock_qty` out of a patch into `stock` with `expected = stockBefore`; a create row lands in `inserts` without `restaurant_id`; structural: the route file calls `managerApiContext("manager.products.view")` and checks `manager.products.bulk_menu` before `mode === "apply"` writes (read the file text, as `manager-product-actions.ts` does for its structural rule).
- [ ] **Step 2: Run** `npx tsx scripts/qa/manager-menu-sheet.ts` — Expected: FAIL (exports missing).
- [ ] **Step 3: Implement** the planner helper, the three data-access functions and the route.
- [ ] **Step 4: Run** `npx tsx scripts/qa/manager-menu-sheet.ts; npx tsx scripts/qa/manager-products.ts; $env:NODE_OPTIONS='--max-old-space-size=8192'; npx tsc --noEmit -p .` — Expected: `0 failed`, tsc exit 0.
- [ ] **Step 5: Commit** `feat(manager): menu sheet upload for a shop`

### Task 4: Photo replace server

**Files:**
- Modify: `src/lib/ops/product-actions.ts` — add `parsePhotoReplaceBody`
- Create: `src/lib/data-access/menu-photo.ts` — `uploadMenuPhoto`
- Modify: `src/lib/data-access/manager-product-actions.ts` — add `opsReplacePhoto`
- Create: `src/app/api/manager/products/[id]/photo/route.ts`, `src/app/api/manager/products/[id]/photo-suggestions/route.ts`
- Test: `scripts/qa/manager-product-actions.ts` (extend)

**Interfaces:**
- Consumes: `ops_replace_listing_photo` (Task 1), `suggestImages(dishName, limit)` / `listFoodImages({ query, limit })` from `food-images.ts`, the type/size checks inside `uploadVendorLogo` (`src/lib/data-access/vendor-logo.ts`; factor the byte check into a shared helper rather than copying it).
- Produces:
  - `parsePhotoReplaceBody(b: unknown): { ok: true; value: { libraryImageId: string | null; reviewChangeId: number | null; clientActionId: string } } | { ok: false; field: string }` — `clientActionId` required (8–100 chars); `libraryImageId` a uuid when present.
  - `uploadMenuPhoto(restaurantId: string, file: File): Promise<string>` — public URL in bucket `menu-images` at `<restaurantId>/ops-<uuid>.<ext>`; throws `invalid_type` / `too_large`.
  - `opsReplacePhoto(actor: OpsActor, scope: ManagerScope, itemId: string, b: { imageUrl: string; libraryImageId: string | null; source: "upload" | "library"; reviewChangeId: number | null; clientActionId: string }): Promise<OpsResult>` — notifies the shop "Deligro replaced the photo of <dish>" (not on replay).
  - `POST /api/manager/products/[id]/photo`: multipart (`file`, `clientActionId`, optional `reviewChangeId`) or JSON (`libraryImageId`, `clientActionId`, optional `reviewChangeId`); needs `manager.products.replace_photo`; `managerWriteLimit(ctx, "photo-replace", 30)`; → 200 `{ ok: true, product }` (fresh `getManagerProductDetail`), 400 `bad_file` | `bad_request`, 403, 404, 429.
  - `GET /api/manager/products/[id]/photo-suggestions?q=` (needs `manager.products.replace_photo`) → `{ items: { id: string; title: string; imageUrl: string }[] }` — `suggestImages(dish name, 12)` (returns `{ image, score, reason }[]` — map `image`) when `q` is empty, else `listFoodImages({ query: q, limit: 24 })`.

- [ ] **Step 1: Add failing checks** to `scripts/qa/manager-product-actions.ts`: `photo body: library id + client id ok`; `photo body: missing clientActionId → field clientActionId`; `photo body: libraryImageId not a uuid → field libraryImageId`; `photo body: reviewChangeId "12" → 12, "x" → field reviewChangeId`; and the shared byte check refuses PDF bytes named `.jpg` (`%PDF-` header) and accepts a JPEG header (`FF D8 FF`).
- [ ] **Step 2: Run** `npx tsx scripts/qa/manager-product-actions.ts` — Expected: the new checks FAIL.
- [ ] **Step 3: Implement** the parser, shared byte check, upload helper, `opsReplacePhoto` and both routes.
- [ ] **Step 4: Run** the script and tsc (as in Task 3) — Expected: `0 failed`, tsc exit 0.
- [ ] **Step 5: Commit** `feat(manager): replace a dish photo from the phone or the photo library`

### Task 5: App — menu sheet

**Files:**
- Modify: `apps/manager/lib/features/products/bulk_stock_screen.dart` → add `enum BulkSheetMode { stock, menu }` and a `mode` + optional `vendorId` constructor parameter (menu mode: title "Menu sheet", template download button, Apply needs `manager.products.bulk_menu`, help text says new dishes go live at once and restricted categories wait for approval)
- Create: `apps/manager/lib/data/menu_sheet_repository.dart` (same shape as `BulkStockRepository`, path `/api/manager/vendors/<id>/menu-sheet`, `download({required String vendorId, required bool xlsx, bool template = false})`, `send(vendorId, bytes, fileName, {required bool apply, required String clientActionId})`) + its provider next to `bulkStockRepoProvider`
- Modify: `apps/manager/lib/models/vendors.dart:514` `VendorAllowed.menuSheet`; `apps/manager/lib/features/vendors/vendor_detail_screen.dart` — "Menu sheet" button when `allowed.menuSheet`, pushing the route below
- Modify: `apps/manager/lib/router.dart:235` — `bulk` route reads `?mode=menu&vendor=<id>`
- Test: `apps/manager/test/bulk_stock_test.dart` (extend), `apps/manager/test/vendor_detail_test.dart` (extend)

- [ ] **Step 1: Write failing widget tests**: `menu mode shows "Menu sheet", the template button and the go-live note`; `menu mode Apply is disabled without manager.products.bulk_menu`; `menu mode preview shows "3 new, 2 changed"` from a preview JSON with `create: 3, update: 2`; `vendor detail shows Menu sheet only when allowed.menuSheet`; `VendorAllowed.fromJson reads menuSheet (default false)`.
- [ ] **Step 2: Run** `cd apps/manager; F:\dev\flutter\bin\flutter test test/bulk_stock_test.dart test/vendor_detail_test.dart` — Expected: FAIL.
- [ ] **Step 3: Implement.** Generate the `clientActionId` once per picked file (`uuid` package) so a retried Apply replays.
- [ ] **Step 4: Run** the tests, then `F:\dev\flutter\bin\flutter analyze` — Expected: all pass, "No issues found!".
- [ ] **Step 5: Commit** `feat(manager-app): menu sheet for a shop`

### Task 6: App — replace photo

**Files:**
- Create: `apps/manager/lib/features/products/replace_photo_sheet.dart` — `Future<ProductDetail?> showReplacePhotoSheet(BuildContext context, WidgetRef ref, {required String productId, required String dishName, int? reviewChangeId})`: three choices "Take photo", "Choose from gallery", "Deligro photo library"; library view = search field + grid from photo-suggestions; confirm before sending
- Modify: `apps/manager/lib/data/products_repository.dart` — `Future<Outcome<ProductDetail>> replacePhotoUpload(String id, XFile file, {int? reviewChangeId, required String clientActionId})`, `Future<Outcome<ProductDetail>> replacePhotoFromLibrary(String id, String libraryImageId, {int? reviewChangeId, required String clientActionId})`, `Future<List<LibraryPhoto>> photoSuggestions(String id, {String? q})`
- Modify: `apps/manager/lib/models/products.dart:369` — `ProductAllowed.replacePhoto`; add `class LibraryPhoto { id, title, imageUrl }`
- Modify: `apps/manager/lib/features/products/image_reviews_screen.dart` (a "Replace photo" action on each card when the manager has `manager.products.replace_photo`; on success the card leaves the list) and `product_detail_screen.dart` (button when `allowed.replacePhoto`; refresh on success)
- Test: `apps/manager/test/products_screens_test.dart` (extend)

- [ ] **Step 1: Write failing widget tests**: `replace sheet offers camera, gallery and library`; `library tab shows suggestions and searching calls photoSuggestions with q`; `choosing a library photo calls replacePhotoFromLibrary with the review change id`; `a successful replace from Image reviews removes that card`; `product detail hides Replace photo when allowed.replacePhoto is false`.
- [ ] **Step 2: Run** `flutter test test/products_screens_test.dart` — Expected: FAIL.
- [ ] **Step 3: Implement** (resize/compress the camera photo with `image_picker`'s `maxWidth: 1600, imageQuality: 85`).
- [ ] **Step 4: Run** the tests and `flutter analyze` — Expected: pass, no issues.
- [ ] **Step 5: Commit** `feat(manager-app): replace a wrong dish photo`

### Task 7: Release check

**Files:**
- Modify: `docs/manager-app-resume.md` (owner steps: apply 0176, deploy, switch on per manager), `SECURITY.md` route table (two new manager routes)

- [ ] **Step 1:** `cd apps/manager; flutter build apk --release --dart-define-from-file=env/prod.json` (env per `flutter-build-env`; if `env/prod.json` is missing, copy `F:\hub26\keys\manager-prod.json.parked`). Expected: `√ Built … app-release.apk`.
- [ ] **Step 2:** Install on the `deligro_test` emulator (take `F:\dev\tmp\emulator.lock`), sign in as `manager@deligro.demo`, open a vendor → Menu sheet and a product → Replace photo. Expected: the screens open; actions return a clear error until 0176 is applied live (owner step), not a crash.
- [ ] **Step 3:** Run every script touched: `test:migration-0176`, `test:manager-menu-sheet`, `scripts/qa/manager-product-actions.ts`, `scripts/qa/manager-vendor-product-rules.ts`, full `flutter test` in `apps/manager`. Expected: `0 failed` everywhere.
- [ ] **Step 4: Commit** `docs(manager): menu sheet and photo replace owner steps`
