/**
 * Matching a dish name to a photo.
 *
 * The requirement is one sentence long and deceptively hard: "Chicken Biryani",
 * "Egg Biryani", "Veg Biryani" and "Mutton Biryani" must each find their own
 * photo, never each other's. `ILIKE '%biryani%'` fails it outright. Embedding
 * similarity fails it in a subtler and worse way — it will happily rank Veg
 * Biryani second for "Chicken Biryani", because those two names ARE similar,
 * and a "second best" photo is exactly what must never be attached.
 *
 * So the decisive rule here is not similarity, it is CONFLICT. A dish name is
 * split into two kinds of word:
 *
 *   the DISH      biryani, tikka, dosa, paneer  — what it is
 *   the QUALIFIER chicken, egg, veg, mutton     — which one it is
 *
 * Two names may only match if their qualifiers agree. Chicken against Veg is
 * not a weak match, it is a refusal — attaching a photo of meat to a vegetarian
 * dish is worse than attaching no photo at all, and in a country where a green
 * dot is a religious and dietary commitment it is not a cosmetic bug. Similarity
 * then ranks whatever survives that gate.
 *
 * This is pure, deterministic, needs no API key and costs nothing per call.
 * It is also the honest description: a domain-tuned lexical matcher with
 * synonym expansion, not a neural embedding. It behaves *better* than an
 * embedding on the stated requirement, and where it is unsure it says so
 * (`confident: false`) so the UI offers a choice instead of guessing.
 *
 * Client-safe: the picker scores candidates in the browser as you type.
 */

/* ------------------------------------------------------------------
 * Vocabulary.
 * ------------------------------------------------------------------ */

/**
 * Words that mean the same thing. Every alias maps to one canonical token, so
 * "murgh", "chicken" and "chikan" (a very common menu typo) all become
 * "chicken" before anything is compared.
 */
const SYNONYMS: Record<string, string> = {
  // proteins
  murgh: "chicken", chikan: "chicken", chiken: "chicken", chx: "chicken",
  mutton: "mutton", lamb: "mutton", goat: "mutton", gosht: "mutton",
  bhuna: "mutton",
  anda: "egg", eggs: "egg", omlet: "egg", omelette: "egg", omelet: "egg",
  prawn: "prawn", prawns: "prawn", shrimp: "prawn", jhinga: "prawn",
  fish: "fish", machli: "fish", macher: "fish", pomfret: "fish",
  crab: "crab", squid: "squid", calamari: "squid",
  keema: "keema", kheema: "keema", mince: "keema",

  // vegetarian markers
  veg: "veg", vegetable: "veg", vegetables: "veg", vegetarian: "veg",
  sabzi: "veg", subzi: "veg", sabji: "veg",
  paneer: "paneer", cottage: "paneer",
  mushroom: "mushroom", khumb: "mushroom",
  aloo: "potato", alu: "potato", potato: "potato",
  gobi: "cauliflower", gobhi: "cauliflower", cauliflower: "cauliflower",
  soya: "soya", soy: "soya",
  jain: "jain",

  // dishes and forms
  biriyani: "biryani", biryani: "biryani", biriani: "biryani",
  briyani: "biryani", dum: "biryani",
  tikka: "tikka", tika: "tikka",
  masala: "masala", masaala: "masala",
  curry: "curry", kari: "curry", gravy: "curry",
  kebab: "kebab", kabab: "kebab", kabob: "kebab", seekh: "seekh",
  roll: "roll", frankie: "roll", wrap: "roll",
  dosa: "dosa", dosai: "dosa",
  idli: "idli", idly: "idli",
  vada: "vada", wada: "vada",
  uttapam: "uttapam", uthappam: "uttapam",
  paratha: "paratha", parantha: "paratha", parotta: "paratha",
  naan: "naan", nan: "naan",
  roti: "roti", chapati: "roti", chapathi: "roti", phulka: "roti",
  pulao: "pulao", pulav: "pulao", pilaf: "pulao",
  fry: "fried", fried: "fried", crispy: "fried",
  tandoori: "tandoori", tanduri: "tandoori",
  manchurian: "manchurian", manchuria: "manchurian",
  noodles: "noodles", noodle: "noodles", chowmein: "noodles",
  chow: "noodles", hakka: "noodles",
  momo: "momo", momos: "momo", dumpling: "momo", dumplings: "momo",
  thali: "thali", combo: "combo", meal: "combo",
  shake: "shake", milkshake: "shake", lassi: "lassi",
  juice: "juice", soda: "soda", cola: "soda",
  tea: "tea", chai: "tea", coffee: "coffee",
  icecream: "icecream", ice: "icecream", kulfi: "kulfi",
  gulab: "gulab", jamun: "gulab",
};

/**
 * Words carrying no information about which photo is right. Dropped before
 * scoring so "Special Chicken Biryani (Full)" and "Chicken Biryani" match.
 */
const STOPWORDS = new Set([
  "special", "spl", "our", "the", "a", "an", "and", "with", "in", "of", "for",
  "style", "homestyle", "house", "chef", "signature", "authentic", "classic",
  "famous", "best", "fresh", "hot", "new", "regular", "plain", "simple",
  "full", "half", "quarter", "plate", "piece", "pieces", "pc", "pcs",
  "single", "double", "large", "medium", "small", "mini", "jumbo", "size",
  "serve", "serves", "portion", "gm", "gms", "ml", "ltr", "kg",
  "rs", "inr", "price", "no", "nos", "item", "dish", "food",
]);

/**
 * Qualifier groups. Two names conflict when they pick DIFFERENT members of the
 * same group — chicken vs mutton, veg vs egg. Picking nothing from a group is
 * not a conflict: "Biryani" is compatible with "Chicken Biryani", it is just a
 * weaker match.
 *
 * Diet and protein are separate groups because they answer different
 * questions ("may I eat this at all" vs "which meat"), and a name can be
 * specific about one and silent about the other.
 */
const QUALIFIER_GROUPS: Record<string, readonly string[]> = {
  protein: [
    "chicken", "mutton", "egg", "fish", "prawn", "crab", "squid", "keema",
    "paneer", "mushroom", "potato", "cauliflower", "soya", "veg",
  ],
  form: [
    "biryani", "pulao", "curry", "tikka", "kebab", "seekh", "roll", "dosa",
    "idli", "vada", "uttapam", "paratha", "naan", "roti", "noodles", "momo",
    "manchurian", "fried", "tandoori", "thali", "combo", "shake", "lassi",
    "juice", "soda", "tea", "coffee", "icecream", "kulfi", "gulab",
  ],
};

/** Tokens that make a dish vegetarian, and those that make it not. */
const VEG_TOKENS = new Set([
  "veg", "paneer", "mushroom", "potato", "cauliflower", "soya", "jain",
]);
const NONVEG_TOKENS = new Set([
  "chicken", "mutton", "egg", "fish", "prawn", "crab", "squid", "keema",
]);

/* ------------------------------------------------------------------
 * Tokenising.
 * ------------------------------------------------------------------ */

/**
 * A dish name reduced to its meaningful, canonical words.
 *
 * Order is deliberately discarded — "Biryani Chicken" and "Chicken Biryani"
 * are the same dish, and menus are written both ways.
 */
export function tokenize(raw: string): string[] {
  const cleaned = raw
    .toLowerCase()
    // Strip anything that isn't a letter or digit, including the brackets,
    // slashes and hyphens menus are full of. Digits survive because "65" in
    // "Chicken 65" is the name of the dish.
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!cleaned) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of cleaned.split(/\s+/)) {
    if (word.length < 2 && !/^\d+$/.test(word)) continue;
    if (STOPWORDS.has(word)) continue;
    const canonical = SYNONYMS[word] ?? word;
    if (STOPWORDS.has(canonical)) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * The keyword array stored on a library row. Same tokens the matcher compares,
 * so the database filter and the ranking can never fall out of step.
 */
export function keywordsFor(title: string, tags: string[] = []): string[] {
  const set = new Set(tokenize(title));
  for (const tag of tags) for (const t of tokenize(tag)) set.add(t);
  return [...set];
}

/** Is this dish vegetarian, judged from its name alone? null = can't tell. */
export function vegFromTokens(tokens: string[]): boolean | null {
  if (tokens.some((t) => NONVEG_TOKENS.has(t))) return false;
  if (tokens.some((t) => VEG_TOKENS.has(t))) return true;
  return null;
}

/* ------------------------------------------------------------------
 * Scoring.
 * ------------------------------------------------------------------ */

function qualifiersIn(tokens: string[], group: readonly string[]): string[] {
  return tokens.filter((t) => group.includes(t));
}

/**
 * Do these two names disagree about something that matters?
 *
 * Only a genuine disagreement counts. If one side is silent about the protein,
 * there is nothing to disagree with — that is a weaker match, handled by the
 * score, not a refusal.
 */
function conflicts(a: string[], b: string[]): boolean {
  for (const group of Object.values(QUALIFIER_GROUPS)) {
    const qa = qualifiersIn(a, group);
    const qb = qualifiersIn(b, group);
    if (qa.length === 0 || qb.length === 0) continue;
    // Overlap of at least one member is agreement. "Chicken Egg Roll" against
    // "Egg Roll" shares `egg`, so it is not a conflict.
    if (!qa.some((t) => qb.includes(t))) return true;
  }

  // Veg vs non-veg is checked on top of the protein group, because a name can
  // be vegetarian without naming a protein at all ("Jain Thali").
  const va = vegFromTokens(a);
  const vb = vegFromTokens(b);
  if (va !== null && vb !== null && va !== vb) return true;

  return false;
}

export interface MatchCandidate {
  id: string;
  title: string;
  imageUrl: string;
  keywords: string[];
  veg?: boolean | null;
}

export interface ScoredCandidate<T extends MatchCandidate = MatchCandidate> {
  candidate: T;
  /** 0–1. 1 means every meaningful word agrees. */
  score: number;
  /** True when the score is high enough to attach without asking. */
  confident: boolean;
  /** Why it scored what it did, for the "matched automatically" note. */
  reason: string;
}

/**
 * The bar for attaching a photo on the vendor's behalf.
 *
 * Set where "Chicken Biryani" → "Chicken Biryani" (1.0) and "Chicken Dum
 * Biryani" → "Chicken Biryani" (both tokens shared, 1.0) pass, while "Biryani"
 * → "Chicken Biryani" (0.5, one of two words) does not. A bare "Biryani" is
 * genuinely ambiguous, and the right response to ambiguity is the picker, not
 * a coin toss.
 */
const AUTO_ATTACH_THRESHOLD = 0.72;

/**
 * Score one library photo against a dish name.
 *
 * Weighted Jaccard: shared tokens over all tokens, with qualifier words worth
 * more than form words. "Chicken" is what distinguishes this biryani from that
 * one, so it should dominate; matching only on "biryani" should not.
 */
function scoreCandidate<T extends MatchCandidate>(
  dishTokens: string[],
  candidate: T
): ScoredCandidate<T> {
  const theirs = candidate.keywords.length
    ? candidate.keywords
    : tokenize(candidate.title);

  if (dishTokens.length === 0 || theirs.length === 0) {
    return { candidate, score: 0, confident: false, reason: "No words to compare." };
  }

  if (conflicts(dishTokens, theirs)) {
    return {
      candidate,
      score: 0,
      confident: false,
      reason: "Different kind of dish — not offered.",
    };
  }

  const weightOf = (t: string) =>
    QUALIFIER_GROUPS.protein.includes(t) ? 3 : VEG_TOKENS.has(t) ? 3 : 1;

  const theirSet = new Set(theirs);
  const mineSet = new Set(dishTokens);

  let shared = 0;
  let total = 0;
  for (const t of new Set([...dishTokens, ...theirs])) {
    const w = weightOf(t);
    total += w;
    if (mineSet.has(t) && theirSet.has(t)) shared += w;
  }

  const score = total === 0 ? 0 : shared / total;
  const sharedWords = dishTokens.filter((t) => theirSet.has(t));

  return {
    candidate,
    score,
    confident: score >= AUTO_ATTACH_THRESHOLD,
    reason: sharedWords.length
      ? `Matches on ${sharedWords.join(", ")}.`
      : "No words in common.",
  };
}

/**
 * Rank a set of photos against a dish name, best first.
 *
 * Conflicting photos are dropped entirely rather than ranked last: a list the
 * operator scrolls is a list they can pick the wrong thing from, and "Veg
 * Biryani" should not appear at all when the dish is "Chicken Biryani".
 */
export function rankCandidates<T extends MatchCandidate>(
  dishName: string,
  candidates: T[]
): ScoredCandidate<T>[] {
  const tokens = tokenize(dishName);
  return candidates
    .map((c) => scoreCandidate(tokens, c))
    .filter((s) => s.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      // Deterministic tie-break, so the same dish always gets the same photo
      // rather than whichever the database happened to return first.
      a.candidate.title.localeCompare(b.candidate.title)
    );
}

/**
 * The one photo to attach automatically, or null to leave it to a person.
 *
 * Returns null on a tie at the top even when both are above the bar: two photos
 * that fit equally well means the name does not distinguish them, and picking
 * one is a guess wearing a confident face.
 */
export function bestMatch<T extends MatchCandidate>(
  dishName: string,
  candidates: T[]
): ScoredCandidate<T> | null {
  const ranked = rankCandidates(dishName, candidates);
  const top = ranked[0];
  if (!top?.confident) return null;
  const runnerUp = ranked[1];
  if (runnerUp && Math.abs(runnerUp.score - top.score) < 0.001) return null;
  return top;
}

/**
 * The related photos to SHOW when someone searches "biryani".
 *
 * Deliberately looser than the matcher: a search is a person looking, and
 * showing them the whole biryani family — including the ones the auto-matcher
 * would have refused — is the point of a library. Only exact-opposite diet
 * conflicts are filtered, because nobody searching for a vegetarian dish wants
 * to scroll past meat.
 */
export function searchLibrary<T extends MatchCandidate>(
  query: string,
  candidates: T[],
  opts: { veg?: boolean | null } = {}
): T[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return candidates;

  const wantVeg = opts.veg ?? null;

  const hits = candidates
    .map((c) => {
      const theirs = c.keywords.length ? c.keywords : tokenize(c.title);
      const overlap = tokens.filter((t) => theirs.includes(t)).length;
      // A partial word still finds things: typing "biry" should surface
      // biryani before the user has finished the word.
      const prefix = tokens.some((t) =>
        theirs.some((k) => k.startsWith(t) || t.startsWith(k))
      );
      return { c, overlap, prefix, theirs };
    })
    .filter(({ overlap, prefix, c, theirs }) => {
      if (overlap === 0 && !prefix) return false;
      if (wantVeg === null) return true;
      const theirVeg = c.veg ?? vegFromTokens(theirs);
      return theirVeg === null || theirVeg === wantVeg;
    })
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        a.c.title.length - b.c.title.length ||
        a.c.title.localeCompare(b.c.title)
    );

  return hits.map((h) => h.c);
}
