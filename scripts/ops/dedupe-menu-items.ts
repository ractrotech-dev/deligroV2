/**
 * OPS — remove duplicate menu rows within a shop.
 *
 * The symptom is visible on the customer search tab: "Hot Coffee ₹40" listed
 * twice in a row from the same kitchen. At the time of writing there were 88
 * duplicated names across the catalog and 110 redundant rows.
 *
 * Deleting live menu rows is not reversible from here, so the rules below are
 * deliberately narrow. A group is only touched when every question about it has
 * an unambiguous answer, and anything else is reported for a person rather than
 * guessed at.
 *
 *   1. Same price, or hands off. Two rows named "Chicken Roast" at ₹180 and
 *      ₹260 are a half and a full plate that somebody forgot to label, not a
 *      mistake — merging them would delete a real menu item and a real price.
 *   2. Nothing that a customer has ordered. `order_items.menu_item_id` is
 *      `on delete set null` (0001), so deleting a referenced row silently cuts
 *      past orders loose from the dish they were for — which is the record the
 *      vendor's earnings and the customer's receipt both read. The keeper is
 *      chosen as the referenced row where there is one; if TWO rows in a group
 *      both carry order history, the group is skipped entirely, because either
 *      deletion loses something.
 *   3. Otherwise keep the one a vendor is most likely to be maintaining:
 *      available over unavailable, then photographed over not, then oldest.
 *
 * Dry run by default.
 *
 * Usage:
 *   npx tsx scripts/ops/dedupe-menu-items.ts           # report only
 *   npx tsx scripts/ops/dedupe-menu-items.ts --apply   # delete
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPLY = process.argv.includes("--apply");

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const e = env();
const URL_ = e.NEXT_PUBLIC_SUPABASE_URL ?? e.SUPABASE_URL;
const KEY = e.SUPABASE_SECRET_KEY ?? e.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("Missing SUPABASE url/secret key in .env.local");
  process.exit(1);
}
const db = createClient(URL_, KEY, { auth: { persistSession: false } });

async function all<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(columns).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

interface Item {
  id: string;
  restaurant_id: string;
  name: string;
  price: number;
  available: boolean;
  image_url: string | null;
  created_at: string;
}

async function main() {
  const shops = await all<{ id: string; name: string }>("restaurants", "id, name");
  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  const items = await all<Item>(
    "menu_items",
    "id, restaurant_id, name, price, available, image_url, created_at"
  );
  const orderLines = await all<{ menu_item_id: string | null }>(
    "order_items",
    "menu_item_id"
  );

  /** How many order lines point at each menu row — rule 2's input. */
  const refs = new Map<string, number>();
  for (const l of orderLines) {
    if (l.menu_item_id) refs.set(l.menu_item_id, (refs.get(l.menu_item_id) ?? 0) + 1);
  }

  const groups = new Map<string, Item[]>();
  for (const i of items) {
    const key = `${i.restaurant_id}::${i.name.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }

  const doomed: { id: string; shop: string; name: string; price: number }[] = [];
  const held: { shop: string; name: string; why: string; detail: string }[] = [];

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const shop = shopName.get(rows[0].restaurant_id) ?? rows[0].restaurant_id;
    const name = rows[0].name.trim();

    const prices = new Set(rows.map((r) => r.price));
    if (prices.size > 1) {
      held.push({
        shop,
        name,
        why: "prices differ — probably a real variant",
        detail: [...prices].map((p) => `₹${p}`).join(" / "),
      });
      continue;
    }

    const ordered = rows.filter((r) => (refs.get(r.id) ?? 0) > 0);
    if (ordered.length > 1) {
      held.push({
        shop,
        name,
        why: "two rows both have order history",
        detail: ordered.map((r) => `${r.id.slice(0, 8)}×${refs.get(r.id)}`).join(", "),
      });
      continue;
    }

    // Rule 3, in order. `ordered[0]` wins outright when it exists: it is the
    // row the ledger already points at.
    const keeper =
      ordered[0] ??
      [...rows].sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        const ai = a.image_url ? 0 : 1;
        const bi = b.image_url ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return a.created_at.localeCompare(b.created_at);
      })[0];

    for (const r of rows) {
      if (r.id === keeper.id) continue;
      doomed.push({ id: r.id, shop, name, price: r.price });
    }
  }

  console.log(`menu items            : ${items.length}`);
  console.log(`duplicated names      : ${[...groups.values()].filter((r) => r.length > 1).length}`);
  console.log(`safe to delete        : ${doomed.length}`);
  console.log(`held back for a person: ${held.length}`);
  console.log(APPLY ? "\nMODE: APPLY — deleting\n" : "\nMODE: dry run — nothing will be deleted\n");

  if (held.length) {
    console.log("── held back ──");
    for (const h of held) {
      console.log(`  ${h.shop} · ${h.name}`);
      console.log(`      ${h.why}: ${h.detail}`);
    }
    console.log("");
  }

  console.log("── would delete ──");
  const byShop = new Map<string, number>();
  for (const d of doomed) byShop.set(d.shop, (byShop.get(d.shop) ?? 0) + 1);
  for (const [shop, n] of [...byShop.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${shop}`);
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to delete these.");
    return;
  }

  // Written BEFORE the delete, unlike the photo backfill's undo list: once these
  // rows are gone the only record of what they held is this file.
  const backupPath = join(root, `scripts/ops/deleted-menu-items-${Date.now()}.json`);
  const backup = items.filter((i) => doomed.some((d) => d.id === i.id));
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nFull rows saved to ${backupPath}`);

  let gone = 0;
  for (const d of doomed) {
    const { error } = await db.from("menu_items").delete().eq("id", d.id);
    if (error) {
      console.error(`  ✗ ${d.shop} · ${d.name}: ${error.message}`);
      continue;
    }
    gone++;
  }
  console.log(`Deleted ${gone} of ${doomed.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
