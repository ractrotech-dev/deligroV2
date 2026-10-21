/**
 * Delivery instructions and the customer's proof-of-delivery photo.
 *
 *   npm run test:order-instructions
 *
 * Offline: the pure rules run bare, and the data layer runs against a small
 * fake PostgREST + storage API on localhost (no database, no network beyond
 * it, nothing is sent to anyone). The modules are `server-only`, so tsx runs
 * with the `react-server` condition.
 *
 * What is pinned:
 *   - 301 characters is refused as `instructions_too_long`, before any I/O;
 *     blank is null; control characters never reach the column;
 *   - the instructions are written with the service role AFTER the order
 *     exists, and on a database without 0082 the order still places — the note
 *     is folded into the address line instead of being lost;
 *   - GET /api/orders/[id]/proof's data rule: 403 for anyone but the order's
 *     customer (and for an order that does not exist — no existence oracle),
 *     404 without a photo, a 10-minute signed URL otherwise, 503 where the
 *     bucket is not there yet.
 */
import http from "node:http";
import assert from "node:assert/strict";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${(e as Error).message.split("\n")[0]}`);
  }
}

// ---------------------------------------------------------------------------
// fake PostgREST + storage
// ---------------------------------------------------------------------------

const db: Record<string, Row[]> = {};
const mode = { missingColumns: new Set<string>(), noBucket: false };
const patches: Array<{ table: string; where: string; body: Row }> = [];
const signed: Array<{ path: string; expiresIn: number }> = [];
const t = (name: string): Row[] => (db[name] ??= []);

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  mode.missingColumns.clear();
  mode.noBucket = false;
  patches.length = 0;
  signed.length = 0;
}

function filterRows(table: string, url: URL): Row[] {
  return t(table).filter((r) => {
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "limit"].includes(k)) continue;
      if (v.startsWith("eq.") && String(r[k]) !== v.slice(3)) return false;
    }
    return true;
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    const body: Row | null = raw ? JSON.parse(raw) : null;

    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      if (mode.noBucket) return send(404, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
      const path = decodeURIComponent(url.pathname.replace("/storage/v1/object/sign/delivery-proofs/", ""));
      signed.push({ path, expiresIn: Number(body?.expiresIn) });
      return send(200, { signedURL: `/object/sign/delivery-proofs/${path}?token=fake` });
    }

    const table = url.pathname.replace("/rest/v1/", "");
    if (table.startsWith("rpc/")) return send(200, null); // telemetry ingest
    for (const entry of mode.missingColumns) {
      const [tbl, col] = entry.split(".");
      if (tbl !== table) continue;
      const named =
        req.method === "GET"
          ? new RegExp(`(^|[^a-z_])${col}([^a-z_]|$)`).test(url.searchParams.get("select") ?? "")
          : col in (body ?? {});
      if (named) {
        return req.method === "GET"
          ? send(400, { code: "42703", message: `column ${table}.${col} does not exist` })
          : send(400, { code: "PGRST204", message: `Could not find the '${col}' column of '${table}' in the schema cache` });
      }
    }

    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    if (req.method === "GET") {
      const rows = filterRows(table, url);
      if (!single) return send(200, rows);
      return rows.length === 1 ? send(200, rows[0]) : send(406, { code: "PGRST116", message: "0 rows" });
    }
    if (req.method === "PATCH" && body) {
      const rows = filterRows(table, url);
      patches.push({ table, where: url.search, body });
      for (const r of rows) Object.assign(r, body);
      return send(200, rows);
    }
    return send(405, { message: "unexpected" });
  });
});

const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "22222222-2222-4222-8222-222222222222";
const ORDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DELIVERY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const rules = await import("../../src/lib/orders/instructions");
  const saver = await import("../../src/lib/data-access/order-instructions");
  const proof = await import("../../src/lib/data-access/order-proof");
  const orders = await import("../../src/lib/data-access/orders");
  const { rememberColumn } = await import("../../src/lib/data-access/schema-probe");

  // ---- the rule ----------------------------------------------------------
  console.log("rule");
  await check("300 characters is accepted as is", () => {
    const r = rules.normalizeInstructions("a".repeat(300));
    assert.deepEqual(r, { ok: true, value: "a".repeat(300) });
  });
  await check("301 characters is refused as instructions_too_long", () => {
    assert.deepEqual(rules.normalizeInstructions("a".repeat(301)), { ok: false, error: "instructions_too_long" });
  });
  await check("the limit counts characters, not UTF-16 units (Hindi, emoji)", () => {
    assert.equal(rules.normalizeInstructions("\u{1F6AA}".repeat(300)).ok, true);
    assert.equal(rules.normalizeInstructions("\u{1F6AA}".repeat(301)).ok, false);
  });
  await check("empty, blank, null and undefined are null", () => {
    for (const v of ["", "   \n\t ", null, undefined]) {
      assert.deepEqual(rules.normalizeInstructions(v), { ok: true, value: null });
    }
  });
  await check("it is trimmed before it is measured", () => {
    assert.deepEqual(rules.normalizeInstructions("  ring twice  "), { ok: true, value: "ring twice" });
    assert.equal(rules.normalizeInstructions(`  ${"a".repeat(300)}  `).ok, true);
  });
  await check("control characters become spaces; newlines survive", () => {
    assert.deepEqual(rules.normalizeInstructions("gate\u0000\u0007 code\nblue door"), { ok: true, value: "gate code\nblue door" });
  });
  await check("a non-string is refused as invalid_instructions", () => {
    for (const v of [5, {}, ["a"], true]) {
      assert.deepEqual(rules.normalizeInstructions(v), { ok: false, error: "invalid_instructions" });
    }
  });
  await check("folding appends to the address line, and is a no-op without a note", () => {
    assert.equal(rules.foldIntoAddressLine("12 Main Rd", "ring twice"), "12 Main Rd, ring twice");
    assert.equal(rules.foldIntoAddressLine("12 Main Rd", null), "12 Main Rd");
    assert.equal(rules.foldIntoAddressLine("", "ring twice"), "ring twice");
    // the manager's phone orders have always joined with a middle dot
    assert.equal(rules.foldIntoAddressLine("12 Main Rd", "less spicy", " · "), "12 Main Rd · less spicy");
  });

  console.log("createOrder");
  await check("createOrder refuses 301 characters before any query", async () => {
    await assert.rejects(
      orders.createOrder({
        restaurantSlug: "x",
        lines: [{ itemId: "a", qty: 1 }],
        address: { label: "Home", line: "12 Main Rd" },
        instructions: "a".repeat(301),
      }),
      (e: Error) => e.message === "instructions_too_long"
    );
  });
  await check("createOrder refuses a non-string as invalid_instructions", async () => {
    await assert.rejects(
      orders.createOrder({
        restaurantSlug: "x",
        lines: [{ itemId: "a", qty: 1 }],
        address: { label: "Home", line: "12 Main Rd" },
        instructions: 12 as unknown as string,
      }),
      (e: Error) => e.message === "invalid_instructions"
    );
  });

  // ---- writing it --------------------------------------------------------
  console.log("saving");
  const seedOrder = () => {
    reset();
    rememberColumn("orders.delivery_instructions", true);
    t("orders").push({ id: ORDER, customer_id: UID_A, address: { label: "Home", line: "12 Main Rd" } });
  };
  const address = { label: "Home", line: "12 Main Rd" };

  await check("a note is written to orders.delivery_instructions, address untouched", async () => {
    seedOrder();
    await saver.saveOrderInstructions({ orderId: ORDER, customerId: UID_A, instructions: "ring twice", address });
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { delivery_instructions: "ring twice" });
    assert.match(patches[0].where, /id=eq\.aaaaaaaa/);
    assert.match(patches[0].where, /customer_id=eq\.1111/);
    assert.equal(t("orders")[0].address.line, "12 Main Rd");
  });
  await check("no note, no write", async () => {
    seedOrder();
    await saver.saveOrderInstructions({ orderId: ORDER, customerId: UID_A, instructions: null, address });
    assert.equal(patches.length, 0);
  });
  await check("before 0082 the order still places: the note is folded into the address line", async () => {
    seedOrder();
    rememberColumn("orders.delivery_instructions", true); // not yet known missing
    mode.missingColumns.add("orders.delivery_instructions");
    await saver.saveOrderInstructions({ orderId: ORDER, customerId: UID_A, instructions: "ring twice", address });
    assert.equal(t("orders")[0].address.line, "12 Main Rd, ring twice");
    assert.equal(t("orders")[0].address.label, "Home");
    assert.equal("delivery_instructions" in t("orders")[0], false);
  });
  await check("once known missing, the column is not tried again", async () => {
    seedOrder();
    rememberColumn("orders.delivery_instructions", false);
    mode.missingColumns.add("orders.delivery_instructions");
    await saver.saveOrderInstructions({ orderId: ORDER, customerId: UID_A, instructions: "gate 4", address });
    assert.equal(patches.length, 1);
    assert.deepEqual(Object.keys(patches[0].body), ["address"]);
    rememberColumn("orders.delivery_instructions", true);
  });
  await check("a refused write is reported to the caller, never thrown into the order", async () => {
    seedOrder();
    // A different failure (not a missing column) must come back as ok:false.
    const bad = await saver.saveOrderInstructions({
      orderId: ORDER,
      customerId: UID_A,
      instructions: "x",
      address,
      client: {
        from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { code: "XX000", message: "boom" } }) }) }) }),
      } as never,
    });
    assert.equal(bad.ok, false);
  });

  // ---- the proof ---------------------------------------------------------
  console.log("proof");
  const seedDelivery = (path: string | null) => {
    reset();
    rememberColumn("deliveries.pod_photo_path", true);
    t("orders").push({ id: ORDER, customer_id: UID_A });
    t("deliveries").push({ id: DELIVERY, order_id: ORDER, pod_photo_path: path });
  };

  await check("the order's customer gets a 10-minute signed URL", async () => {
    seedDelivery(`${DELIVERY}/p.jpg`);
    const r = await proof.getCustomerProofUrl(ORDER, UID_A);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.url, /\/storage\/v1\/object\/sign\/delivery-proofs\/dddddddd/);
      assert.equal(r.expiresIn, 600);
    }
    assert.deepEqual(signed, [{ path: `${DELIVERY}/p.jpg`, expiresIn: 600 }]);
  });
  await check("another customer is forbidden, and nothing is signed", async () => {
    seedDelivery(`${DELIVERY}/p.jpg`);
    assert.deepEqual(await proof.getCustomerProofUrl(ORDER, UID_B), { ok: false, error: "forbidden" });
    assert.equal(signed.length, 0);
  });
  await check("an order that does not exist is forbidden too (no existence oracle)", async () => {
    seedDelivery(`${DELIVERY}/p.jpg`);
    assert.deepEqual(
      await proof.getCustomerProofUrl("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", UID_A),
      { ok: false, error: "forbidden" }
    );
  });
  await check("no photo recorded is not_found", async () => {
    seedDelivery(null);
    assert.deepEqual(await proof.getCustomerProofUrl(ORDER, UID_A), { ok: false, error: "no_photo" });
    assert.equal(signed.length, 0);
  });
  await check("no delivery row yet is not_found", async () => {
    seedDelivery(null);
    db.deliveries = [];
    assert.deepEqual(await proof.getCustomerProofUrl(ORDER, UID_A), { ok: false, error: "no_photo" });
  });
  await check("a path outside this delivery's folder is never signed", async () => {
    seedDelivery("someone-else/p.jpg");
    assert.deepEqual(await proof.getCustomerProofUrl(ORDER, UID_A), { ok: false, error: "no_photo" });
    assert.equal(signed.length, 0);
  });
  await check("before 0082 (no pod_photo_path column) there is no photo to show", async () => {
    seedDelivery(`${DELIVERY}/p.jpg`);
    rememberColumn("deliveries.pod_photo_path", true);
    mode.missingColumns.add("deliveries.pod_photo_path");
    assert.deepEqual(await proof.getCustomerProofUrl(ORDER, UID_A), { ok: false, error: "no_photo" });
    rememberColumn("deliveries.pod_photo_path", true);
  });
  await check("a missing bucket answers migration_pending", async () => {
    seedDelivery(`${DELIVERY}/p.jpg`);
    mode.noBucket = true;
    assert.deepEqual(await proof.getCustomerProofUrl(ORDER, UID_A), { ok: false, error: "migration_pending" });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed ? 1 : 0);
}

void main();
