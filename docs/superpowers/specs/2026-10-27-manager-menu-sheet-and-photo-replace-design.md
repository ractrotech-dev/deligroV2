# Manager app: bulk menu upload and photo replace — design

Date: 2026-10-27. Built on `master` (owner's choice), in `apps/manager` (Flutter) and `/api/manager/*` (Next.js).

## Why

Managers already onboard shops in their zones, but a new shop's menu still has to be typed in by
the shop or by Admin, one dish at a time. And when a manager spots a wrong or bad dish photo in
Image reviews, all they can do today is flag it and wait for the shop to fix it. The owner wants
the manager to be able to finish both jobs themselves.

## Goals

1. **Bulk menu upload for a shop.** From a shop's page in the Manager app, the manager downloads
   the shop's menu (or an empty template) as Excel or CSV, edits it, uploads it, sees a preview of
   what will be added and changed, and applies it. Same sheet format, columns and checks as the
   Partner app (`/api/vendor/menu/bulk`) and Admin (`/api/admin/vendors/[id]/menu-sheet`) — one
   sheet works in all three.
2. **Replace a dish photo directly.** From an Image review card and from a dish's page, the manager
   can replace the photo either with a photo taken or picked on the phone, or with a photo from
   Deligro's food photo library (opening on the best matches for the dish name).

## Decided by the owner

- Dishes from a manager's sheet **go live right away** — no shop approval step.
- Photo replacement offers **both** sources: phone camera/gallery and the food photo library.
- Built **on master**, not a separate branch.

## My calls (owner can override)

- **Restricted categories keep their rule.** A new dish in a restricted category is created as
  `pending`, and a price/discount change on a live restricted dish waits for approval — exactly
  what happens when a shop makes the same edit by hand (`guard_menu_item_moderation`, 0146).
  Everything else goes live at once. Caution for the builder: the service-role client and
  `deligro.ops_moderation = 'on'` both count as "trusted" and skip that guard, so the manager write
  path must not simply reuse either without reapplying the restricted rule.
- **Two new permission switches**, both `defaultOn: false` like the other sensitive manager powers:
  `manager.products.bulk_menu` ("Bulk menu upload") and `manager.products.replace_photo`
  ("Replace photos"). Downloading the sheet and previewing need `manager.products.view`; applying
  needs `bulk_menu`. Switch both on for `manager@deligro.demo` after deploy.
- **Zone scope:** only shops in the manager's zones (`managerShop()` in `bulk-menu.ts` already does
  this check for the stock sheet). Out-of-zone → 404.
- **Audit:** each applied sheet writes one `ops_audit_log` row (`product.bulk_menu`: shop, counts of
  created/updated, filename). Each photo replace writes one row (`product.photo_replace`: old URL,
  new URL, source `upload` | `library`, library id). Per-dish change rows in `menu_item_changes`
  are recorded by the existing trigger with source `ops` and the manager as actor.
- **The shop is told** through `notifyShop()` (inbox + push): "Deligro updated your menu: N added,
  M changed" / "Deligro replaced the photo of <dish>". No manager name or free text in the push.
- **A replaced photo counts as reviewed.** Because the change is logged with source `ops`, it never
  enters `ops_image_review_queue` (which only lists `source = 'vendor'`). If the replace starts from
  a review card, the pending review row for that change is closed as `ok` with note
  "replaced" in the same transaction, so the card leaves the queue.
- **If the dish had an open `wrong_image` flag,** replacing the photo resolves that flag.
- **Limits:** sheet — same 2 MB / 500 rows as the shop's; 10 uploads a minute per manager. Photo —
  jpeg/png/webp ≤ 5 MB, bytes checked against the claimed type (reuse the logo upload checks);
  30 replaces a minute.
- **Rows that fail** in a sheet don't stop the rest; the result lists them (same as today's
  owner sheet).
- **Stock columns follow the existing stock rule.** The sheet's `stock` / `lowStockAt` columns are
  applied only when the manager also holds `manager.products.adjust_stock`, and each stock change
  goes through `ops_adjust_stock` with the count the sheet was made from (stale → that row is
  refused). Without that switch the downloaded sheet leaves the stock columns out and an uploaded
  sheet's stock columns are ignored (listed under `ignoredColumns`).
- **Availability (`available`) comes with "Bulk menu upload"** — it is part of the menu, and the
  owner wants the sheet live at once. Hiding by ops (`hidden_by_ops`) stays a moderation action.
- **Writes go through an RPC**, not plain service-role writes: only a write inside the RPC with
  `deligro.ops_moderation` on is logged in `menu_item_changes` as `ops` with the manager as actor.

## Non-goals

- No AI image generation.
- No deleting dishes from a sheet (the shop's sheet doesn't delete either).
- No changes to the web `/manager` console — Manager app only.
- No change to the existing stock-only sheet; it stays as is. (The builder may put both behind one
  "Sheets" screen with two tabs if that reads better.)

## Anti-goals

- A manager in zone A must never be able to touch a shop in zone B.
- A restricted-category dish must never go live without approval through this path.
- No password, phone number or free-text reason in a push or inbox line.
- Must not break the Partner app's or Admin's sheet — same parser and format.

## How it fits the existing code

Server (new):
- `GET/POST /api/manager/vendors/[id]/menu-sheet` — mirrors the admin route; uses
  `exportOwnerSheet` / the owner sheet planner from `src/lib/data-access/bulk-menu.ts` and
  `readSheetUpload` / `sheetResponse` from `src/lib/bulk/upload.ts`. Writes go through a new
  audited RPC in migration `0176_manager_menu_sheet_and_photo.sql` (it reapplies the restricted
  rule itself — a `security definer` function runs as `postgres`, which the guard trusts) after
  `managerShop()` confirms zone scope.
- `POST /api/manager/products/[id]/photo` — multipart `file` **or** JSON `{ libraryImageId }`, plus
  optional `reviewChangeId` and `clientActionId` (replays change nothing). Upload goes to the
  `menu-images` bucket in the shop's folder (`<restaurantId>/…`, the path the Partner app uses);
  library choice sets `image_url` to the library photo and `image_library_id`. One RPC
  (`ops_replace_listing_photo` in 0176) sets the photo with `deligro.ops_moderation` on, closes the
  review row / `wrong_image` flag, and audits.
- `GET /api/manager/products/[id]/photo-suggestions?q=` — `suggestImages()` for the dish name, or
  `listFoodImages()` when the manager types a search.
- Catalog: add the two switches to `src/lib/features/catalog.ts`; the product detail payload's
  allowed actions gain `replacePhoto`; the vendor detail payload gains `menuSheet`.

App (`apps/manager`):
- Vendor detail screen → "Menu sheet" button (shown when allowed) → screen modelled on
  `bulk_stock_screen.dart`: download template / current menu, pick file, preview counts + item list
  + issues, Apply.
- Image review card and product detail → "Replace photo" → bottom sheet: "Take photo",
  "Choose from gallery", "Deligro photo library" (grid of suggestions with a search box). After
  replace: the card leaves the queue / the detail refreshes.
- English only (manager side has no Hindi).

## Testing

- SQL proof of the new RPC(s) in the PGlite harness: zone refusal, replay, restricted dish stays
  pending, review row closed, flag resolved, audit row written.
- QA scripts under `scripts/qa/` for both routes (permission off → 403, out-of-zone → 404,
  preview writes nothing, apply writes, bad file → 400).
- Flutter widget tests for the sheet screen and the replace sheet; `flutter analyze` clean.
- Build the Manager release APK and smoke-test it on the emulator (`F:\dev`), signed in as
  `manager@deligro.demo`.

## Owner steps after build

1. Apply migration 0176 to the live database.
2. Deploy the website (the new routes).
3. Switch on the two new switches for each manager who should have them (done for the demo
   account by script once 0176 is live).
4. Install the new Manager APK.
