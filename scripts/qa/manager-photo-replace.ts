/**
 * QA — a manager replacing a dish photo (0176): the request body, the byte
 * check that keeps a renamed file out of the public bucket, and the route's
 * switches.
 * Usage: npx tsx --conditions=react-server scripts/qa/manager-photo-replace.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parsePhotoReplaceBody } from "../../src/lib/ops/product-actions";
import { assertRealType } from "../../src/lib/utils/file-signature";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra === undefined ? "" : `\n         ${JSON.stringify(extra)}`}`); }
}
const cid = randomUUID();
const lib = randomUUID();

console.log("\n── body ──");
let r = parsePhotoReplaceBody({ libraryImageId: lib, clientActionId: cid });
check("photo body: library id + client id ok", r.ok && r.value.libraryImageId === lib && r.value.clientActionId === cid && r.value.reviewChangeId === null, r);
r = parsePhotoReplaceBody({ clientActionId: cid });
check("photo body: an upload has no library id", r.ok && r.value.libraryImageId === null, r);
r = parsePhotoReplaceBody({ libraryImageId: lib });
check("photo body: missing clientActionId → field clientActionId", !r.ok && r.field === "clientActionId", r);
r = parsePhotoReplaceBody({ libraryImageId: "abc", clientActionId: cid });
check("photo body: libraryImageId not a uuid → field libraryImageId", !r.ok && r.field === "libraryImageId", r);
r = parsePhotoReplaceBody({ clientActionId: cid, reviewChangeId: "12" });
check("photo body: reviewChangeId \"12\" → 12", r.ok && r.value.reviewChangeId === 12, r);
r = parsePhotoReplaceBody({ clientActionId: cid, reviewChangeId: "x" });
check("photo body: reviewChangeId \"x\" → field reviewChangeId", !r.ok && r.field === "reviewChangeId", r);
r = parsePhotoReplaceBody({ clientActionId: cid, reviewChangeId: "" });
check("photo body: an empty reviewChangeId (a form field left blank) is none", r.ok && r.value.reviewChangeId === null, r);
check("photo body: no body → field body", (() => { const x = parsePhotoReplaceBody(null); return !x.ok && x.field === "body"; })());

async function main() {
console.log("\n── bytes ──");
const refuses = async (f: File) => assertRealType(f, ["image/jpeg", "image/png", "image/webp"]).then(() => false, (e: Error) => e.message === "invalid_type");
check("PDF bytes named .jpg are refused", await refuses(new File([new TextEncoder().encode("%PDF-1.7\n%âãÏÓ")], "dish.jpg", { type: "image/jpeg" })));
check("a JPEG header is accepted",
  !(await refuses(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])], "dish.jpg", { type: "image/jpeg" }))));

console.log("\n── routes ──");
const photo = readFileSync("src/app/api/manager/products/[id]/photo/route.ts", "utf8");
check("photo route needs manager.products.replace_photo", photo.includes('"manager.products.replace_photo"'));
check("photo route is rate limited 30 a minute", /managerWriteLimit\(ctx, "photo-replace", 30\)/.test(photo));
check("photo route answers bad_file for a refused file", photo.includes('"bad_file"'));
const sugg = readFileSync("src/app/api/manager/products/[id]/photo-suggestions/route.ts", "utf8");
check("suggestions route needs manager.products.replace_photo", sugg.includes('"manager.products.replace_photo"'));
check("suggestions route stays in the manager's zones", sugg.includes("scopedProductRow("));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}
void main();
