/**
 * Unsplash CDN URLs for legacy catalog seeding.
 * Same format as src/lib/data.ts — allowed by CSP (images.unsplash.com).
 *
 * Keyless hotlinking: every id below is a real, verified Unsplash photo slug
 * (`photo-<timestamp>-<hash>`) served straight from images.unsplash.com with
 * on-the-fly resizing (`?w=&q=&auto=format&fit=crop`). No API key, no attribution
 * fetch — the same deterministic, curated-pool approach the Pexels version used.
 *
 * Matching priority: item NAME first (most specific dish wins), then category.
 * e.g. "Chicken Momo" → momo photo, not chicken curry.
 */

function unsplashUrl(id: string, w = 800): string {
  return `https://images.unsplash.com/${id}?w=${w}&q=80&auto=format&fit=crop`;
}

/** Curated Unsplash photo ids — one pool per dish family. */
const PHOTOS = {
  momo: [
    "photo-1496116218417-1a781b1c416c",
    "photo-1626074353765-517a681e40be",
    "photo-1563245372-f21724e3856d",
  ],
  biryani: [
    "photo-1563379091339-03b21ab4a4f8",
    "photo-1631515243349-e0cb75fb8d3a",
    "photo-1589302168068-964664d93dc0",
  ],
  dosa: ["photo-1668236543090-82eba5ee5976", "photo-1630383249896-424e482df921"],
  pizza: [
    "photo-1513104890138-7c749659a591",
    "photo-1574071318508-1cdbab80d002",
    "photo-1604382354936-07c5d9983bd3",
  ],
  burger: [
    "photo-1568901346375-23c9450c58cd",
    "photo-1571091718767-18b5b1457add",
    "photo-1550547660-d9450f859349",
  ],
  bread: ["photo-1601050690597-df0568f70950", "photo-1633945274405-b6c8069047b0"],
  samosa: ["photo-1601050690117-94f5f6fa8bd7", "photo-1666190092159-3171cf0fbb12"],
  chinese: [
    "photo-1585032226651-759b368d7246",
    "photo-1569718212165-3a8278d5f624",
    "photo-1512058564366-18510be2db19",
  ],
  soup: ["photo-1547592166-23ac45744acd", "photo-1543353071-873f17a7a088"],
  salad: ["photo-1512621776951-a57141f2eefd", "photo-1540420773420-3366772f4999"],
  beverage: ["photo-1544145945-f90425340c7e", "photo-1461023058943-07fcbe16d735"],
  paneer: ["photo-1631452180519-c014fe946bc7", "photo-1567188040759-fb8a883dc6d8"],
  chicken: [
    "photo-1610057099443-fde8c4d50f91",
    "photo-1567620832903-9fc6debc209f",
    "photo-1598515214211-89d3c73ae83b",
  ],
  fish: [
    "photo-1519708227418-c8fd9a32b7a2",
    "photo-1580476262798-bddd9f4b7369",
    "photo-1535140728325-a4d3707eee61",
  ],
  egg: [
    "photo-1482049016688-2d3e1b311543",
    "photo-1525351484163-7529414344d8",
    "photo-1608039829572-78524f79c4c7",
  ],
  dessert: ["photo-1578985545062-69928b1d9587", "photo-1551024506-0bccd828d307"],
  thali: ["photo-1585937421612-70a008356fbe", "photo-1596797038530-2c107229654b"],
  roll: [
    "photo-1541014741259-de529411b96a",
    "photo-1606525437679-037aca74a3e9",
    "photo-1544025162-d76694265947",
  ],
  curry: ["photo-1585937421612-70a008356fbe", "photo-1631452180519-c014fe946bc7"],
  default: [
    "photo-1504674900247-0877df9cc836",
    "photo-1476224203421-9ac39bcb3327",
    "photo-1555939594-58d7cb561ad1",
  ],
} as const;

type PhotoPool = readonly string[];

interface DishRule {
  /** Higher = checked first among rules in the same pass. */
  priority: number;
  patterns: RegExp[];
  pool: PhotoPool;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashKey(value: string): number {
  // Hashed per UTF-16 code unit, exactly as a charCodeAt walk did: the photo a
  // name gets must not change between imports (migrate-images relies on it),
  // and codePointAt would re-hash every name holding an emoji.
  const units = Buffer.from(value, "utf16le");
  let h = 0;
  for (let i = 0; i < units.length; i += 2) {
    h = (Math.imul(31, h) + units.readUInt16LE(i)) | 0;
  }
  return Math.abs(h);
}

function pickPool(pool: PhotoPool, key: string): string {
  return pool[hashKey(key) % pool.length]!;
}

function firstMatch(text: string, rules: DishRule[]): PhotoPool | null {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    if (rule.patterns.some((p) => p.test(text))) return rule.pool;
  }
  return null;
}

/**
 * Name-first rules — ordered by priority so "chicken momo" hits momo, not chicken.
 */
const NAME_RULES: DishRule[] = [
  {
    priority: 100,
    patterns: [/\bmomos?\b/, /\bdumpling/, /\bdim\s*sum\b/],
    pool: PHOTOS.momo,
  },
  {
    priority: 95,
    patterns: [/\bbiryani\b/, /\bpulao\b/, /\bpulav\b/, /\bmatka\b/],
    pool: PHOTOS.biryani,
  },
  {
    priority: 90,
    patterns: [
      /\bdosa\b/,
      /\bidli\b/,
      /\buttapam\b/,
      /\bupma\b/,
      /\bvada\b/,
      /\bsambar\b/,
      /\bmedu\b/,
    ],
    pool: PHOTOS.dosa,
  },
  {
    priority: 88,
    patterns: [/\bpizza\b/, /\bbrusett/, /\bbruschetta\b/],
    pool: PHOTOS.pizza,
  },
  {
    priority: 86,
    patterns: [/\bburger\b/, /\bsmash\b/],
    pool: PHOTOS.burger,
  },
  {
    priority: 89,
    patterns: [/\bsamosa\b/, /\bkachori\b/, /\bpakoda\b/, /\bpakora\b/, /\bbonda\b/],
    pool: PHOTOS.samosa,
  },
  {
    priority: 84,
    patterns: [
      /\bchowmein\b/,
      /\bnoodle/,
      /\bmanchurian\b/,
      /\bschezwan\b/,
      /\bfried\s*rice\b/,
      /\bmaggi\b/,
      /\bchilli\s*garlic\b/,
    ],
    pool: PHOTOS.chinese,
  },
  {
    priority: 82,
    patterns: [
      /\bparatha\b/,
      /\bnaan\b/,
      /\broti\b/,
      /\bbhatur/,
      /\bkulcha\b/,
      /\bchapati\b/,
      /\btandoori\s*roti\b/,
    ],
    pool: PHOTOS.bread,
  },
  {
    priority: 78,
    patterns: [/\bsoup\b/],
    pool: PHOTOS.soup,
  },
  {
    priority: 76,
    patterns: [/\bsalad\b/, /\braita\b/, /\bpapad\b/, /\bkachumber\b/],
    pool: PHOTOS.salad,
  },
  {
    priority: 74,
    patterns: [
      /\bshake\b/,
      /\bjuice\b/,
      /\blassi\b/,
      /\bcoffee\b/,
      /\btea\b/,
      /\bmilk\s*shake\b/,
      /\bcold\s*coffee\b/,
      /\bbeverage\b/,
      /\bdrink\b/,
    ],
    pool: PHOTOS.beverage,
  },
  {
    priority: 72,
    patterns: [/\bspring\s*roll\b/, /\begg\s*roll\b/, /\bchicken\s*roll\b/, /\bveg\s*roll\b/],
    pool: PHOTOS.roll,
  },
  {
    priority: 70,
    patterns: [/\bthali\b/],
    pool: PHOTOS.thali,
  },
  {
    priority: 68,
    patterns: [
      /\bsweet\b/,
      /\bdessert\b/,
      /\bcake\b/,
      /\bice\s*cream\b/,
      /\bhalwa\b/,
      /\bjamun\b/,
      /\bkulfi\b/,
    ],
    pool: PHOTOS.dessert,
  },
  {
    priority: 60,
    patterns: [/\bpaneer\b/],
    pool: PHOTOS.paneer,
  },
  {
    priority: 58,
    patterns: [/\bfish\b/, /\bprawn\b/, /\bshrimp\b/],
    pool: PHOTOS.fish,
  },
  {
    priority: 56,
    patterns: [
      /\bchicken\b/,
      /\btandoori\b/,
      /\btikka\b/,
      /\bkebab\b/,
      /\broast\s*chicken\b/,
      /\bleg\s*piece\b/,
    ],
    pool: PHOTOS.chicken,
  },
  {
    priority: 54,
    patterns: [/\bmutton\b/, /\blamb\b/, /\bkeema\b/],
    pool: PHOTOS.chicken,
  },
  {
    priority: 52,
    patterns: [/\begg\b/, /\banda\b/, /\bbhurji\b/],
    pool: PHOTOS.egg,
  },
  {
    priority: 50,
    patterns: [/\bdal\b/, /\bcurry\b/, /\bmasala\b/, /\bgravy\b/, /\bkadai\b/, /\bkadhai\b/],
    pool: PHOTOS.curry,
  },
];

/** Category fallback when the dish name is vague ("Special", "Combo", etc.). */
const CATEGORY_RULES: DishRule[] = [
  { priority: 40, patterns: [/\bmomo/], pool: PHOTOS.momo },
  { priority: 40, patterns: [/\bbiryani/], pool: PHOTOS.biryani },
  { priority: 40, patterns: [/\bsouth\s*indian/, /\bdosa/, /\bidli/], pool: PHOTOS.dosa },
  { priority: 40, patterns: [/\bpizza/], pool: PHOTOS.pizza },
  { priority: 40, patterns: [/\bburger/], pool: PHOTOS.burger },
  { priority: 40, patterns: [/\bchinese/, /\bnoodle/, /\bchow/], pool: PHOTOS.chinese },
  { priority: 40, patterns: [/\broti/, /\bparatha/, /\bnaan/, /\bbread/], pool: PHOTOS.bread },
  { priority: 40, patterns: [/\bsoup/], pool: PHOTOS.soup },
  { priority: 40, patterns: [/\bsalad/, /\braita/, /\bpapad/], pool: PHOTOS.salad },
  { priority: 40, patterns: [/\bbeverage/, /\bdrink/, /\bshake/, /\bcoffee/], pool: PHOTOS.beverage },
  { priority: 40, patterns: [/\bstarter/, /\bstarters/, /\bpakoda/], pool: PHOTOS.samosa },
  { priority: 40, patterns: [/\bcurry/, /\bgravy/, /\bmain/], pool: PHOTOS.curry },
];

function resolvePool(
  category: string,
  itemName: string,
  hint = ""
): PhotoPool {
  const name = normalize(itemName);
  const cat = normalize(category);

  let byName = firstMatch(name, NAME_RULES);
  if (!byName && hint) byName = firstMatch(normalize(hint), NAME_RULES);
  if (byName) return byName;

  const byCategory = firstMatch(cat, CATEGORY_RULES);
  if (byCategory) return byCategory;

  if (hint) {
    const byHint = firstMatch(normalize(hint), CATEGORY_RULES);
    if (byHint) return byHint;
  }

  return PHOTOS.default;
}

/** Menu item cover — matched to the dish name first. */
export function unsplashForMenuItem(
  category: string,
  itemName: string,
  hint = ""
): string {
  const pool = resolvePool(category, itemName, hint);
  return unsplashUrl(pickPool(pool, `${category}:${itemName}`), 600);
}

/** Restaurant hero — matched from shop name + cuisines. */
export function unsplashForRestaurant(
  name: string,
  cuisines: string[],
  famous?: string
): string {
  const text = normalize([name, ...cuisines, famous ?? ""].join(" "));
  const pool =
    firstMatch(text, NAME_RULES) ??
    firstMatch(text, CATEGORY_RULES) ??
    PHOTOS.default;
  return unsplashUrl(pickPool(pool, `restaurant:${name}`), 1200);
}

