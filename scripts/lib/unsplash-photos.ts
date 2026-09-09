/**
 * The verified Unsplash photo library.
 *
 * Every id below was checked two ways, not recalled: fetched from
 * images.unsplash.com (a wrong id returns 404, so a live 200 proves the photo
 * exists) and then *looked at* as a contact sheet, so the picture is actually
 * of the dish family it is filed under. That second check is the one that
 * matters — the pools this replaces held ids that resolved fine and showed the
 * wrong thing: `bread` was a rice platter and a samosa, `momo` held a tandoori
 * chicken, two of three `roll` photos were canapés and pork ribs, and one
 * `fish` entry was a breakfast table. Four candidates were dropped outright for
 * being a stack of books, a typewriter, a lone banana and a spice flatlay.
 *
 * `npm run test:photos` re-runs both checks. Run it before adding an id.
 *
 * Keyless hotlinking, as before: no API key, no attribution fetch. See
 * `unsplash-images.ts` for how a photo is chosen.
 */

export type PoolName =
  | "momo"
  | "biryani"
  | "dosa"
  | "pizza"
  | "burger"
  | "bread"
  | "samosa"
  | "chinese"
  | "soup"
  | "salad"
  | "beverage"
  | "paneer"
  | "chicken"
  | "fish"
  | "egg"
  | "dessert"
  | "thali"
  | "roll"
  | "curry"
  | "default";

/**
 * One pool per dish family. Every id appears in exactly one pool — the old file
 * let `curry` borrow both of its photos from `thali` and `paneer`, so it had no
 * picture of its own and every dal on a menu showed a paneer bowl.
 * `test:photos` asserts the no-sharing rule.
 */
export const POOLS: Record<PoolName, readonly string[]> = {
  momo: [
    "photo-1496116218417-1a781b1c416c",
    "photo-1563245372-f21724e3856d",
    "photo-1534422298391-e4f8c172dddb",
    "photo-1625220194771-7ebdea0b70b9",
  ],
  biryani: [
    "photo-1563379091339-03b21ab4a4f8",
    "photo-1631515243349-e0cb75fb8d3a",
    "photo-1589302168068-964664d93dc0",
    // Filed under `bread` before, where it was the photo every roti, naan and
    // paratha on a menu resolved to. It is a rice platter.
    "photo-1633945274405-b6c8069047b0",
    "photo-1630851840633-f96999247032",
    "photo-1642821373181-696a54913e93",
    "photo-1512058564366-18510be2db19",
  ],
  dosa: [
    "photo-1668236543090-82eba5ee5976",
    "photo-1630383249896-424e482df921",
    "photo-1589301760014-d929f3979dbc",
    "photo-1613292443284-8d10ef9383fe",
  ],
  pizza: [
    "photo-1513104890138-7c749659a591",
    "photo-1574071318508-1cdbab80d002",
    "photo-1604382354936-07c5d9983bd3",
    "photo-1585238342024-78d387f4a707",
    "photo-1594007654729-407eedc4be65",
    "photo-1573821663912-6df460f9c684",
    "photo-1571407970349-bc81e7e96d47",
  ],
  burger: [
    "photo-1568901346375-23c9450c58cd",
    "photo-1571091718767-18b5b1457add",
    "photo-1550547660-d9450f859349",
    "photo-1586190848861-99aa4a171e90",
    "photo-1610440042657-612c34d95e9f",
    "photo-1550317138-10000687a72b",
  ],
  // The thinnest pool in the library: flatbread photographed on its own is rare
  // on Unsplash, and a wrong one here is very visible because breads are always
  // listed together. Kept honest rather than padded — RELATED sends roti/naan
  // overflow to thali and curry, which is what a bread is served with.
  bread: [
    "photo-1565557623262-b51c2513a641",
    "photo-1601050690597-df0568f70950",
  ],
  samosa: [
    "photo-1601050690117-94f5f6fa8bd7",
    "photo-1606525437679-037aca74a3e9",
    "photo-1666190092159-3171cf0fbb12",
  ],
  chinese: [
    "photo-1585032226651-759b368d7246",
    "photo-1569718212165-3a8278d5f624",
    "photo-1596560548464-f010549b84d7",
    "photo-1615832494873-b0c52d519696",
    "photo-1626804475297-41608ea09aeb",
    "photo-1607330289024-1535c6b4e1c1",
  ],
  soup: [
    "photo-1547592166-23ac45744acd",
    "photo-1543353071-873f17a7a088",
  ],
  salad: [
    "photo-1512621776951-a57141f2eefd",
    "photo-1540420773420-3366772f4999",
    "photo-1546793665-c74683f339c1",
    "photo-1609501676725-7186f017a4b7",
    "photo-1505253716362-afaea1d3d1af",
  ],
  beverage: [
    "photo-1544145945-f90425340c7e",
    "photo-1461023058943-07fcbe16d735",
    "photo-1595981267035-7b04ca84a82d",
    "photo-1600271886742-f049cd451bba",
  ],
  paneer: [
    "photo-1631452180519-c014fe946bc7",
    "photo-1567188040759-fb8a883dc6d8",
    "photo-1589647363585-f4a7d3877b10",
    "photo-1603133872878-684f208fb84b",
  ],
  chicken: [
    "photo-1610057099443-fde8c4d50f91",
    "photo-1567620832903-9fc6debc209f",
    "photo-1598515214211-89d3c73ae83b",
    "photo-1599487488170-d11ec9c172f0",
    "photo-1619221882220-947b3d3c8861",
    "photo-1604909052743-94e838986d24",
    "photo-1626074353765-517a681e40be",
  ],
  fish: [
    "photo-1519708227418-c8fd9a32b7a2",
    "photo-1580476262798-bddd9f4b7369",
    "photo-1559847844-5315695dadae",
  ],
  egg: [
    "photo-1482049016688-2d3e1b311543",
    "photo-1525351484163-7529414344d8",
    "photo-1608039829572-78524f79c4c7",
    "photo-1606851094291-6efae152bb87",
    "photo-1618449840665-9ed506d73a34",
  ],
  dessert: [
    "photo-1578985545062-69928b1d9587",
    "photo-1551024506-0bccd828d307",
    "photo-1558961363-fa8fdf82db35",
    "photo-1567620905732-2d1ec7ab7445",
    "photo-1617093727343-374698b1b08d",
    "photo-1552611052-33e04de081de",
  ],
  thali: [
    "photo-1585937421612-70a008356fbe",
    "photo-1596797038530-2c107229654b",
    "photo-1567337710282-00832b415979",
    "photo-1606491956689-2ea866880c84",
  ],
  roll: [
    "photo-1541014741259-de529411b96a",
    "photo-1544025162-d76694265947",
    "photo-1596040033229-a9821ebd058d",
  ],
  // Its own photos at last: dal, butter chicken, kadai gravies, curry bowls.
  curry: [
    "photo-1585149804923-ec4c2bd0d0ee",
    "photo-1586511925558-a4c6376fe65f",
    "photo-1631292784640-2b24be784d5d",
    "photo-1621996346565-e3dbc646d9a9",
    "photo-1608219992759-8d74ed8d76eb",
    "photo-1587132137056-bfbf0166836e",
    "photo-1620146344904-097a0002d3d9",
  ],
  default: [
    "photo-1504674900247-0877df9cc836",
    "photo-1476224203421-9ac39bcb3327",
    "photo-1555939594-58d7cb561ad1",
    "photo-1517244683847-7456b63c5969",
    "photo-1546833999-b9f581a1996d",
    "photo-1585909695284-32d2985ac9c0",
  ],
} as const;

/**
 * Where to look when a pool is exhausted *within one restaurant*.
 *
 * This is what buys uniqueness without needing a photo per menu item. A shop
 * with eleven paneer dishes runs `paneer` dry after four; rather than repeat
 * one, it takes from curry and thali, which are the same food photographed on
 * the same table. Ordered most-alike first, and `default` is appended to every
 * chain as the last resort.
 */
export const RELATED: Record<PoolName, readonly PoolName[]> = {
  momo: ["chinese", "roll", "samosa"],
  biryani: ["thali", "curry", "chicken"],
  dosa: ["thali", "samosa", "bread"],
  pizza: ["burger", "bread", "chinese"],
  burger: ["pizza", "roll", "chicken"],
  bread: ["thali", "curry", "dosa"],
  samosa: ["roll", "dosa", "chinese"],
  chinese: ["momo", "roll", "soup"],
  soup: ["curry", "chinese", "thali"],
  salad: ["thali", "soup", "roll"],
  beverage: ["dessert"],
  paneer: ["curry", "thali", "chinese"],
  chicken: ["curry", "roll", "biryani"],
  fish: ["chicken", "curry", "soup"],
  egg: ["chicken", "curry", "bread"],
  dessert: ["beverage", "thali"],
  thali: ["curry", "bread", "biryani"],
  roll: ["samosa", "chinese", "burger"],
  curry: ["paneer", "thali", "bread"],
  default: ["thali", "curry", "chicken", "biryani"],
};

/** Every id in the library, deduped — the final fallback ring. */
export const ALL_PHOTOS: readonly string[] = Object.values(POOLS).flat();
