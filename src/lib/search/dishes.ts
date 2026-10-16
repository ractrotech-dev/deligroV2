/**
 * Dish-first search.
 *
 * The catalog is modelled as restaurants that own menus, but a hungry person
 * searches for *food* — "paneer tikka", "cold coffee", "biryani" — and wants the
 * dish, with the shop as an attribute of it. Everything here turns the
 * restaurant-shaped catalog into a flat, rankable list of dishes.
 *
 * Deliberately pure and framework-free (no "server-only"): the customer app
 * already loads the whole approved catalog with menus for the feed, so search
 * runs over that same array on the client and stays instant while typing. If the
 * catalog outgrows that, the seam to move is `buildDishIndex` — swap it for a
 * server query and the ranking below is unchanged.
 */

import {
  buildVocabulary,
  expandQuery,
  looselyContains,
  type ExpandedToken,
} from "@/lib/search/semantic";
import { distanceToShop } from "@/lib/geo/distance";
import type { Coords } from "@/stores/location-store";
import type { MenuItem, Restaurant } from "@/types";

/** A dish kept with the kitchen that cooks it — the unit a food search returns. */
export interface IndexedDish {
  /**
   * Globally unique. `MenuItem.id` is only unique *within one menu* (it is the
   * vendor's external id when they set one), so two shops can both call a dish
   * "veg-1" — this is what React keys and cart lookups must use.
   */
  key: string;
  item: MenuItem;
  restaurant: Restaurant;
  // Pre-lowercased haystacks. Built once per catalog, reused on every keystroke.
  name: string;
  category: string;
  description: string;
  cuisines: string;
  shop: string;
}

export interface DishHit extends IndexedDish {
  score: number;
  /**
   * True when the dish only answers *some* of the words typed. Only ever set
   * when nothing matched all of them — the UI says so rather than passing a
   * near-miss off as the thing that was asked for.
   */
  partial?: boolean;
}

/** A restaurant plus the dishes of its that answered the query. */
export interface ShopHit {
  restaurant: Restaurant;
  score: number;
  /** Best-matching dishes first. Empty when the shop matched by name alone. */
  dishes: DishHit[];
}

export type DishSort = "relevance" | "price" | "eta" | "rating";

export interface SearchFilters {
  /** Dish-level: the dish itself is vegetarian. */
  veg?: boolean;
  /** Dish-level: flagged popular / ranked a bestseller. */
  popular?: boolean;
  /** Dish-level: price at or under this many rupees. */
  maxPrice?: number | null;
  /** Shop-level. */
  fast?: boolean;
  rating?: boolean;
  offers?: boolean;
  /** Food category id from FOOD_CATEGORIES. */
  category?: string | null;
}

/**
 * What ranking knows that the catalog alone doesn't.
 *
 * Both fields are optional and both degrade to "this term contributes nothing"
 * rather than to a guess — a caller with no location still gets a sensible
 * ranking, it just isn't distance-aware. Kept as an explicit argument rather
 * than read from the location store so this module stays pure and testable:
 * the same index and the same context always produce the same order.
 */
export interface RankContext {
  /**
   * Where the customer is. `useLocation().coords ?? PINNED_LOCATION.coords` at
   * every call site — the same origin the header names and `ShopDistance`
   * measures from, so a card that says "1.2 km" is a card ranked as 1.2 km.
   */
  origin?: Coords | null;
  /**
   * Rotates the winner among near-equal vendors — see `rotationJitter`. Stable
   * per viewer per day (e.g. `${userId ?? deviceId}:${dayOfYear}`); omit it and
   * ranking is fully deterministic with no rotation at all.
   */
  rotationSeed?: string | null;
}

/* ------------------------------------------------------------------ *
 * Vendor quality — the terms that don't depend on what was typed
 * ------------------------------------------------------------------ */

/**
 * Bayesian rating: a shop's stars, pulled toward the platform mean by how few
 * people have actually rated it.
 *
 * The raw `rating` field cannot be compared across shops. Seeded vendors carry
 * `rating 5, rating_count 0` — a perfect score nobody gave them — and under a
 * plain `rating * 2` term those outranked every genuinely well-reviewed kitchen
 * in the city. This is the standard fix: treat the prior as `C` imaginary
 * ratings of `m` stars, so evidence has to accumulate before a score moves.
 *
 *   5.0 from 0 ratings   → 4.00   (no evidence, no credit)
 *   4.6 from 200 ratings → 4.55   (plenty of evidence, barely moved)
 */
const RATING_PRIOR_COUNT = 20;
const RATING_PRIOR_MEAN = 4.0;

export function bayesRating(rating: number, ratingCount: number): number {
  const count = Math.max(0, ratingCount);
  return (
    (RATING_PRIOR_COUNT * RATING_PRIOR_MEAN + rating * count) /
    (RATING_PRIOR_COUNT + count)
  );
}

/**
 * Distance in km from the customer to this dish's kitchen, or null when either
 * end is unknown.
 *
 * Null is deliberately neither a penalty nor a bonus at every call site below:
 * a vendor who hasn't pinned their shop yet must not be buried (they'd never
 * get an order, so they'd never pin it), and must not be promoted either.
 */
function distanceOf(d: IndexedDish, ctx: RankContext): number | null {
  if (!ctx.origin) return null;
  return distanceToShop(ctx.origin, d.restaurant);
}

/**
 * FNV-1a. Small, fast, and — the only property that matters here —
 * deterministic: the same seed and slug always produce the same jitter, so a
 * re-render or a re-sort never reshuffles the list under the customer's thumb.
 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * How far a vendor can be moved by luck alone.
 *
 * Ranking with no exploration is a ratchet: the vendor who wins today takes the
 * orders, the orders raise `unitsSold`, and tomorrow they win by more. A new
 * kitchen never surfaces, so it never sells, so it never surfaces. This lets
 * genuinely comparable vendors trade places day to day.
 *
 * 2 points is chosen to be smaller than the things a customer would notice
 * being wrong: it is about 250 m of proximity, or an 8% price gap. A vendor who
 * is meaningfully nearer or cheaper still wins every day.
 */
const ROTATION_BAND = 2;

function rotationJitter(slug: string, ctx: RankContext): number {
  if (!ctx.rotationSeed) return 0;
  return (hashString(`${ctx.rotationSeed}:${slug}`) / 0xffffffff) * ROTATION_BAND;
}

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

export function buildDishIndex(restaurants: Restaurant[]): IndexedDish[] {
  const index: IndexedDish[] = [];
  for (const restaurant of restaurants) {
    const shop = restaurant.name.toLowerCase();
    const cuisines = restaurant.cuisines.join(" ").toLowerCase();
    for (const item of restaurant.menu) {
      index.push({
        key: `${restaurant.slug}:${item.id}`,
        item,
        restaurant,
        name: item.name.toLowerCase(),
        category: item.category.toLowerCase(),
        description: item.description.toLowerCase(),
        cuisines,
        shop,
      });
    }
  }
  return index;
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** Letters and digits in any script — Devanagari dish names tokenize too. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Does `token` start a word inside `hay`? "tikka" matches "paneer tikka". */
function startsWord(hay: string, token: string): boolean {
  let i = hay.indexOf(token);
  while (i !== -1) {
    if (i === 0 || !WORD_CHAR.test(hay[i - 1])) return true;
    i = hay.indexOf(token, i + 1);
  }
  return false;
}

/**
 * Shortest token allowed to match in the MIDDLE of a word.
 *
 * Every field below used to fall back to a bare `includes`, which matches
 * anywhere — so "egg" matched "V-egg-ie Combo" and scored 55, and a search for
 * EGG BIRYANI answered with a Veggie Combo. It is not a rare shape: "tea" is
 * inside "steamed", "roll" inside "trolley", "dal" inside "sandalwood", "rice"
 * inside "priced".
 *
 * Short tokens are where the collisions live, and short tokens are also exactly
 * the words this market's menus are made of — egg, dal, roti, tea, rice. So the
 * fallback is kept (a menu that writes "Dumbiryani" as one word should still be
 * findable) but gated on length, where an accidental infix is vanishingly rare.
 *
 * Word-START matching is unaffected and needs no gate: `startsWord` already
 * accepts any non-letter boundary, so "aloo" finds "Aloo-Paratha" and "biry"
 * finds "Chicken Biryani".
 */
const MIN_INFIX_LEN = 5;

function infix(hay: string, token: string): boolean {
  return token.length >= MIN_INFIX_LEN && hay.includes(token);
}

/**
 * How well one dish answers one word, highest-signal field first. Zero means
 * this word is nowhere in the dish, which disqualifies the dish entirely —
 * tokens are ANDed, so "paneer roll" will not surface every roll on the menu.
 */
function scoreLiteral(d: IndexedDish, token: string): number {
  if (d.name === token) return 140;
  if (d.name.startsWith(token)) return 100;
  if (startsWord(d.name, token)) return 80;
  if (infix(d.name, token)) return 55;
  if (startsWord(d.category, token)) return 36;
  if (infix(d.category, token)) return 28;
  if (startsWord(d.cuisines, token)) return 24;
  if (startsWord(d.shop, token)) return 20;
  if (infix(d.shop, token)) return 15;
  if (startsWord(d.description, token)) return 12;
  if (infix(d.description, token)) return 6;
  return 0;
}

/**
 * Confidence multipliers for the non-literal tiers.
 *
 * An alias is a curated fact — the lexicon says "aloo" IS potato — so it keeps
 * most of its score; it should lose to a dish that says "potato" outright, and
 * beat one that merely mentions it in a description. A fuzzy hit is a guess
 * about a typo and ranks below both. An intent word ("spicy") is the weakest
 * signal of the three: it describes a quality rather than naming the food, so
 * it colours the ordering without ever outranking a real name match.
 */
const ALIAS_WEIGHT = 0.75;
/** Same pronunciation, different spelling — see `ExpandedToken.homophones`. */
const HOMOPHONE_WEIGHT = 0.6;
const FUZZY_WEIGHT = 0.5;
/**
 * Sounds-like ("panir" → paneer, "safran" → Saffron Kitchen). Below an
 * edit-distance guess because it is a looser one, above an intent word because
 * it is still an attempt to NAME the thing. Only ever reached for a word that
 * matched nothing else anywhere in the catalog — see `gatePhonetic`.
 */
const PHONETIC_WEIGHT = 0.4;
const INTENT_WEIGHT = 0.3;

/**
 * The best any surface form of this token can do against this dish.
 *
 * Tried strongest-first and short-circuited: a literal hit never needs the
 * lexicon, and a dish that already matched by alias is not also fuzzy-scanned.
 */
function scoreToken(d: IndexedDish, t: ExpandedToken): number {
  const literal = t.intentOnly ? 0 : scoreLiteral(d, t.token);
  if (literal) return literal;

  let best = 0;
  for (const alias of t.aliases) {
    const s = scoreLiteral(d, alias);
    if (s > best) best = s;
  }
  if (best) return best * ALIAS_WEIGHT;

  for (const variant of t.homophones) {
    const s = scoreLiteral(d, variant);
    if (s > best) best = s;
  }
  if (best) return best * HOMOPHONE_WEIGHT;

  for (const variant of t.fuzzy) {
    const s = scoreLiteral(d, variant);
    if (s > best) best = s;
  }
  if (best) return best * FUZZY_WEIGHT;

  for (const variant of t.phonetic) {
    const s = scoreLiteral(d, variant);
    if (s > best) best = s;
  }
  if (best) return best * PHONETIC_WEIGHT;

  for (const word of t.intent) {
    const s = scoreLiteral(d, word);
    if (s > best) best = s;
  }
  return best * INTENT_WEIGHT;
}

/**
 * The part of the score that has nothing to do with the words typed: what sells,
 * what's rated well, what's actually near you, and what arrives soon. Also what
 * pushes a sold-out dish or a shut kitchen below everything orderable without
 * hiding it — "they have it, just not now" is a useful answer.
 *
 * Distance is the term this used to be missing entirely. The function was pure
 * and location-free, so a dish two towns over ranked exactly as well as the
 * same dish from the shop at the end of the street; `distanceToShop` existed
 * and only the *restaurant* list on Home ever used it. For a delivery app that
 * serves one town, proximity is not a tiebreak, it is most of the answer.
 *
 * Weighted below the query terms on purpose (a token match is worth up to 140):
 * being near is what settles a tie between two dishes that both answer the
 * question, not a reason to show someone the wrong food.
 */
const PROXIMITY_WEIGHT = 2.5; // points per km, flat ranking

function baseScore(d: IndexedDish, ctx: RankContext = {}): number {
  let s = 0;
  if (d.item.popular || d.item.bestseller) s += 14;
  s += Math.min(d.item.unitsSold ?? 0, 100) * 0.15;
  s += bayesRating(d.restaurant.rating, d.restaurant.ratingCount) * 2;
  s -= Math.min(d.restaurant.etaMin, 60) * 0.15;

  // Capped at 10 km so one far-flung outlier can't dominate the whole score;
  // beyond that the shop is out of the delivery area anyway.
  const km = distanceOf(d, ctx);
  if (km !== null) s -= Math.min(km, 10) * PROXIMITY_WEIGHT;

  if (d.item.soldOut) s -= 60;
  if (!d.restaurant.open) s -= 45;
  return s;
}

/* ------------------------------------------------------------------ *
 * Food categories — what the chips and the home strip mean
 * ------------------------------------------------------------------ */

/**
 * A category of *food*, not of shop.
 *
 * The old search mapped "Pizza" onto the Italian cuisine tag, so it answered
 * "which restaurants are Italian?" rather than "who has pizza?". `keywords`
 * match the dish; `cuisines` are only a fallback for menus whose dish names give
 * nothing away (a legacy import of "Item 14"), so the chip is never a dead end.
 */
export interface FoodCategory {
  id: string;
  label: string;
  keywords: string[];
  cuisines: string[];
}

/**
 * The food taxonomy. `lib/taxonomy.ts` picks which of these the Home strip
 * features and supplies each one's picture; ids are the `?category=` values, so
 * changing one breaks a link somebody may have saved.
 *
 * Written for a Tier-3 Indian market (Deligro delivers in Bemetara, Chhattisgarh
 * — see `lib/location/pinned.ts`), which is why the list leans thali, momos,
 * chaat, paratha and mithai rather than the metro shorthand of salads and
 * bowls. `keywords` carry the Hindi/regional names a local menu actually uses —
 * a shop that lists "Anda Bhurji" and "Chana Samosa" must be findable under Egg
 * and Snacks without anyone renaming their menu to suit us.
 */
export const FOOD_CATEGORIES: FoodCategory[] = [
  {
    // The single biggest T3 lunch order, and the one the old list had no chip
    // for at all — a ₹70 veg thali is what most of this market eats on a
    // weekday, and it was reachable only by typing.
    id: "thali",
    label: "Thali",
    // "combo" was here and had to go. It matched the *vendor's own* category
    // string "Combo Offer", so the Thali chip returned 11 dishes of which 5 were
    // "Double Paneer Pizza+Aloo Patty Burger", "Paneer Pizza+Salted Fries",
    // "Tandoori Pizza+Coke" and friends. A pizza-and-a-drink deal is a combo;
    // it is not a thali, and someone tapping Thali wants a plate of food.
    //
    // The rest are kept because they are what a T3 menu actually calls a thali:
    // "Veg Meal", "Rice Plate", "Unlimited Thali". "bhojan" and "meals" are the
    // regional spellings — "Meals" is what a South Indian board says for thali.
    keywords: [
      "thali",
      "meal",
      "meals",
      "full meal",
      "veg thali",
      "special thali",
      "unlimited",
      "plate",
      "bhojan",
    ],
    cuisines: ["North Indian", "South Indian", "Chhattisgarhi"],
  },
  {
    id: "biryani",
    label: "Biryani",
    keywords: ["biryani", "biriyani", "dum", "pulao", "pulav"],
    cuisines: ["Biryani", "North Indian"],
  },
  {
    // Its own chip rather than a corner of Chinese. Momos are the street-food
    // staple of small-town north and central India, and someone hunting momos
    // is not browsing for noodles.
    id: "momos",
    label: "Momos",
    keywords: [
      "momo",
      "momos",
      "dumpling",
      "dimsum",
      "dim sum",
      "steam momo",
      "fried momo",
      "tandoori momo",
      "pan fried",
    ],
    cuisines: ["Chinese", "Tibetan", "Street Food"],
  },
  {
    // Chaat, samosa and the fried-snack counter — the T3 evening order. `bara`
    // and `chila` are Chhattisgarhi and are in here deliberately: local menus
    // list them by those names and nothing else would match.
    id: "snacks",
    label: "Samosa & Chaat",
    keywords: [
      "samosa",
      "kachori",
      "chaat",
      "chat",
      "pakoda",
      "pakora",
      "bhajiya",
      "tikki",
      "aloo tikki",
      "golgappa",
      "panipuri",
      "pani puri",
      "puchka",
      "bhel",
      "sev puri",
      "dahi puri",
      "vada pav",
      "bara",
      "chila",
      "cheela",
      "fara",
      "namkeen",
    ],
    cuisines: ["Street Food", "Chaat", "Snacks", "Chhattisgarhi"],
  },
  {
    id: "pizza",
    label: "Pizza",
    keywords: ["pizza", "margherita", "calzone", "garlic bread"],
    cuisines: ["Italian"],
  },
  {
    id: "burgers",
    label: "Burgers",
    keywords: ["burger", "fries", "sandwich", "nuggets"],
    cuisines: ["Fast Food"],
  },
  {
    id: "rolls",
    label: "Rolls",
    keywords: ["roll", "kathi", "frankie", "wrap", "shawarma"],
    cuisines: ["Fast Food"],
  },
  {
    id: "chinese",
    label: "Chinese",
    keywords: [
      "noodle",
      "noodles",
      "hakka",
      "manchurian",
      "momo",
      "fried rice",
      "schezwan",
      "chowmein",
      "spring roll",
    ],
    cuisines: ["Chinese"],
  },
  {
    id: "south",
    label: "South Indian",
    keywords: ["dosa", "idli", "vada", "uttapam", "sambar", "upma", "appam"],
    cuisines: ["South Indian"],
  },
  {
    // Breads and the tiffin counter. Chole bhature and aloo paratha are a T3
    // breakfast and a T3 dinner respectively, and neither had a chip.
    id: "paratha",
    label: "Paratha & Roti",
    keywords: [
      "paratha",
      "parantha",
      "roti",
      "naan",
      "kulcha",
      "chapati",
      "bhatura",
      "bhature",
      "chole bhature",
      "tandoori roti",
      "rumali",
      "puri",
      "poori",
      "litti",
    ],
    cuisines: ["North Indian"],
  },
  {
    id: "chicken",
    label: "Chicken & Tandoori",
    keywords: [
      "chicken",
      "murg",
      "tandoori",
      "tikka",
      "kebab",
      "kabab",
      "seekh",
      "butter chicken",
      "chilli chicken",
      "leg piece",
      "mutton",
      "keema",
    ],
    cuisines: ["North Indian", "Mughlai"],
  },
  {
    // Anda bhurji, half-fry, egg roll — a whole category of cheap protein this
    // market runs on, previously findable only by typing "anda".
    id: "egg",
    label: "Egg",
    keywords: [
      "egg",
      "anda",
      "bhurji",
      "omelette",
      "omelet",
      "half fry",
      "boiled egg",
      "egg curry",
      "egg roll",
      "double egg",
    ],
    cuisines: [],
  },
  {
    // Kept on the search page but no longer featured on Home: salad-and-bowl
    // demand is a metro pattern, and the front page is finite. Existing
    // /search?category=healthy links keep working.
    id: "healthy",
    label: "Healthy",
    keywords: ["salad", "bowl", "smoothie", "grill", "soup", "sprout", "quinoa"],
    cuisines: ["Healthy"],
  },
  {
    // Relabelled from "Desserts" to "Sweets" and broadened to mithai. The id is
    // deliberately unchanged so saved /search?category=desserts links still
    // work; what moved is the word customers read and the words we match.
    // Ice cream has split off below — in India a mithai shop and an ice cream
    // parlour are different errands.
    id: "desserts",
    label: "Sweets",
    keywords: [
      // "sweet" (singular) was here and matched the ADJECTIVE, not the dish:
      // "Sweet Corn Soup", "Sweet Corn Pizza", "Sweet Corn Dosa", and "Sweet
      // Saloni" — which is a namkeen, i.e. savoury. Not one real dessert in the
      // catalog is found by it. "sweets" and "dessert" between them still match
      // every vendor category that exists here ("Sweets", "Sweets & Deserts",
      // "Sweet & Dessert") without dragging in the corn.
      "sweets",
      "dessert",
      "mithai",
      "gulab",
      "jamun",
      "rasgulla",
      "rasmalai",
      "jalebi",
      "imarti",
      "laddu",
      "ladoo",
      "barfi",
      "burfi",
      "peda",
      "rabri",
      "halwa",
      "kaju katli",
      "sondesh",
      "balushahi",
      "cake",
      "pastry",
      "brownie",
      "dessert",
    ],
    cuisines: ["Desserts", "Sweets"],
  },
  {
    id: "icecream",
    label: "Ice Cream",
    keywords: [
      "ice cream",
      "icecream",
      "kulfi",
      "falooda",
      "sundae",
      "cone",
      "scoop",
      "gelato",
      "thick shake",
      "thickshake",
    ],
    cuisines: ["Desserts"],
  },
  {
    id: "beverages",
    label: "Drinks",
    keywords: [
      "coffee",
      "tea",
      "chai",
      "lassi",
      "shake",
      "juice",
      "mojito",
      "soda",
      "cola",
      "beverage",
      "drink",
      "chaas",
      "buttermilk",
      "thandai",
      "nimbu",
      "shikanji",
      "sharbat",
      "sugarcane",
      "ganne",
    ],
    cuisines: ["Beverages"],
  },
];

export function findFoodCategory(id: string | null | undefined): FoodCategory | null {
  if (!id) return null;
  return FOOD_CATEGORIES.find((c) => c.id === id) ?? null;
}

/**
 * The dish a combo actually is.
 *
 * Menus here write bundles as "Tandoori Pizza+Coke" and "Double Paneer
 * Pizza+Mint Mojito". Matching category keywords across the whole string files
 * the first under Drinks (via "coke") and the second under Drinks again (via
 * "mojito") — so tapping Drinks returned a pizza. The bundle's headline item is
 * what someone is choosing, so only the first component decides its category.
 *
 * Names without a separator are returned unchanged, which is all but six dishes
 * in the current catalog. Search itself is untouched: typing "coke" still finds
 * the combo, because scoreToken reads the full name. This narrows what a
 * category CHIP claims, not what a query can reach.
 */
function primaryComponent(name: string): string {
  const cut = name.indexOf("+");
  return cut === -1 ? name : name.slice(0, cut).trim();
}

function matchesKeywords(d: IndexedDish, cat: FoodCategory): boolean {
  const name = primaryComponent(d.name);
  return cat.keywords.some(
    (k) => startsWord(name, k) || startsWord(d.category, k)
  );
}

/**
 * Dishes in a category. Keyword-matched against the dish itself; only if the
 * whole catalog yields nothing that way do we fall back to the shop's cuisine
 * tags, so the chip degrades to the old restaurant-level behaviour instead of
 * showing an empty screen.
 */
function filterCategory(dishes: IndexedDish[], cat: FoodCategory): IndexedDish[] {
  const byDish = dishes.filter((d) => matchesKeywords(d, cat));
  if (byDish.length || !cat.cuisines.length) return byDish;
  return dishes.filter((d) =>
    d.restaurant.cuisines.some((c) => cat.cuisines.includes(c))
  );
}

/**
 * How a category chip is being answered — so the screen can caption itself
 * truthfully. "cuisine" means no dish on any menu is actually a roll and what
 * you're looking at is the fast-food shops instead; saying that out loud is the
 * difference between a helpful fallback and a milkshake filed under Rolls.
 */
export function categoryBasis(
  index: IndexedDish[],
  id: string | null | undefined
): "dish" | "cuisine" | "none" {
  const cat = findFoodCategory(id);
  if (!cat) return "none";
  if (index.some((d) => matchesKeywords(d, cat))) return "dish";
  if (!cat.cuisines.length) return "none";
  return index.some((d) => d.restaurant.cuisines.some((c) => cat.cuisines.includes(c)))
    ? "cuisine"
    : "none";
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function passesFilters(d: IndexedDish, f: SearchFilters): boolean {
  if (f.veg && !d.item.veg) return false;
  if (f.popular && !(d.item.popular || d.item.bestseller)) return false;
  if (f.maxPrice != null && d.item.price > f.maxPrice) return false;
  if (f.fast && d.restaurant.etaMax > 25) return false;
  if (f.rating && d.restaurant.rating < 4.5) return false;
  if (f.offers && !d.restaurant.offer) return false;
  return true;
}

function compare(a: DishHit, b: DishHit, sort: DishSort): number {
  switch (sort) {
    case "price":
      return a.item.price - b.item.price || b.score - a.score;
    case "eta":
      return a.restaurant.etaMin - b.restaurant.etaMin || b.score - a.score;
    case "rating":
      // Bayesian, like every other rating comparison here — an explicit "sort
      // by rating" must not put a 5.0-from-nobody above a 4.6-from-two-hundred.
      return (
        bayesRating(b.restaurant.rating, b.restaurant.ratingCount) -
          bayesRating(a.restaurant.rating, a.restaurant.ratingCount) ||
        b.score - a.score
      );
    default:
      return b.score - a.score || a.name.localeCompare(b.name);
  }
}

/**
 * Rank dishes for a query. An empty query is not an empty result: it means
 * "show me the food", ranked by what sells and how good the kitchen is — which
 * is what makes the search tab worth opening before you've typed anything.
 */
export function searchDishes(
  index: IndexedDish[],
  query: string,
  filters: SearchFilters = {},
  sort: DishSort = "relevance",
  ctx: RankContext = {}
): DishHit[] {
  const category = findFoodCategory(filters.category);
  const pool = category ? filterCategory(index, category) : index;
  const tokens = tokenize(query);

  if (!tokens.length) {
    return pool
      .filter((d) => passesFilters(d, filters))
      .map((d) => ({ ...d, score: baseScore(d, ctx) }))
      .sort((a, b) => compare(a, b, sort));
  }

  // What was typed → what was meant. Resolves "potato" onto the menu's "Aloo",
  // "noodles" onto its misspelled "Noodels", and "cheap"/"veg" onto the filters
  // the screen already has. See semantic.ts for why this rather than embeddings.
  const expanded = expandQuery(tokens, vocabularyOf(index));

  // A query that was nothing but filler ("something to eat") still means "show
  // me the food" rather than "no results".
  if (expanded.empty) {
    return pool
      .filter((d) => passesFilters(d, filters))
      .map((d) => ({ ...d, score: baseScore(d, ctx) }))
      .sort((a, b) => compare(a, b, sort));
  }

  // Filters the words themselves asked for. An explicit chip always wins: if
  // the customer has un-ticked Pure Veg, typing "veg" must not silently tick it
  // back on. Only tightens a price ceiling, never loosens one.
  const effective: SearchFilters = {
    ...filters,
    veg: filters.veg || expanded.impliedVeg,
    maxPrice:
      expanded.impliedMaxPrice == null
        ? filters.maxPrice
        : Math.min(filters.maxPrice ?? Infinity, expanded.impliedMaxPrice),
  };

  const eligible = pool.filter((d) => passesFilters(d, effective));

  const tokens2 = gatePhonetic(index, expanded.tokens);

  const hits = rank(eligible, tokens2, true, ctx);

  // "chicken tikka" with no tikka anywhere would otherwise be a dead end, so a
  // phrase that matches nothing whole is re-run word by word. Flagged partial:
  // these are near misses, and the screen labels them as such.
  const results = hits.length ? hits : rank(eligible, tokens2, false, ctx);

  return results.sort((a, b) => compare(a, b, sort));
}

/**
 * The catalog's own words, for edit-distance to aim at.
 *
 * Cached against the index identity: the customer app builds one index per
 * catalog load and then searches it on every keystroke, so this runs once per
 * catalog rather than once per character. A WeakMap so a replaced index is
 * collectable rather than pinned by its own cache entry.
 */
const VOCAB_CACHE = new WeakMap<object, Set<string>>();

function vocabularyOf(index: IndexedDish[]): Set<string> {
  const hit = VOCAB_CACHE.get(index);
  if (hit) return hit;
  const vocab = buildVocabulary(
    index.map((d) => ({ name: d.name, category: d.category, shop: d.shop }))
  );
  VOCAB_CACHE.set(index, vocab);
  return vocab;
}

/**
 * Per index, per token: does this word already match something in the catalog
 * through a tier stronger than sound-alike? Memoised because it is a full-index
 * scan and search runs on every keystroke.
 */
const MATCHED_CACHE = new WeakMap<object, Map<string, boolean>>();

function matchesAnywhere(
  index: IndexedDish[],
  cacheKey: string,
  test: (d: IndexedDish) => boolean
): boolean {
  let cache = MATCHED_CACHE.get(index);
  if (!cache) {
    cache = new Map();
    MATCHED_CACHE.set(index, cache);
  }
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const found = index.some(test);
  cache.set(cacheKey, found);
  return found;
}

/**
 * Keep the phonetic tier only for words the catalog has no stronger answer to.
 *
 * Sound-alike is loose on purpose — loose enough that "cake" sounds like
 * "coke". That is harmless when "cake" matches nothing (then Coke is a fair
 * guess) and wrong when the catalog has cakes. So a token that matches anything
 * literally, by alias, by edit distance or by intent anywhere in the catalog
 * keeps its phonetic list empty, and exact results are never diluted by it.
 * Checked against the whole index rather than the filtered pool: a filter that
 * hides the real cakes must not turn "cake" into a search for Coke.
 */
function gatePhonetic(
  index: IndexedDish[],
  tokens: ExpandedToken[]
): ExpandedToken[] {
  return tokens.map((t) => {
    if (!t.phonetic.length) return t;
    const bare: ExpandedToken = { ...t, phonetic: [] };
    const known = matchesAnywhere(index, `strong:${t.token}`, (d) =>
      scoreToken(d, bare) > 0
    );
    return known ? bare : t;
  });
}

/**
 * What the customer probably meant, when what they typed matched nothing as
 * spelled: "panir tika" → "paneer tikka", "safron" → "saffron". Null when every
 * word was found as typed (or no result stands in for it).
 *
 * Read off the top result rather than guessed independently, so the words
 * shown are exactly the ones the list is answering. A word that exists
 * literally anywhere in the catalog is never "corrected" — typing "noodles" and
 * reaching a menu's "Noodels" through the fuzzy tier is the vendor's typo, not
 * the customer's, and telling them otherwise would be backwards.
 */
export function searchCorrection(
  index: IndexedDish[],
  query: string,
  hits: DishHit[]
): string | null {
  const top = hits[0];
  if (!top) return null;
  const raw = tokenize(query);
  if (!raw.length) return null;
  const expanded = expandQuery(raw, vocabularyOf(index));

  let changed = false;
  const out = raw.map((word) => {
    const t = expanded.tokens.find((e) => e.token === word);
    if (!t || t.intentOnly || t.aliases.length) return word;
    const spelledRight = matchesAnywhere(index, `literal:${word}`, (d) =>
      scoreLiteral(d, word) > 0
    );
    if (spelledRight) return word;

    let best: string | null = null;
    let bestScore = 0;
    for (const v of [...t.homophones, ...t.fuzzy, ...t.phonetic]) {
      const s = scoreLiteral(top, v);
      if (s > bestScore) {
        bestScore = s;
        best = v;
      }
    }
    if (!best) return word;
    changed = true;
    return best;
  });

  return changed ? out.join(" ") : null;
}

/**
 * Score a pool against every token. `all` = a dish must answer every word
 * (the precise pass); otherwise one word is enough (the near-miss pass).
 */
function rank(
  pool: IndexedDish[],
  tokens: ExpandedToken[],
  all: boolean,
  ctx: RankContext = {}
): DishHit[] {
  const hits: DishHit[] = [];
  for (const d of pool) {
    let sum = 0;
    let matched = 0;
    for (const token of tokens) {
      const s = scoreToken(d, token);
      if (s === 0) {
        if (all) {
          matched = -1;
          break;
        }
        continue;
      }
      sum += s;
      matched += 1;
    }
    if (matched <= 0) continue;
    const hit: DishHit = { ...d, score: baseScore(d, ctx) + sum / tokens.length };
    if (!all) hit.partial = true;
    hits.push(hit);
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * Same dish, many kitchens
 * ------------------------------------------------------------------ */

/**
 * The comparison key for "is this the same dish?".
 *
 * Deliberately conservative: case, punctuation and spacing only. It will not
 * merge "Paneer Butter Masala" with "Butter Paneer Masala", and — the case that
 * matters more — it will not merge "Thali (Half)" with "Thali (Full)".
 *
 * Stripping size words was the obvious next step and is the wrong one. Half and
 * full plates are different products at different prices; folding them together
 * would make the cross-vendor price comparison below compare a half plate at one
 * shop against a full plate at another and present the difference as a saving.
 * A missed merge shows one extra row. A false merge quotes a price that isn't
 * real. Those are not the same size of mistake.
 *
 * The way to widen this is an explicit synonym map built from real query logs,
 * not a cleverer regex.
 */
export function normalizeDishName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** One dish, every kitchen that sells it, best kitchen first. */
export interface DishGroup {
  /** Normalized name — the grouping key, and a stable React key. */
  key: string;
  /** What to print: the champion's own item name, verbatim, not the key. */
  label: string;
  /** The kitchen we're recommending, and the one ADD orders from. */
  champion: DishHit;
  /** Everyone else with the same dish, best first. Empty for a sole seller. */
  alternatives: DishHit[];
  /** How many kitchens sell it, champion included. */
  vendorCount: number;
  /**
   * The lowest price available below the champion's, or null when the champion
   * is already the cheapest.
   *
   * A separate field rather than a plain group minimum so the UI physically
   * cannot advertise "from ₹120" beside an ADD button that charges ₹150 — if
   * this is null there is no cheaper option to advertise, and if it isn't, this
   * is the number to show.
   */
  cheaperElsewhere: number | null;
  /** The champion's search score, so groups sort exactly as dishes did. */
  score: number;
}

/*
 * Champion weights. These decide, among kitchens selling the identical dish,
 * which one the customer is shown first — so the query terms are equal by
 * definition and everything here is about the offer, not the match.
 *
 * Proximity leads. Deligro delivers inside one town, and between two identical
 * plates of the same food the nearer one is better in every way that reaches
 * the customer: it arrives sooner, it arrives warmer, and it is likelier to
 * still be open. Price is relative rather than absolute so the term behaves the
 * same on a ₹40 chai and a ₹400 thali.
 */
const CHAMPION_PROXIMITY = 8; // per km
const CHAMPION_SPEED = 0.4; // per minute of quoted ETA
const CHAMPION_PRICE = 25; // per 100% over the group's cheapest
const CHAMPION_TRUST = 3; // per Bayesian star
const CHAMPION_TRACTION = 0.1; // per unit sold, capped
const CHAMPION_UNAVAILABLE = 1000; // effectively disqualifying

/**
 * A closed kitchen or a sold-out dish is never the champion while any open
 * kitchen sells the same thing — but the penalty is finite, so when *every*
 * seller is shut the group still resolves to one of them and the dish stays
 * visible. "Nobody has this right now" is a better answer than a blank screen.
 */
function championScore(
  d: DishHit,
  ctx: RankContext,
  groupMinPrice: number
): number {
  let s = 0;
  if (!d.restaurant.open || d.item.soldOut) s -= CHAMPION_UNAVAILABLE;

  const km = distanceOf(d, ctx);
  if (km !== null) s -= Math.min(km, 10) * CHAMPION_PROXIMITY;

  s -= Math.min(d.restaurant.etaMin, 60) * CHAMPION_SPEED;

  if (groupMinPrice > 0) {
    s -= ((d.item.price - groupMinPrice) / groupMinPrice) * CHAMPION_PRICE;
  }

  s += bayesRating(d.restaurant.rating, d.restaurant.ratingCount) * CHAMPION_TRUST;
  s += Math.min(d.item.unitsSold ?? 0, 100) * CHAMPION_TRACTION;
  s += rotationJitter(d.restaurant.slug, ctx);

  return s;
}

/**
 * Collapse a dish list into one row per dish.
 *
 * This is the shape the old flat list could not express. Six kitchens selling
 * paneer butter masala used to be six rows ordered by whoever had sold the most
 * historically — no price comparison, no distance, and one shop with six paneer
 * variants could take the whole screen. Now it is one row, the best kitchen
 * chosen on terms the customer would recognise as reasonable, and the others
 * one tap away with what they charge.
 */
export function groupByDish(
  hits: DishHit[],
  ctx: RankContext = {}
): DishGroup[] {
  const byName = new Map<string, DishHit[]>();
  for (const hit of hits) {
    const key = normalizeDishName(hit.item.name);
    if (!key) continue; // a name that is entirely punctuation groups with nothing
    const bucket = byName.get(key);
    if (bucket) bucket.push(hit);
    else byName.set(key, [hit]);
  }

  const groups: DishGroup[] = [];

  for (const [key, bucket] of byName) {
    // One entry per kitchen. A shop that lists the same dish twice is one place
    // that sells it, not two — otherwise "also at 3 more places" counts menus
    // instead of shops. Cheapest of its listings represents it.
    const byVendor = new Map<string, DishHit>();
    for (const hit of bucket) {
      const held = byVendor.get(hit.restaurant.slug);
      if (!held || hit.item.price < held.item.price) {
        byVendor.set(hit.restaurant.slug, hit);
      }
    }

    const vendors = [...byVendor.values()];
    const minPrice = vendors.reduce(
      (min, v) => Math.min(min, v.item.price),
      Number.MAX_SAFE_INTEGER
    );

    const ranked = vendors
      .map((v) => ({ v, s: championScore(v, ctx, minPrice) }))
      // Slug breaks exact ties so the order is total and stable — without it,
      // two vendors scoring identically could swap on every re-render.
      .sort((a, b) => b.s - a.s || a.v.restaurant.slug.localeCompare(b.v.restaurant.slug))
      .map((x) => x.v);

    const champion = ranked[0];
    const alternatives = ranked.slice(1);

    let cheaperElsewhere: number | null = null;
    for (const alt of alternatives) {
      if (alt.item.price < champion.item.price) {
        cheaperElsewhere =
          cheaperElsewhere === null
            ? alt.item.price
            : Math.min(cheaperElsewhere, alt.item.price);
      }
    }

    groups.push({
      key,
      label: champion.item.name,
      champion,
      alternatives,
      vendorCount: ranked.length,
      cheaperElsewhere,
      score: champion.score,
    });
  }

  return groups.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/**
 * Stop one kitchen owning the top of the screen.
 *
 * A shop with eight paneer dishes would otherwise take the first eight results
 * for "paneer" on merit — every one of them a genuine match — and the customer
 * would never learn that four other kitchens cook it too. This holds a vendor to
 * `maxPerVendor` dishes within the opening `withinFirst` results and defers the
 * overflow rather than dropping it: nothing is hidden, it just doesn't all land
 * above the fold.
 *
 * Applied to the flat dish list. `groupByDish` doesn't need it — one row per
 * dish already means a vendor can only appear once per dish.
 */
export function capPerVendor(
  hits: DishHit[],
  maxPerVendor = 2,
  withinFirst = 10
): DishHit[] {
  const head: DishHit[] = [];
  const deferred: DishHit[] = [];
  const tail: DishHit[] = [];
  const seen = new Map<string, number>();

  for (const hit of hits) {
    if (head.length >= withinFirst) {
      tail.push(hit);
      continue;
    }
    const slug = hit.restaurant.slug;
    const count = seen.get(slug) ?? 0;
    if (count >= maxPerVendor) {
      deferred.push(hit);
      continue;
    }
    seen.set(slug, count + 1);
    head.push(hit);
  }

  return [...head, ...deferred, ...tail];
}

/**
 * The same result set seen as restaurants: who can cook this, best match first,
 * carrying the dishes that matched so the card can say *why* it's here.
 *
 * Shops with an empty menu can never produce a dish hit, so they are matched on
 * name and cuisine directly — otherwise a shop you searched by name would
 * vanish the moment its menu was empty.
 */
export function groupByShop(
  hits: DishHit[],
  restaurants: Restaurant[],
  query: string,
  filters: SearchFilters = {},
  sort: DishSort = "relevance"
): ShopHit[] {
  const bySlug = new Map<string, ShopHit>();

  for (const hit of hits) {
    const existing = bySlug.get(hit.restaurant.slug);
    if (existing) {
      existing.dishes.push(hit);
      existing.score = Math.max(existing.score, hit.score);
    } else {
      bySlug.set(hit.restaurant.slug, {
        restaurant: hit.restaurant,
        score: hit.score,
        dishes: [hit],
      });
    }
  }

  const tokens = tokenize(query);
  const dishOnlyFilter =
    Boolean(filters.veg) ||
    Boolean(filters.popular) ||
    filters.maxPrice != null ||
    Boolean(filters.category);

  // Menu-less shops: no dish can vouch for them, so match the shop itself. Left
  // out entirely when a dish-level filter is on — "Pure Veg" cannot be honestly
  // claimed for a shop with nothing to inspect.
  if (!dishOnlyFilter) {
    for (const r of restaurants) {
      if (r.menu.length || bySlug.has(r.slug)) continue;
      if (filters.fast && r.etaMax > 25) continue;
      if (filters.rating && r.rating < 4.5) continue;
      if (filters.offers && !r.offer) continue;

      const shop = r.name.toLowerCase();
      const cuisines = r.cuisines.join(" ").toLowerCase();
      // Typo-tolerant like the dish path: a menu-less shop searched as "safron
      // kichen" is still "Saffron Kitchen".
      const matched =
        !tokens.length ||
        tokens.every(
          (t) =>
            startsWord(shop, t) ||
            startsWord(cuisines, t) ||
            looselyContains(shop, t)
        );
      if (!matched) continue;

      bySlug.set(r.slug, {
        restaurant: r,
        score:
          bayesRating(r.rating, r.ratingCount) * 2 - (tokens.length ? 30 : 0),
        dishes: [],
      });
    }
  }

  const shops = [...bySlug.values()];
  for (const shop of shops) shop.dishes.sort((a, b) => b.score - a.score);

  return shops.sort((a, b) => {
    switch (sort) {
      case "price":
        return cheapest(a) - cheapest(b) || b.score - a.score;
      case "eta":
        return a.restaurant.etaMin - b.restaurant.etaMin || b.score - a.score;
      case "rating":
        return b.restaurant.rating - a.restaurant.rating || b.score - a.score;
      default:
        return b.score - a.score;
    }
  });
}

function cheapest(shop: ShopHit): number {
  // Reduced rather than Math.min(...spread): a long menu would be a long
  // argument list, and this runs on every re-sort.
  return shop.dishes.reduce(
    (min, d) => Math.min(min, d.item.price),
    Number.MAX_SAFE_INTEGER
  );
}
