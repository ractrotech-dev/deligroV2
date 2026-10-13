/**
 * QA — the slimmed catalog Search ships to the browser.
 *
 * `slimCatalogForSearch` drops menu-item keys that hold their default
 * (`false`, `null`, `0`). That is only a safe saving if nothing downstream can
 * tell, so this suite builds a catalog full of defaults and non-defaults, runs
 * the real ranking over the original and the slim copy, and demands identical
 * results — then checks the bytes actually went down.
 *
 * Runs offline. Usage: npm run test:search-payload
 */
import { buildDishIndex, searchDishes } from "../../src/lib/search/dishes";
import { slimCatalogForSearch, slimMenuItem } from "../../src/lib/search/slim-catalog";
import { effectivePrice } from "../../src/lib/utils/cart";
import type { MenuItem, Restaurant } from "../../src/types";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

function dish(over: Partial<MenuItem>): MenuItem {
  return {
    id: "d",
    name: "Paneer Butter Masala",
    description: "Creamy tomato gravy",
    price: 200,
    discountPrice: null,
    category: "Curries",
    veg: true,
    image: "https://images.example/p.jpg",
    soldOut: false,
    popular: false,
    bestseller: false,
    unitsSold: 0,
    ...over,
  };
}

function shop(slug: string, menu: MenuItem[], over: Partial<Restaurant> = {}): Restaurant {
  return {
    slug,
    name: slug,
    tagline: "",
    cuisines: ["North Indian"],
    rating: 4.3,
    ratingCount: 80,
    etaMin: 25,
    etaMax: 35,
    priceTier: 2,
    costForTwo: 300,
    distanceKm: null,
    open: true,
    categories: [],
    menu,
    accentTint: "",
    image: "",
    ...over,
  };
}

const catalog: Restaurant[] = [
  shop("alpha", [
    dish({ id: "a1" }),
    dish({ id: "a2", name: "Paneer Tikka", discountPrice: 150, popular: true, unitsSold: 40 }),
    dish({ id: "a3", name: "Paneer Roll", soldOut: true }),
    dish({ id: "a4", name: "Chicken Biryani", veg: false, bestseller: true, unitsSold: 12 }),
    dish({ id: "a5", name: "Plain Rice", image: undefined, category: "Rice" }),
  ]),
  shop("beta", [dish({ id: "b1", discountPrice: 180 }), dish({ id: "b2", name: "Cold Coffee", category: "Drinks" })], {
    open: false,
    rating: 4.8,
  }),
];

const slim = slimCatalogForSearch(catalog);

console.log("\n═══ slimMenuItem ═══");
const bare = slimMenuItem(dish({}));
for (const k of ["discountPrice", "soldOut", "popular", "bestseller", "unitsSold"]) {
  check(`a default ${k} is left out`, k in bare, false);
}
const loaded = slimMenuItem(
  dish({ discountPrice: 150, soldOut: true, popular: true, bestseller: true, unitsSold: 9 })
);
check("a real discountPrice is kept", loaded.discountPrice, 150);
check("soldOut: true is kept", loaded.soldOut, true);
check("popular: true is kept", loaded.popular, true);
check("bestseller: true is kept", loaded.bestseller, true);
check("a non-zero unitsSold is kept", loaded.unitsSold, 9);
check("an absent image stays absent", "image" in slimMenuItem(dish({ image: undefined })), false);
check("required fields survive", `${bare.id}|${bare.name}|${bare.price}|${bare.veg}`, "d|Paneer Butter Masala|200|true");
check("the input is not mutated", "soldOut" in catalog[0].menu[0], true);
check("restaurant fields other than the menu are untouched", slim[1].open === false && slim[1].rating === 4.8, true);

console.log("\n═══ ranking is identical on the slim catalog ═══");
const a = buildDishIndex(catalog);
const b = buildDishIndex(slim);
const shape = (hits: ReturnType<typeof searchDishes>) =>
  JSON.stringify(hits.map((h) => [h.key, Math.round(h.score * 1000) / 1000, h.partial ?? false]));

for (const q of ["paneer", "biryani", "coffee", "rice", "tikka", "zzz", ""]) {
  check(`"${q || "(empty)"}" relevance order`, shape(searchDishes(b, q)), shape(searchDishes(a, q)));
}
for (const filters of [{ veg: true }, { popular: true }, { maxPrice: 160 }, { category: "biryani" }]) {
  check(
    `filters ${JSON.stringify(filters)}`,
    shape(searchDishes(b, "", filters)),
    shape(searchDishes(a, "", filters))
  );
}
check("price sort", shape(searchDishes(b, "paneer", {}, "price")), shape(searchDishes(a, "paneer", {}, "price")));

console.log("\n═══ what the customer is charged is identical ═══");
for (let i = 0; i < catalog.length; i++) {
  for (let j = 0; j < catalog[i].menu.length; j++) {
    const o = catalog[i].menu[j];
    const s = slim[i].menu[j];
    check(
      `${catalog[i].slug}/${o.id} effective price`,
      effectivePrice(s.price, s.discountPrice),
      effectivePrice(o.price, o.discountPrice)
    );
    check(`${catalog[i].slug}/${o.id} unavailable flag`, Boolean(s.soldOut), Boolean(o.soldOut));
  }
}

console.log("\n═══ the bytes went down ═══");
const big = (n: number): Restaurant[] => [shop("big", Array.from({ length: n }, (_, i) => dish({ id: `x${i}` })))];
const before = JSON.stringify(big(500)).length;
const after = JSON.stringify(slimCatalogForSearch(big(500))).length;
check("an all-default menu is at least 20% smaller", after < before * 0.8, true);
console.log(`    (500 default dishes: ${before} → ${after} bytes, ${Math.round((1 - after / before) * 100)}% smaller)`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
