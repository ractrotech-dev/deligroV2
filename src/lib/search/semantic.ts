/**
 * Semantic layer for dish search.
 *
 * The matcher underneath this file compares strings. That is not what a hungry
 * person does. Three gaps, all measured against this catalog (3,797 dishes, 804
 * distinct words) rather than imagined:
 *
 *  1. **The menus are misspelled.** Not the queries — the DATA. The catalog
 *     contains "Noodels" and "Noddels" (15 and 3 dishes), "Mashroom" (8),
 *     "Maxican" (15), "Coffe" (5), "Vanila" (5), "Rashgulla", "Hydrabadi",
 *     "Sechzwan", "Faimly". A customer who spells "noodles" correctly found
 *     nothing. String equality punishes the customer for the vendor's typo.
 *
 *  2. **One food has several names.** The menus say "Aloo", "Aalu" and "Aaloo"
 *     for the same potato; "Gobhi" and "Gobi"; "Dal" and "Daal"; "Tamatar" and
 *     "Tamater"; "Pyaj", "Pyaja" and "Pyaza". Someone typing "potato" or
 *     "onion" — ordinary English — matched none of them.
 *
 *  3. **People search by attribute.** "spicy", "cold", "sweet" are not dish
 *     names and appear in almost no dish title, but they are what someone types
 *     when they know the mood and not the menu.
 *
 * Why this and not embeddings: a vector search would need an external API key
 * (none is configured), a per-query network round trip, an ingestion job to
 * re-embed on every menu edit, and it would still not know that "Noodels" is
 * "noodles" — that is a spelling problem, not a meaning problem. For an 804-word
 * domain vocabulary, a concept lexicon plus edit-distance is more accurate,
 * costs nothing, runs offline and is deterministic, which means it is testable.
 *
 * Everything here is pure and framework-free, matching `dishes.ts`.
 */

/* ------------------------------------------------------------------ *
 * Concept lexicon
 * ------------------------------------------------------------------ */

/**
 * Canonical concept → every surface form that means it in THIS catalog.
 *
 * Built by reading the actual word frequency list, not from a general food
 * ontology: every alias below appears in these menus or is the plain English a
 * customer would reasonably type for something that does. Spelling variants
 * that edit-distance already catches are still listed when they are common,
 * because an exact alias hit scores higher than a fuzzy one and should.
 *
 * These are Latin-script menu words — the words the vendors themselves typed
 * into their menus. This is not Devanagari input and there is no Hindi UI here;
 * "Aloo Paratha" is simply what the dish is called.
 */
const CONCEPTS: Record<string, string[]> = {
  // ---- vegetables & core ingredients ----
  potato: ["potato", "potatoes", "aloo", "alu", "aalu", "aaloo"],
  cauliflower: ["cauliflower", "gobhi", "gobi", "gobbi"],
  peas: ["peas", "matar", "mutter", "mattar"],
  chickpea: ["chickpea", "chickpeas", "chana", "chole", "chhole", "channa"],
  lentil: ["lentil", "lentils", "dal", "daal", "dhal", "moong", "toor", "arhar"],
  spinach: ["spinach", "palak"],
  okra: ["okra", "bhindi", "ladyfinger", "ladiesfinger"],
  fenugreek: ["fenugreek", "methi"],
  bittergourd: ["bittergourd", "karela"],
  eggplant: ["eggplant", "brinjal", "baingan", "bharta"],
  tomato: ["tomato", "tomatoes", "tamatar", "tamater"],
  onion: ["onion", "onions", "pyaj", "pyaja", "pyaza", "pyaaz", "kanda"],
  garlic: ["garlic", "lahsun", "lahsuni", "lasooni"],
  ginger: ["ginger", "adrak"],
  coriander: ["coriander", "cilantro", "dhaniya", "hara", "hariyali", "haryali"],
  mint: ["mint", "pudina"],
  capsicum: ["capsicum", "pepper", "shimla"],
  corn: ["corn", "babycorn", "makai", "bhutta"],
  mushroom: ["mushroom", "mushrooms", "mashroom", "khumb"],
  cabbage: ["cabbage", "patta"],
  carrot: ["carrot", "gajar"],

  // ---- proteins ----
  paneer: ["paneer", "panner", "cottage"],
  egg: ["egg", "eggs", "anda", "ande", "omelette", "omlet", "omelet", "bhurji"],
  chicken: ["chicken", "murg", "murgh", "chikan", "chiken"],
  mutton: ["mutton", "goat", "keema", "kima", "kheema"],
  fish: ["fish", "machli", "machhli"],
  soya: ["soya", "soy", "chap", "tofu"],

  // ---- staples ----
  rice: ["rice", "chawal", "chaval", "pulao", "pulav", "khichdi", "khichadi"],
  bread: [
    "bread", "flatbread", "roti", "rotis", "chapati", "chapatti", "phulka",
    "naan", "nan", "kulcha", "paratha", "parantha", "paranthi", "missi",
    "lachha", "laccha", "toast", "bhature", "puri", "poori", "pav",
  ],
  noodles: [
    "noodles", "noodle", "noodels", "noddels", "chowmein", "chowmin", "chow",
    "hakka", "maggi", "maggie", "pasta", "spaghetti",
  ],

  // ---- dairy & sweeteners ----
  // "matka" is the clay pot it is served in, not the food — it names Matka Kulfi
  // as readily as Matka Lassi. Same reasoning as "dum" above.
  curd: ["curd", "dahi", "yogurt", "yoghurt", "raita", "lassi", "chaas"],
  milk: ["milk", "doodh", "badam"],
  cheese: ["cheese", "mozzarella", "cheesy"],
  butter: ["butter", "makhan", "makhani", "makhni", "ghee"],
  cashew: ["cashew", "kaju"],
  coconut: ["coconut", "nariyal"],

  // ---- dish families ----
  // NOT "dum". It is a cooking method (slow-cooked, sealed), so it names both
  // "Hyderabadi Dum Biryani" and "Dum Aloo" — a potato curry. Listing it here
  // made a search for "biriyani" answer with Dum Aloo, Aloo Dum Kashmiri and
  // Aloo Dum Punjabi ahead of any actual biryani. Preparation words belong in
  // the preparation concepts below, never in a dish concept.
  biryani: ["biryani", "biriyani", "briyani", "biriani"],
  momo: ["momo", "momos", "dumpling", "dumplings"],
  samosa: ["samosa", "samose", "kachori", "patties", "patty"],
  pakora: ["pakora", "pakoda", "bhaji", "bhajiya", "bhajji", "vada", "wada"],
  chaat: ["chaat", "chat", "chatpata", "bhel", "papdi", "dabeli", "gupchup", "sev"],
  dosa: ["dosa", "dosai", "uttapam", "uthappam", "idli", "idly", "vada", "sambhar", "sambar"],
  pizza: ["pizza", "margherita", "farmhouse"],
  burger: ["burger", "burgers"],
  roll: ["roll", "rolls", "wrap", "wraps", "frankie"],
  sandwich: ["sandwich", "sandwitch", "sandwhich"],
  soup: ["soup", "shorba", "manchow"],
  salad: ["salad", "kachumber", "salade"],
  thali: ["thali", "thaali", "meal", "meals", "bhojan", "platter"],
  sweets: [
    "sweets", "sweet", "mithai", "dessert", "desserts", "halwa", "barfi",
    "burfi", "laddu", "ladoo", "jalebi", "rasmalai", "rasgulla", "rashgulla",
    "gulab", "jamun", "peda", "kalakand", "modak", "boondi", "rabdi", "mawa",
    "katli", "magaj",
  ],
  icecream: ["icecream", "ice", "kulfi", "gelato", "sundae", "cone", "faluda"],
  cake: ["cake", "pastry", "brownie", "cookies", "cookie", "truffle", "muffin"],
  shake: ["shake", "shakes", "smoothie", "thickshake"],
  coffee: ["coffee", "coffe", "cappuccino", "latte", "espresso", "mocha"],
  tea: ["tea", "chai", "cutting", "kadak"],
  juice: ["juice", "juices", "mojito", "mocktail", "cooler", "soda", "lime", "nimbu", "shikanji"],

  // ---- preparations ----
  tandoori: ["tandoori", "tandoor", "grilled", "roasted", "roast", "sigri", "seekh", "seek", "afgani", "afghani"],
  fried: ["fried", "fry", "crispy", "crunchy", "deepfried"],
  gravy: ["gravy", "curry", "masala", "handi", "kadai", "kadhai", "korma", "kofta", "lababdar", "makhanwala"],
  steamed: ["steamed", "steam", "boiled", "ubla"],
  // Slow-cooked and sealed. Its own concept precisely so it stops being mistaken
  // for the biryani it usually accompanies.
  dum: ["dum", "dumpukht"],
};

/* ------------------------------------------------------------------ *
 * Attribute intents — what someone means when they don't name a dish
 * ------------------------------------------------------------------ */

/**
 * Words that describe the food rather than name it.
 *
 * `expands` are dish words that genuinely carry the attribute in this catalog;
 * `veg` and `maxPrice` map onto filters the search screen already has, so
 * typing "veg snacks" narrows exactly as ticking the Pure Veg chip would.
 */
interface Intent {
  /** Dish words that carry this attribute. */
  expands: string[];
  /** Applies the existing vegetarian filter. */
  veg?: boolean;
  /** Applies the existing price ceiling, in rupees. */
  maxPrice?: number;
}

const INTENTS: Record<string, Intent> = {
  spicy: {
    expands: ["chilli", "chili", "chilly", "schezwan", "sechzwan", "peri", "masala", "kolhapuri", "achari", "aachari", "tadka", "hot", "teekha", "chatpata", "lahsuni"],
  },
  sweet: { expands: ["sweet", "sweets", "mithai", "dessert", "chocolate", "gulab", "jamun", "halwa", "cake", "kulfi", "meetha"] },
  cold: { expands: ["cold", "iced", "ice", "chilled", "shake", "lassi", "juice", "soda", "mojito", "kulfi", "thanda"] },
  hot: { expands: ["hot", "tea", "coffee", "soup", "garam"] },
  crispy: { expands: ["crispy", "crunchy", "fried", "fry", "kurkure", "fries", "papad"] },
  healthy: { expands: ["salad", "soup", "grilled", "steamed", "steam", "boiled", "sprout", "fruit", "roasted"], veg: true },
  cheap: { expands: [], maxPrice: 100 },
  budget: { expands: [], maxPrice: 100 },
  veg: { expands: ["veg", "vegetable", "vegetables", "vegetarian", "veggie", "veggies", "paneer"], veg: true },
};

/** Filler words that carry no food meaning — dropped before matching. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "with", "without", "of", "in", "for", "me",
  "some", "any", "please", "want", "need", "give", "order", "food", "dish",
  "something", "i", "to", "my", "is", "it", "near", "best", "good", "nice",
]);

/* ------------------------------------------------------------------ *
 * Reverse index — surface form → concepts
 * ------------------------------------------------------------------ */

const SURFACE_TO_CONCEPTS: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [concept, forms] of Object.entries(CONCEPTS)) {
    for (const form of [concept, ...forms]) {
      const list = map.get(form);
      if (list) {
        // A word can mean more than one thing: "vada" is both a fritter and the
        // vada in vada pav / vada sambhar, so it belongs to pakora AND dosa.
        if (!list.includes(concept)) list.push(concept);
      } else {
        map.set(form, [concept]);
      }
    }
  }
  return map;
})();

/** Every surface form of every concept this token belongs to. */
function aliasesFor(token: string): string[] {
  const concepts = SURFACE_TO_CONCEPTS.get(token);
  if (!concepts) return [];
  const out = new Set<string>();
  for (const c of concepts) {
    out.add(c);
    for (const form of CONCEPTS[c]) out.add(form);
  }
  out.delete(token); // the token itself is scored by the exact tier
  return [...out];
}

/* ------------------------------------------------------------------ *
 * Fuzzy matching
 * ------------------------------------------------------------------ */

/**
 * Edits allowed, by word length.
 *
 * Short words are dense — at 4 characters, one edit reaches "rice"→"nice",
 * "dal"→"dahi", "roti"→"roll". Those are different foods, and a wrong result is
 * worse than no result, so short tokens get exact matching only and lean on the
 * concept lexicon instead. Length 5+ is where the real misspellings live
 * ("coffe", "vanila", "panner", "chiken"), and 8+ tolerates two ("capucino" →
 * "cappuccino", "milkshek" → "milkshake").
 *
 * Both of the examples this comment used to give were wrong, which matters
 * because they are the only description of what the budget buys. "hydrabadi" →
 * "hyderabadi" is one edit, not two, so it was already covered at 5+ and proved
 * nothing about the 8+ tier. "noddels" → "noodles" genuinely needs two — but
 * "noddels" is seven characters, so this function gives it a budget of one and
 * the pair does NOT match. Measured, not reasoned: see `scripts/qa/dish-ranking.ts`,
 * which now pins all four tiers so the next edit to these numbers has to argue
 * with a test rather than with a comment.
 */
function maxEdits(len: number): number {
  if (len <= 4) return 0;
  if (len <= 7) return 1;
  return 2;
}

/**
 * Damerau-Levenshtein (optimal string alignment), bailing out as soon as the
 * whole row exceeds the budget.
 *
 * Transposition matters more than usual here: the catalog's misspellings are
 * mostly swapped adjacent letters — "noodels" for "noodles", "panner" for
 * "paneer". Plain Levenshtein charges those two edits and would miss them at a
 * budget of one.
 */
export function withinEdits(a: string, b: string, budget: number): boolean {
  if (a === b) return true;
  if (budget <= 0) return false;
  if (Math.abs(a.length - b.length) > budget) return false;

  const m = a.length;
  const n = b.length;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  const curr: number[] = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Nothing further down can come back under budget.
    if (rowMin > budget) return false;
    prev2 = prev;
    prev = curr.slice();
  }
  return prev[n] <= budget;
}

/**
 * Words in the catalog that are probably this token misspelled (either way
 * round — the typo is as often the vendor's as the customer's).
 *
 * Scanned against the catalog vocabulary rather than against every dish, so the
 * cost is one pass over ~800 words per query token, not per dish.
 */
/**
 * Memoised per vocabulary, because search runs on every keystroke and "paneer"
 * is re-expanded on each of the six. A WeakMap on the vocabulary Set so a
 * replaced catalog takes its cache with it.
 */
const FUZZY_CACHE = new WeakMap<Set<string>, Map<string, string[]>>();

export function fuzzyVariants(token: string, vocabulary: Set<string>): string[] {
  let cache = FUZZY_CACHE.get(vocabulary);
  if (!cache) {
    cache = new Map();
    FUZZY_CACHE.set(vocabulary, cache);
  }
  const hit = cache.get(token);
  if (hit) return hit;

  const budget = maxEdits(token.length);
  const out: string[] = [];
  if (budget > 0) {
    for (const word of vocabulary) {
      // The token as typed is scored by the literal tier already.
      if (word === token) continue;
      if (Math.abs(word.length - token.length) > budget) continue;
      if (withinEdits(token, word, budget)) out.push(word);
    }
  }
  cache.set(token, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * Phonetic matching — how a word SOUNDS, not how it is spelled
 * ------------------------------------------------------------------ */

/**
 * Edit distance is the wrong ruler for transliterated Hindi. There is no one
 * right way to write पनीर in Latin letters, so "panir" and "paneer" are the
 * same word written by two people — yet they are two edits apart, and at five
 * letters `maxEdits` allows one. "chaumin" is three edits from "chowmein".
 * "safran" is two from "Saffron". Each of those searches used to show zero.
 *
 * Loosening `maxEdits` would fix them and break everything else ("rice" →
 * "nice", "roti" → "raita"). So this is a separate tier with a different
 * ruler: spell both words the way they sound, then measure with vowels
 * counting half. Vowels are what transliteration disagrees about; consonants
 * are what distinguishes one food from another.
 */
const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/**
 * A spelling-neutral form of a Latin-script word.
 *
 *   paneer / panir / panner  → panir
 *   chowmein / chaumin       → çoumein / çaumin   (one vowel apart)
 *   saffron / safron         → safron
 *   kitchen / kichen         → kiçen
 *
 * Returns "" for anything with no Latin letters (Devanagari input), which the
 * phonetic tier then simply skips — there is no transliteration to undo.
 */
function phoneticKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  // Digraphs first, longest first. "ç" is a placeholder for the ch sound so the
  // bare-c rule below cannot eat it.
  w = w
    .replace(/tch/g, "ç")
    .replace(/ch/g, "ç")
    .replace(/sh/g, "s")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/([kgbdtj])h/g, "$1") // kh gh bh dh th jh: aspiration is spelled or not
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "j")
    .replace(/c/g, "k")
    .replace(/ç/g, "c")
    // "ee" is how Hindi long-i is usually written, "oo" long-u.
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    // w before a vowel is a v (wada/vada, halwa/halva); elsewhere it is the
    // tail of a vowel (chow-mein), and is written as one.
    .replace(/w(?=[aeiou])/g, "v")
    .replace(/w/g, "u");
  // A silent/aspirate h anywhere but the start: dahi/dai, mohan/moan.
  w = w[0] + w.slice(1).replace(/h/g, "");
  // Doubled letters are spelling, not sound: saffron/safron, tikka/tika.
  return w.replace(/(.)\1+/g, "$1");
}

/**
 * Weighted optimal-string-alignment distance over phonetic keys: a vowel
 * inserted, deleted or swapped for another vowel costs half; anything touching
 * a consonant costs one. Bails out once a whole row is over budget.
 */
function phoneticDistance(a: string, b: string, budget: number): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  const ins = (c: string) => (VOWELS.has(c) ? 0.5 : 1);
  const sub = (x: string, y: string) =>
    x === y ? 0 : VOWELS.has(x) && VOWELS.has(y) ? 0.5 : 1;

  let prev2: number[] = [];
  let prev: number[] = new Array(n + 1);
  prev[0] = 0;
  for (let j = 1; j <= n; j++) prev[j] = prev[j - 1] + ins(b[j - 1]);

  for (let i = 1; i <= m; i++) {
    const curr: number[] = new Array(n + 1);
    curr[0] = prev[0] + ins(a[i - 1]);
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      let v = Math.min(
        prev[j] + ins(a[i - 1]),
        curr[j - 1] + ins(b[j - 1]),
        prev[j - 1] + sub(a[i - 1], b[j - 1])
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > budget) return Infinity;
    prev2 = prev;
    prev = curr;
  }
  return prev[n];
}

/**
 * Phonetic budget by key length. Three letters and under must sound identical
 * ("dal"/"daal" yes, "egg"/"aag" no). Four gets one vowel's worth — enough for
 * "piza", not enough for "roti"→"raita" (a vowel swap AND an extra vowel).
 */
function phoneticBudget(len: number): number {
  if (len <= 3) return 0;
  if (len === 4) return 0.5;
  if (len <= 6) return 1;
  return 1.5;
}

/**
 * Do these two words plausibly sound the same? Same first sound is required —
 * people misspell the middle of a word, rarely its start — and it is the cheap
 * guard that keeps "rice" away from "nice" under any budget.
 */
/** Keys are recomputed for every vocabulary word on every new token; cache them. */
const KEY_CACHE = new Map<string, string>();

function cachedKey(word: string): string {
  let k = KEY_CACHE.get(word);
  if (k === undefined) {
    k = phoneticKey(word);
    // Bounded by the catalog's vocabulary plus what customers type; cleared
    // wholesale rather than LRU'd because it only exists to save a regex pass.
    if (KEY_CACHE.size > 20000) KEY_CACHE.clear();
    KEY_CACHE.set(word, k);
  }
  return k;
}

export function soundsLike(typed: string, word: string): boolean {
  const a = cachedKey(typed);
  const b = cachedKey(word);
  if (!a || !b) return false;
  if (a === b) return true;
  const firstOk = a.startsWith(b[0]) || (VOWELS.has(a[0]) && VOWELS.has(b[0]));
  if (!firstOk) return false;
  const budget = phoneticBudget(Math.min(a.length, b.length));
  if (budget === 0) return false;
  return phoneticDistance(a, b, budget) <= budget;
}

const PHONETIC_CACHE = new WeakMap<Set<string>, Map<string, string[]>>();

/**
 * Catalog words that sound like this token. Same shape and memoisation as
 * `fuzzyVariants`; the caller decides whether to use them (they are a last
 * resort — see `searchDishes`).
 */
function phoneticVariants(token: string, vocabulary: Set<string>): string[] {
  let cache = PHONETIC_CACHE.get(vocabulary);
  if (!cache) {
    cache = new Map();
    PHONETIC_CACHE.set(vocabulary, cache);
  }
  const hit = cache.get(token);
  if (hit) return hit;

  const out: string[] = [];
  if (phoneticKey(token)) {
    for (const word of vocabulary) {
      if (word === token) continue;
      if (soundsLike(token, word)) out.push(word);
    }
  }
  cache.set(token, out);
  return out;
}

/**
 * Loose word match for places that have no vocabulary to expand against (the
 * menu-less shop fallback in `groupByShop`): every word of `hay` is tried as a
 * typo target for `token`, by edit distance and then by sound.
 */
export function looselyContains(hay: string, token: string): boolean {
  const budget = maxEdits(token.length);
  for (const word of hay.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (word.startsWith(token)) return true;
    if (budget > 0 && withinEdits(token, word, budget)) return true;
    if (soundsLike(token, word)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Query expansion
 * ------------------------------------------------------------------ */

export interface ExpandedToken {
  /** As typed. */
  token: string;
  /** Same food, different name — full credit; these are curated, not guessed. */
  aliases: string[];
  /**
   * Catalog words spelled differently but pronounced the SAME ("panir" →
   * paneer: identical phonetic key). A transliteration, not a typo — so it
   * ranks above an edit-distance guess, which is how "panir" used to land on
   * "pani" (one letter off) instead of paneer.
   */
  homophones: string[];
  /** Probably the same word misspelled — scored below an alias. */
  fuzzy: string[];
  /**
   * Catalog words that SOUND like this token ("panir" → paneer, "safran" →
   * saffron). Weakest name tier; `searchDishes` only keeps it for a token that
   * nothing stronger matched, so it can never crowd out a real hit.
   */
  phonetic: string[];
  /** Attribute words this token implies, e.g. spicy → chilli, schezwan. */
  intent: string[];
  /** True when the token is only an attribute and names no dish. */
  intentOnly: boolean;
}

export interface ExpandedQuery {
  tokens: ExpandedToken[];
  /** Filters the query itself asked for — "veg snacks", "cheap momos". */
  impliedVeg: boolean;
  impliedMaxPrice: number | null;
  /** True when every word was a stopword or filler. */
  empty: boolean;
}

/**
 * Turn what was typed into what was meant.
 *
 * Order matters: a word is looked up as a concept first, then as an attribute,
 * and only then handed to edit-distance. So "sweet" resolves through the sweets
 * concept and the sweet intent rather than fuzzing into "sweat".
 */
export function expandQuery(
  tokens: string[],
  vocabulary: Set<string>
): ExpandedQuery {
  const out: ExpandedToken[] = [];
  let impliedVeg = false;
  let impliedMaxPrice: number | null = null;

  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;

    const aliases = aliasesFor(token);
    const intentDef = INTENTS[token];
    const intent = intentDef?.expands ?? [];

    if (intentDef?.veg) impliedVeg = true;
    if (intentDef?.maxPrice != null) {
      impliedMaxPrice =
        impliedMaxPrice == null
          ? intentDef.maxPrice
          : Math.min(impliedMaxPrice, intentDef.maxPrice);
    }

    // Always. This used to skip edit-distance whenever the catalog already
    // contained the word as typed, as an optimisation — and that defeated the
    // feature outright in the case it exists for: the catalog holds BOTH
    // spellings. "Vanilla" appears (on a closed cake shop's menu) so the check
    // said "known", and the open shop's "Vanila Shake" was never reached. A
    // word being present somewhere says nothing about whether its misspellings
    // should also match. Memoised below, so the scan is paid once per token.
    const sounds = phoneticVariants(token, vocabulary);
    const key = phoneticKey(token);
    const homophones = key ? sounds.filter((w) => cachedKey(w) === key) : [];
    const fuzzy = fuzzyVariants(token, vocabulary).filter(
      (w) => !homophones.includes(w)
    );

    out.push({
      token,
      aliases,
      homophones,
      fuzzy,
      phonetic: sounds.filter(
        (w) => !fuzzy.includes(w) && !homophones.includes(w)
      ),
      intent,
      // "cheap" on its own is a filter, not a thing to match against a name.
      intentOnly: Boolean(intentDef) && aliases.length === 0 && intent.length === 0,
    });
  }

  return {
    tokens: out,
    impliedVeg,
    impliedMaxPrice,
    empty: out.length === 0,
  };
}

/**
 * Every word in the catalog — dish names, categories and shop names — for
 * fuzzy and phonetic matching to aim at.
 *
 * Built once per index by the caller and handed in — rebuilding it per query
 * would put an 800-word scan on every keystroke.
 */
export function buildVocabulary(
  entries: Iterable<{ name: string; category: string; shop?: string }>
): Set<string> {
  const vocab = new Set<string>();
  for (const e of entries) {
    // The shop's name too. It used to be dish name and category only, so a
    // misspelled RESTAURANT name had nothing to be corrected towards: "Safron"
    // found zero results with "Saffron Kitchen" open in town.
    for (const source of [e.name, e.category, e.shop ?? ""]) {
      for (const w of source.split(/[^\p{L}\p{N}]+/u)) {
        if (w.length > 2) vocab.add(w.toLowerCase());
      }
    }
  }
  return vocab;
}
