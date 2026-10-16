/**
 * OPS — attach library photos to dishes that have none.
 *
 * Why this exists: a shop whose dishes carry no photo renders as a column of
 * identical coloured squares, because `PhotoTile` falls back to the shop's
 * `accent_tint`. On the search tab — which is dish-first — that reads as if one
 * image had been stamped over the whole menu. At the time of writing 537 of
 * 4,247 dishes were in that state.
 *
 * Read the numbers before trusting this script too far: the catalog's 3,710
 * photographed dishes are drawn from just 48 distinct image URLs, every one of
 * them already shared between shops and one of them used by 41 shops at once.
 * So this closes a gap ("a coloured square") with something only slightly
 * better ("a generic stock photo of roughly the right food"). The real fix is
 * photographs of the actual food in `food_images`, which is empty.
 *
 * It reuses the matcher the vendor menu editor already uses
 * (`lib/images/match.ts`), which is the point: the rule that "paneer" must
 * never receive a chicken photo lives in one place and is not re-implemented
 * here. `bestMatch` refuses anything ambiguous — a bare "Biryani" against a
 * library of six biryanis returns null — so a dish this script skips is a dish
 * a person should pick for, not one to guess at. A visible gap gets fixed; a
 * confidently wrong photo sits there until a customer finds it.
 *
 * Two sources, because the obvious one is currently empty. `--source library`
 * reads `food_images`, the admin photo library, which is what the vendor menu
 * editor matches against. `--source catalog` (the default) treats the catalog
 * itself as the library: 3,710 dishes already carry a photo, the same names
 * recur across shops, and a "Cold Coffee" that one kitchen has photographed is
 * a better answer for another kitchen's "Cold Coffee" than a coloured square.
 * Both go through the same matcher and the same refusal rule.
 *
 * Dry run by default. It writes to live menu data, so `--apply` is deliberate.
 *
 * Usage:
 *   npx tsx scripts/ops/backfill-dish-photos.ts                    # report only
 *   npx tsx scripts/ops/backfill-dish-photos.ts --apply            # write
 *   npx tsx scripts/ops/backfill-dish-photos.ts --source library
 *   npx tsx scripts/ops/backfill-dish-photos.ts --shop "Chatkara"
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bestMatch,
  keywordsFor,
  tokenize,
  type MatchCandidate,
} from "../../src/lib/images/match";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const APPLY = process.argv.includes("--apply");
const SOURCE = (() => {
  const i = process.argv.indexOf("--source");
  const v = i === -1 ? "catalog" : process.argv[i + 1];
  if (v !== "catalog" && v !== "library") {
    console.error('--source must be "catalog" or "library"');
    process.exit(1);
  }
  return v;
})();
const shopFilter = (() => {
  const i = process.argv.indexOf("--shop");
  return i === -1 ? null : process.argv[i + 1]?.toLowerCase() ?? null;
})();

/**
 * Read the local env rather than requiring it to be exported. These scripts are
 * run by hand against a real project; asking an operator to source a file
 * before every invocation is how the wrong database eventually gets written to.
 */
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

/** PostgREST caps a response at 1000 rows; page rather than silently truncate. */
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

interface LibraryRow extends MatchCandidate {
  id: string;
  title: string;
  imageUrl: string;
  keywords: string[];
  veg: boolean | null;
}

async function main() {
  const shops = await all<{ id: string; name: string }>("restaurants", "id, name");
  const shopName = new Map(shops.map((s) => [s.id, s.name]));

  const items = await all<{
    id: string;
    restaurant_id: string;
    name: string;
    image_url: string | null;
    veg: boolean | null;
  }>("menu_items", "id, restaurant_id, name, image_url, veg");

  let library: LibraryRow[];
  if (SOURCE === "library") {
    library = (
      await all<{
        id: string;
        title: string;
        image_url: string;
        keywords: string[] | null;
        veg: boolean | null;
      }>("food_images", "id, title, image_url, keywords, veg")
    ).map<LibraryRow>((r) => ({
      id: r.id,
      title: r.title,
      imageUrl: r.image_url,
      keywords: r.keywords ?? [],
      veg: r.veg,
    }));
    if (library.length === 0) {
      console.log("`food_images` is empty — there is nothing to match against.");
      console.log("Upload photos at /admin/food-images, or use --source catalog.");
      return;
    }
  } else {
    /*
     * The catalog as its own library.
     *
     * One entry per distinct dish name that somebody has already photographed,
     * keyed on the name so "Cold Coffee" appears once however many kitchens
     * sell it. `keywordsFor` is the same function the real library uses to
     * build its keyword column, so the two sources are indexed identically and
     * the matcher cannot tell them apart.
     */
    const seen = new Map<string, LibraryRow>();
    for (const i of items) {
      if (!i.image_url) continue;
      const key = i.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, {
        id: key,
        title: i.name.trim(),
        imageUrl: i.image_url,
        keywords: keywordsFor(i.name),
        veg: i.veg,
      });
    }
    library = [...seen.values()];
  }

  const blanks = items.filter((i) => {
    if (i.image_url) return false;
    if (!shopFilter) return true;
    return (shopName.get(i.restaurant_id) ?? "").toLowerCase().includes(shopFilter);
  });

  console.log(`source             : ${SOURCE}`);
  console.log(`photos to draw from: ${library.length}`);
  console.log(`menu items         : ${items.length}`);
  const filterNote = shopFilter ? ` (filtered to "${shopFilter}")` : "";
  console.log(`without a photo    : ${blanks.length}${filterNote}`);
  console.log(APPLY ? "\nMODE: APPLY — writing\n" : "\nMODE: dry run — nothing will be written\n");

  const matched: { id: string; shop: string; dish: string; photo: string; why: string }[] = [];
  const skipped: { shop: string; dish: string; why: string }[] = [];

  for (const item of blanks) {
    const shop = shopName.get(item.restaurant_id) ?? item.restaurant_id;
    if (tokenize(item.name).length === 0) {
      skipped.push({ shop, dish: item.name, why: "no matchable words in the name" });
      continue;
    }
    // Narrow the same way `candidatesFor` does in the app — by keyword overlap
    // — then let the shared ranker decide. Done in memory here because the
    // whole library is already loaded and this is one pass, not a request.
    const tokens = new Set(tokenize(item.name));
    const candidates = library.filter((l) => l.keywords.some((k) => tokens.has(k)));
    if (candidates.length === 0) {
      skipped.push({ shop, dish: item.name, why: "nothing in the library shares a word" });
      continue;
    }
    const hit = bestMatch(item.name, candidates);
    if (!hit) {
      skipped.push({ shop, dish: item.name, why: "ambiguous — a person should choose" });
      continue;
    }
    matched.push({
      id: item.id,
      shop,
      dish: item.name,
      photo: hit.candidate.title,
      why: hit.reason,
    });
  }

  console.log(`── would attach a photo to ${matched.length} ──`);
  for (const m of matched) {
    console.log(`  ${m.shop} · ${m.dish}`);
    console.log(`      → ${m.photo}   (${m.why})`);
  }

  console.log(`\n── left alone: ${skipped.length} ──`);
  const byReason = new Map<string, number>();
  for (const s of skipped) byReason.set(s.why, (byReason.get(s.why) ?? 0) + 1);
  for (const [why, n] of byReason) console.log(`  ${n.toString().padStart(4)}  ${why}`);
  for (const s of skipped.slice(0, 20)) console.log(`      ${s.shop} · ${s.dish} — ${s.why}`);
  if (skipped.length > 20) console.log(`      …and ${skipped.length - 20} more`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write these.");
    return;
  }

  let written = 0;
  const undo: string[] = [];
  for (const m of matched) {
    const photo = library.find((l) => l.title === m.photo);
    if (!photo) continue;
    // One row at a time and scoped by id: a bulk upsert here would need the
    // full row, and re-sending columns this script has no business touching is
    // how a backfill quietly resets a price.
    const { data, error } = await db
      .from("menu_items")
      .update({ image_url: photo.imageUrl })
      .eq("id", m.id)
      .is("image_url", null) // still blank — never overwrite a real photo
      .select("id");
    if (error) {
      console.error(`  ✗ ${m.shop} · ${m.dish}: ${error.message}`);
      continue;
    }
    if (!data || data.length === 0) continue; // somebody set one meanwhile
    written++;
    undo.push(m.id);
  }
  console.log(`\nWrote ${written} of ${matched.length}.`);

  /*
   * An undo file, written after the fact rather than before.
   *
   * Every row touched here had `image_url` null — the update says so in its own
   * WHERE clause — so reverting is setting those same ids back to null. Listing
   * only the ids that actually came back written means a partial run reverts to
   * exactly what it did, not to what it intended to do.
   */
  if (undo.length) {
    const path = join(root, `scripts/ops/undo-dish-photos-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ setToNull: undo }, null, 2));
    console.log(`Undo list: ${path}`);
    console.log("  Revert with: update menu_items set image_url = null where id in (…)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
