/**
 * Food photos from the owner's Google Drive: settings fail closed, the token is
 * really encrypted, the app can only read, file names become dish names, every door
 * checks the role, and a dish gets a photo by itself only at 95% or better.
 *
 * Usage: npm run test:drive
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { AUTO_MATCH_MIN, autoMatch, keywordsFor, vegFromTokens } from "../../src/lib/images/match";
import {
  DRIVE_SCOPE,
  decryptToken,
  dishTitleFromFileName,
  driveConfig,
  encryptToken,
  folderIdFrom,
  googleSignInUrl,
  isDriveId,
  isGoogleThumbnail,
} from "../../src/lib/drive/core";

let passed = 0;
let failed = 0;
function ok(name: string, run: () => void) {
  try {
    run();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
const read = (p: string) => readFileSync(p, "utf8");

const key = Buffer.alloc(32, 7);
const env = {
  GOOGLE_DRIVE_CLIENT_ID: "id",
  GOOGLE_DRIVE_CLIENT_SECRET: "secret",
  GOOGLE_DRIVE_REDIRECT_URI: "https://example.test/api/admin/drive/callback",
  GOOGLE_DRIVE_TOKEN_KEY: key.toString("base64"),
};
const config = driveConfig(env)!;

ok("all settings present: on", () => assert.ok(config));
for (const name of Object.keys(env)) {
  ok(`${name} missing: off`, () => assert.equal(driveConfig({ ...env, [name]: undefined }), null));
}
ok("a key that isn't 32 bytes: off", () =>
  assert.equal(driveConfig({ ...env, GOOGLE_DRIVE_TOKEN_KEY: Buffer.alloc(16).toString("base64") }), null));

ok("sign-in asks to read only", () => {
  const url = new URL(googleSignInUrl(config, "abc"));
  assert.equal(url.searchParams.get("scope"), DRIVE_SCOPE);
  assert.ok(DRIVE_SCOPE.endsWith("/drive.readonly"));
});
ok("sign-in asks for lasting access and carries the state", () => {
  const url = new URL(googleSignInUrl(config, "abc"));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "abc");
});

ok("the token round-trips", () => assert.equal(decryptToken(encryptToken("refresh-1", key), key), "refresh-1"));
ok("the stored token doesn't contain it", () => assert.ok(!encryptToken("refresh-1", key).includes("refresh-1")));
ok("the same token encrypts differently each time", () =>
  assert.notEqual(encryptToken("refresh-1", key), encryptToken("refresh-1", key)));
ok("a wrong key is refused", () => assert.throws(() => decryptToken(encryptToken("x", key), Buffer.alloc(32, 8))));
ok("an altered token is refused", () => {
  const [iv, tag, data] = encryptToken("refresh-1", key).split(".");
  const bytes = Buffer.from(data, "base64");
  bytes[0] ^= 1;
  assert.throws(() => decryptToken([iv, tag, bytes.toString("base64")].join("."), key));
});

ok("a file name becomes the dish name", () => {
  assert.equal(dishTitleFromFileName("Chicken Biryani.jpg"), "Chicken Biryani");
  assert.equal(dishTitleFromFileName("paneer_butter-masala (2).JPG"), "paneer butter masala");
  assert.equal(dishTitleFromFileName("Dal Makhani.webp"), "Dal Makhani");
});
ok("a camera's name is refused", () => {
  for (const name of ["IMG_1234.jpg", "DSC0001.jpg", "PXL_20260101_101010.jpg", "Screenshot 2026-11-05 at 10.30.12.png", "WhatsApp Image 2026-11-05 at 10.30.12 AM.jpeg", "1234.png", "image.png", "photo (3).jpg"]) {
    assert.equal(dishTitleFromFileName(name), null, name);
  }
});
ok("a dish name that starts like a camera word still works", () =>
  assert.equal(dishTitleFromFileName("Pic Pizza Special.jpg"), "Pic Pizza Special"));

ok("a folder link gives its id", () => {
  assert.equal(folderIdFrom("https://drive.google.com/drive/folders/1AbC-d_e2?usp=sharing"), "1AbC-d_e2");
  assert.equal(folderIdFrom("https://drive.google.com/drive/u/0/folders/1AbC-d_e2"), "1AbC-d_e2");
  assert.equal(folderIdFrom("1AbC-d_e2"), "1AbC-d_e2");
});
ok("anything else is refused", () => {
  for (const bad of ["https://evil.test/folders/1AbC-d_e2", "http://drive.google.com/drive/folders/1AbC-d_e2", "abc' or 1=1", ""]) {
    assert.equal(folderIdFrom(bad), null, bad);
  }
});
ok("an id can't change a query", () => assert.ok(!isDriveId("abc' or 1=1")));
ok("the token only goes to Google's image host", () => {
  assert.ok(isGoogleThumbnail("https://lh3.googleusercontent.com/abc=s220"));
  for (const bad of ["http://lh3.googleusercontent.com/a", "https://googleusercontent.com.evil.test/a", "https://evil.test/a"]) {
    assert.equal(isGoogleThumbnail(bad), false, bad);
  }
});

for (const file of ["connect/route.ts", "callback/route.ts"]) {
  ok(`${file} checks the role first`, () => assert.match(read(`src/app/api/admin/drive/${file}`), /await requireRole\("admin"\)/));
  ok(`${file} is rate limited`, () => assert.match(read(`src/app/api/admin/drive/${file}`), /rateLimit\(/));
}
ok("the general upload route is gone", () => assert.equal(existsSync("src/app/api/admin/drive/files/route.ts"), false));
ok("every action checks the role and is rate limited", () => {
  const src = read("src/app/admin/storage/drive-actions.ts");
  const count = (re: RegExp) => (src.match(re) ?? []).length;
  assert.equal(count(/export async function/g), count(/await requireRole\("admin"\)/g));
  assert.equal(count(/export async function/g), count(/await rateLimit\(/g));
});
ok("the callback compares the state before using the code", () => {
  const src = read("src/app/api/admin/drive/callback/route.ts");
  assert.ok(src.indexOf("sameState(") < src.indexOf("completeDriveConnection(code"));
});
ok("the table is locked to the service role", () => {
  const sql = read("supabase/migrations/0204_google_drive_connection.sql");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.google_drive_connection from public, anon, authenticated/);
  assert.doesNotMatch(sql, /create policy/i);
});

const drive = read("src/lib/data-access/google-drive.ts");
ok("the token is only ever stored encrypted", () =>
  assert.match(drive, /refresh_token_enc: encryptToken\(json\.refresh_token, config\.tokenKey\)/));
ok("no browser code touches the token or the secret", () => {
  for (const f of ["drive-controls.tsx", "drive-panel.tsx"]) {
    assert.doesNotMatch(read(`src/app/admin/storage/${f}`), /refresh_token|client_secret|tokenKey|lib\/drive\/core/);
  }
});
const images = read("src/lib/data-access/food-images.ts");
ok("an automatic match needs 95%", () => {
  assert.equal(AUTO_MATCH_MIN, 0.95);
  assert.match(images, /autoMatch\(dishName, await candidatesFor\(dishName\)\)/);
  assert.match(images, /autoMatch\(dishName, \(await listDrivePhotos\(\)\)\.map\(driveCandidate\)\)/);
});
ok("a dish that came with a photo is never matched, on every way in", () => {
  assert.match(read("src/lib/data-access/admin-menu.ts"), /if \(input\.imageUrl\) return \{\};/);
  assert.match(read("src/lib/data-access/vendor-menu.ts"), /if \(!row\.image_url\) \{\s*const match = await autoMatchImage/);
  assert.match(read("src/lib/data-access/bulk-menu.ts"), /inserts\.filter\(\(i\) => !i\.image_url\)/);
});
ok("a photo is checked to be in the folder before any read", () => {
  assert.match(drive, /parents\?\.includes\(row\.folder_id\)/);
  assert.match(drive, /export async function drivePhotoFile[\s\S]{0,120}photoInFolder\(id\)/);
  assert.match(drive, /export async function drivePhotoPreview[\s\S]{0,160}photoInFolder\(id\)/);
});
ok("a photo enters storage through the library's checked upload", () => assert.match(images, /addFoodImage\(\{ file: photo\.file, title: photo\.title, adminId \}\)/));
ok("nothing is imported in bulk", () => assert.doesNotMatch(drive + read("src/app/admin/storage/drive-controls.tsx"), /importDriveBatch|fillMissingMenuPhotos|Import photos/));
ok("the preview route and both pick actions check who is asking", () => {
  assert.match(read("src/app/api/drive-photo/[id]/route.ts"), /await requireVendorAccess\(\)[\s\S]*rateLimit\(/);
  assert.match(read("src/app/vendor/menu/actions.ts"), /vendorFoodImageFromDrive[\s\S]*requireVendorAccess\(\)[\s\S]*assertVendorFeature[\s\S]*rateLimit\(/);
  assert.match(read("src/app/admin/food-images/actions.ts"), /foodImageFromDriveAction[\s\S]*requireRole\("admin"\)[\s\S]*rateLimit\(/);
});

const dish = (title: string, veg: boolean | null = null) => {
  const keywords = keywordsFor(title);
  return { id: title, title, imageUrl: "", keywords, veg: veg ?? vegFromTokens(keywords) };
};
ok("the same name matches, however it is written", () => {
  assert.equal(autoMatch("Chicken Biryani", [dish("chicken biryani")])?.similarity, 1);
  assert.equal(autoMatch("Biryani Chicken", [dish("chicken biryani")])?.similarity, 1);
  assert.ok(autoMatch("CHICKEN-BIRYANI", [dish("Chicken Biryani")]));
});
ok("a known other spelling matches", () => {
  assert.ok(autoMatch("Murgh Biryani", [dish("Chicken Biryani")]));
  assert.ok(autoMatch("Chiken Biryani", [dish("Chicken Biryani")]));
});
ok("a small typo in a long name matches", () =>
  assert.ok(autoMatch("Paneer Butter Masalla With Naan", [dish("Paneer Butter Masala With Naan")])));
ok("under 95% doesn't match", () => {
  assert.equal(autoMatch("Paneer Tiika", [dish("Paneer Tikka")]), null);
  assert.equal(autoMatch("Biryani", [dish("Chicken Biryani")]), null);
  assert.equal(autoMatch("Hyderabadi Chicken Biryani", [dish("Chicken Biryani")]), null);
});
ok("different dishes never match", () => {
  assert.equal(autoMatch("Veg Biryani", [dish("Egg Biryani")]), null);
  assert.equal(autoMatch("Chicken 65", [dish("Chicken 66")]), null);
  assert.equal(autoMatch("Paneer Tikka", [dish("Chicken Tikka")]), null);
});
ok("two photos equally close: a person chooses", () =>
  assert.equal(autoMatch("Chicken Biryani", [dish("Chicken Biryani"), { ...dish("chicken biryani"), id: "other" }]), null));

ok("the app sends nothing to Drive but reads", () => {
  const api = drive.slice(drive.indexOf("async function api("), drive.indexOf("/* ---------------- connecting"));
  assert.doesNotMatch(api, /method:/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
