import type { Address, Banner, Order, Restaurant } from "@/types";

/* ============================================================
   Static mock data — Phase 1 (UI/UX only, no backend).

   Every export here is a DEMO FIXTURE. Each is reachable only behind
   `!isSupabaseConfigured`, which throws at boot in a production build (see
   supabase/config.ts) — so none of it can be served to a real customer. The two
   exports that were genuinely live have moved to `lib/taxonomy.ts`; nothing in
   this file should be imported without a demo-mode guard above it.
   Food photography "supplies the color". Images are served from
   Unsplash; the per-restaurant gradient tint stays underneath as the
   backdrop while each photo loads.
   ============================================================ */

/**
 * The mock catalog was authored against Pexels photo ids. Rather than rewrite
 * every call site, map each legacy id to a verified Unsplash slug so the mock
 * and the seeded database share one image source (images.unsplash.com, allowed
 * by the CSP). Banners/store tiles that aren't dishes map to a fitting non-food
 * photo (pharmacy, courier). Unknown ids fall back to a generic food shot.
 */
const UNSPLASH_BY_LEGACY_ID: Record<number, string> = {
  208512: "photo-1587854692152-cbe660dbde88", // pharmacy banner
  291528: "photo-1668236543090-82eba5ee5976", // dosa
  376464: "photo-1544145945-f90425340c7e", // beverage
  461198: "photo-1601050690597-df0568f70950", // bread / naan
  616404: "photo-1585032226651-759b368d7246", // chinese
  825661: "photo-1601050690117-94f5f6fa8bd7", // samosa
  958545: "photo-1666190092159-3171cf0fbb12", // samosa / starters
  1109197: "photo-1610057099443-fde8c4d50f91", // chicken
  1146760: "photo-1513104890138-7c749659a591", // pizza
  1213710: "photo-1585937421612-70a008356fbe", // thali
  1279330: "photo-1631452180519-c014fe946bc7", // paneer
  1639557: "photo-1568901346375-23c9450c58cd", // burger
  1640777: "photo-1512621776951-a57141f2eefd", // salad
  1907098: "photo-1476224203421-9ac39bcb3327", // generic spread
  2280545: "photo-1571091718767-18b5b1457add", // burger
  2456435: "photo-1551024506-0bccd828d307", // dessert
  3026808: "photo-1574071318508-1cdbab80d002", // pizza
  4110251: "photo-1578985545062-69928b1d9587", // gelato / bakery
  4198015: "photo-1526367790999-0150786686a2", // pick & drop / courier
  4391470: "photo-1576602976047-174e57a47881", // pharmacy banner
  5175551: "photo-1569718212165-3a8278d5f624", // chinese
  5410400: "photo-1604382354936-07c5d9983bd3", // pizza
  6412834: "photo-1630383249896-424e482df921", // dosa
  7625056: "photo-1563379091339-03b21ab4a4f8", // biryani
  9095802: "photo-1461023058943-07fcbe16d735", // beverage
  9797126: "photo-1567188040759-fb8a883dc6d8", // paneer
  12737656: "photo-1631515243349-e0cb75fb8d3a", // biryani
  15913441: "photo-1578985545062-69928b1d9587", // dessert
};

const DEFAULT_UNSPLASH = "photo-1504674900247-0877df9cc836";

/** Build an Unsplash CDN image URL from the legacy id used across the mock data. */
const px = (id: number, w = 800) =>
  `https://images.unsplash.com/${UNSPLASH_BY_LEGACY_ID[id] ?? DEFAULT_UNSPLASH}?w=${w}&q=80&auto=format&fit=crop`;

/*
 * `CATEGORIES` and `STORE_CATEGORIES` used to be declared here. They have moved
 * to `lib/taxonomy.ts`, because they were the only things in this file that are
 * not mock data: everything below is a demo fixture behind
 * `!isSupabaseConfigured`, while those two rendered for every customer on every
 * visit regardless of backend. Keeping live taxonomy in a file headed "Static
 * mock data" made the fixtures look load-bearing and the taxonomy look
 * disposable, which is backwards.
 */

export const RESTAURANTS: Restaurant[] = [
  {
    slug: "saffron-kitchen",
    name: "Saffron Kitchen",
    tagline: "Slow-cooked biryanis & royal curries",
    cuisines: ["North Indian", "Biryani"],
    rating: 4.6,
    ratingCount: 1200,
    etaMin: 22,
    etaMax: 28,
    priceTier: 2,
    costForTwo: 480,
    distanceKm: 1.4,
    offer: "30% OFF up to ₹120",
    promoted: true,
    open: true,
    accentTint: "linear-gradient(135deg,#f6c453,#e8552d)",
    image: px(958545),
    categories: ["Popular", "Biryani", "Breads", "Curries"],
    menu: [
      {
        id: "sk-1",
        image: px(12737656),
        name: "Hyderabadi Dum Biryani",
        description: "Slow-cooked basmati, saffron, tender chicken",
        price: 320,
        category: "Biryani",
        veg: false,
        popular: true,
        bestseller: true,
      },
      {
        id: "sk-2",
        image: px(9797126),
        name: "Paneer Butter Masala",
        description: "Creamy tomato gravy, house paneer",
        price: 260,
        category: "Curries",
        veg: true,
        popular: true,
      },
      {
        id: "sk-3",
        image: px(461198),
        name: "Garlic Naan",
        description: "Tandoor-baked, fresh garlic & butter",
        price: 70,
        category: "Breads",
        veg: true,
      },
      {
        id: "sk-4",
        image: px(7625056),
        name: "Veg Dum Biryani",
        description: "Fragrant rice, seasonal vegetables, mint",
        price: 240,
        category: "Biryani",
        veg: true,
      },
      {
        id: "sk-5",
        image: px(1109197),
        name: "Butter Chicken",
        description: "Charred tandoori chicken, silky makhani gravy",
        price: 340,
        category: "Curries",
        veg: false,
        popular: true,
      },
      {
        id: "sk-6",
        image: px(15913441),
        name: "Gulab Jamun (2 pc)",
        description: "Warm, syrup-soaked, cardamom",
        price: 90,
        category: "Popular",
        veg: true,
        soldOut: true,
      },
    ],
  },
  {
    slug: "burger-republic",
    name: "Burger Republic",
    tagline: "Smash burgers & loaded fries",
    cuisines: ["Fast Food"],
    rating: 4.4,
    ratingCount: 860,
    etaMin: 18,
    etaMax: 24,
    priceTier: 2,
    costForTwo: 400,
    distanceKm: 2.1,
    offer: "TODAY · 30% OFF",
    promoted: true,
    open: true,
    accentTint: "linear-gradient(135deg,#f9a03f,#e8552d)",
    image: px(1639557),
    categories: ["Popular", "Burgers", "Sides", "Shakes"],
    menu: [
      {
        id: "br-1",
        image: px(2280545),
        name: "Double Smash Cheeseburger",
        description: "Two patties, aged cheddar, house sauce",
        price: 280,
        category: "Burgers",
        veg: false,
        bestseller: true,
        popular: true,
      },
      {
        id: "br-2",
        image: px(1639557),
        name: "Paneer Zinger Burger",
        description: "Crispy paneer, slaw, chipotle mayo",
        price: 220,
        category: "Burgers",
        veg: true,
        popular: true,
      },
      {
        id: "br-3",
        image: px(1146760),
        name: "Loaded Peri Fries",
        description: "Peri-peri, cheese, jalapeño",
        price: 160,
        category: "Sides",
        veg: true,
      },
      {
        id: "br-4",
        image: px(3026808),
        name: "Belgian Chocolate Shake",
        description: "Thick, rich, real cocoa",
        price: 180,
        category: "Shakes",
        veg: true,
      },
    ],
  },
  {
    slug: "green-bowl",
    name: "Green Bowl",
    tagline: "Salads, grain bowls & cold-press",
    cuisines: ["Healthy"],
    rating: 4.7,
    ratingCount: 540,
    etaMin: 20,
    etaMax: 26,
    priceTier: 2,
    costForTwo: 450,
    distanceKm: 1.8,
    open: true,
    accentTint: "linear-gradient(135deg,#7bc47f,#2e7d5b)",
    image: px(1213710),
    categories: ["Popular", "Bowls", "Salads", "Juices"],
    menu: [
      {
        id: "gb-1",
        image: px(5175551),
        name: "High-Protein Chicken Bowl",
        description: "Grilled chicken, quinoa, avocado, greens",
        price: 320,
        category: "Bowls",
        veg: false,
        bestseller: true,
        popular: true,
      },
      {
        id: "gb-2",
        image: px(1640777),
        name: "Buddha Bowl",
        description: "Chickpea, roasted veg, tahini",
        price: 280,
        category: "Bowls",
        veg: true,
        popular: true,
      },
      {
        id: "gb-3",
        image: px(616404),
        name: "Cold-Press Green Juice",
        description: "Spinach, apple, ginger, lime",
        price: 140,
        category: "Juices",
        veg: true,
      },
    ],
  },
  {
    slug: "napoli-woodfire",
    name: "Napoli Woodfire",
    tagline: "Neapolitan wood-fired pizza",
    cuisines: ["Italian"],
    rating: 4.5,
    ratingCount: 970,
    etaMin: 28,
    etaMax: 35,
    priceTier: 3,
    costForTwo: 700,
    distanceKm: 3.4,
    offer: "Free garlic bread over ₹499",
    open: true,
    accentTint: "linear-gradient(135deg,#e86a4b,#b0341a)",
    image: px(825661),
    categories: ["Popular", "Pizza", "Pasta", "Starters"],
    menu: [
      {
        id: "np-1",
        image: px(376464),
        name: "Margherita DOP",
        description: "San Marzano, fior di latte, basil",
        price: 420,
        category: "Pizza",
        veg: true,
        bestseller: true,
        popular: true,
      },
      {
        id: "np-2",
        image: px(9095802),
        name: "Diavola",
        description: "Spicy salami, chilli, mozzarella",
        price: 520,
        category: "Pizza",
        veg: false,
        popular: true,
      },
      {
        id: "np-3",
        image: px(1279330),
        name: "Truffle Mushroom Pasta",
        description: "Tagliatelle, cream, truffle oil",
        price: 480,
        category: "Pasta",
        veg: true,
      },
    ],
  },
  {
    slug: "dragon-wok",
    name: "Dragon Wok",
    tagline: "Indo-Chinese, tossed to order",
    cuisines: ["Chinese"],
    rating: 4.2,
    ratingCount: 1500,
    etaMin: 25,
    etaMax: 32,
    priceTier: 2,
    costForTwo: 500,
    distanceKm: 2.7,
    open: false,
    accentTint: "linear-gradient(135deg,#c0392b,#7a1f16)",
    image: px(1907098),
    categories: ["Popular", "Starters", "Noodles", "Rice"],
    menu: [
      {
        id: "dw-1",
        image: px(2456435),
        name: "Chilli Garlic Noodles",
        description: "Wok-tossed, scallion, house chilli oil",
        price: 220,
        category: "Noodles",
        veg: true,
        popular: true,
      },
      {
        id: "dw-2",
        image: px(5410400),
        name: "Chicken Manchurian",
        description: "Crispy, tangy, garlic-forward",
        price: 260,
        category: "Starters",
        veg: false,
        bestseller: true,
      },
    ],
  },
  {
    slug: "sweet-carousel",
    name: "Sweet Carousel",
    tagline: "Desserts, bakes & gelato",
    cuisines: ["Desserts"],
    rating: 4.8,
    ratingCount: 430,
    etaMin: 15,
    etaMax: 22,
    priceTier: 2,
    costForTwo: 350,
    distanceKm: 1.1,
    offer: "Buy 1 Get 1 on gelato",
    open: true,
    accentTint: "linear-gradient(135deg,#f4a6c0,#c0568a)",
    image: px(4110251),
    categories: ["Popular", "Cakes", "Gelato", "Bakes"],
    menu: [
      {
        id: "sc-1",
        image: px(291528),
        name: "Molten Chocolate Cake",
        description: "Warm centre, vanilla bean scoop",
        price: 190,
        category: "Cakes",
        veg: true,
        bestseller: true,
        popular: true,
      },
      {
        id: "sc-2",
        image: px(6412834),
        name: "Pistachio Gelato",
        description: "Sicilian pistachio, double churned",
        price: 160,
        category: "Gelato",
        veg: true,
      },
    ],
  },
];

export function getRestaurant(slug: string): Restaurant | undefined {
  return RESTAURANTS.find((r) => r.slug === slug);
}

/* ---------- Orders ---------- */
export const ACTIVE_ORDER: Order = {
  id: "DLG-4821",
  restaurantSlug: "saffron-kitchen",
  restaurantName: "Saffron Kitchen",
  status: "ON_THE_WAY",
  placedAt: "Today, 8:24 PM",
  etaMinutes: 12,
  total: 785,
  lines: [
    { itemId: "sk-1", name: "Hyderabadi Dum Biryani", qty: 1, price: 320 },
    { itemId: "sk-3", name: "Garlic Naan", qty: 2, price: 70 },
    { itemId: "sk-2", name: "Paneer Butter Masala", qty: 1, price: 260 },
  ],
  rider: {
    name: "Shantanu G.",
    id: "DLGR4821",
    rating: 4.9,
    vehicle: "Bike",
    phone: "+91 98••• ••210",
  },
};

export const PAST_ORDERS: Order[] = [
  {
    id: "DLG-4790",
    restaurantSlug: "burger-republic",
    restaurantName: "Burger Republic",
    status: "DELIVERED",
    placedAt: "Fri, 9:10 PM",
    total: 640,
    lines: [
      { itemId: "br-1", name: "Double Smash Cheeseburger", qty: 2, price: 280 },
      { itemId: "br-3", name: "Loaded Peri Fries", qty: 1, price: 160 },
    ],
  },
  {
    id: "DLG-4712",
    restaurantSlug: "green-bowl",
    restaurantName: "Green Bowl",
    status: "DELIVERED",
    placedAt: "Wed, 1:32 PM",
    total: 460,
    lines: [
      { itemId: "gb-1", name: "High-Protein Chicken Bowl", qty: 1, price: 320 },
      { itemId: "gb-3", name: "Cold-Press Green Juice", qty: 1, price: 140 },
    ],
  },
  {
    id: "DLG-4655",
    restaurantSlug: "saffron-kitchen",
    restaurantName: "Saffron Kitchen",
    status: "DELIVERED",
    placedAt: "Last Fri, 8:40 PM",
    total: 720,
    lines: [
      { itemId: "sk-1", name: "Hyderabadi Dum Biryani", qty: 2, price: 320 },
    ],
  },
];

export const ADDRESSES: Address[] = [
  {
    id: "a1",
    label: "Home",
    line: "42,Ward NO 07, Mohhbtta Road, Bemetara, Chhattisgarh 491335",
    isDefault: true,
  },
  {
    id: "a2",
    label: "Work",
    line: "2nd Floor, Apex Tower, Bemetara, Chhattisgarh 491335",
  },
];

// Obviously fake on purpose. This is rendered whenever Supabase is unconfigured,
// so anything realistic here is a real person's details served to strangers the
// moment a key goes missing.
export const USER = {
  name: "Demo Customer",
  phone: "+91 90000 00000",
  initials: "DC",
  memberSince: "2024",
  orders: 47,
};

/**
 * Demo campaigns for the home carousel. In production these are rows the Admin
 * Panel writes; here they stand in whenever Supabase is unconfigured so the
 * carousel has something to show. They deliberately span every campaign shape
 * the system supports — internal feature promos and a paid sponsored slot.
 */
export const BANNERS: Banner[] = [
  {
    id: "bn-grocery",
    name: "Grocery launch",
    headline: "Groceries in minutes",
    description: "Fresh produce, daily staples & kirana — delivered to your door.",
    ctaLabel: "Shop Now",
    kind: "internal",
    status: "active",
    target: { type: "grocery" },
    placements: ["home_hero"],
    priority: 100,
    displayOrder: 1,
    autoSlideMs: 4500,
    imageUrl: px(4198015),
    tint: "linear-gradient(135deg,#17b26a,#0e8f57)",
    glyph: "🛒",
  },
  {
    id: "bn-pickdrop",
    name: "Pick & Drop",
    headline: "Pick & Drop, anywhere",
    description: "Forgot something? Send a rider to pick up and drop across town.",
    ctaLabel: "Book Now",
    kind: "internal",
    status: "active",
    target: { type: "pick_drop" },
    placements: ["home_hero"],
    priority: 90,
    displayOrder: 2,
    autoSlideMs: 4500,
    imageUrl: px(4391470),
    tint: "linear-gradient(135deg,#f2a71b,#d98600)",
    glyph: "🛵",
  },
  {
    id: "bn-pharmacy",
    name: "Pharmacy",
    headline: "Medicines at your door",
    description: "Upload a prescription and get medicines delivered discreetly.",
    ctaLabel: "Explore",
    kind: "internal",
    status: "active",
    target: { type: "pharmacy" },
    placements: ["home_hero"],
    priority: 80,
    displayOrder: 3,
    autoSlideMs: 4500,
    imageUrl: px(208512),
    tint: "linear-gradient(135deg,#3b82f6,#1d4ed8)",
    glyph: "💊",
  },
  {
    id: "bn-monsoon",
    name: "Monsoon festival offer",
    headline: "Monsoon feast · 40% OFF",
    description: "Rainy-day cravings sorted. Limited-time offers across kitchens.",
    ctaLabel: "Order Now",
    kind: "internal",
    status: "active",
    target: { type: "food" },
    placements: ["home_hero"],
    priority: 70,
    displayOrder: 4,
    autoSlideMs: 4500,
    imageUrl: px(1640777),
    tint: "linear-gradient(135deg,#f6c453,#e8552d)",
    glyph: "🎉",
  },
  {
    id: "bn-sponsored-burger",
    name: "Burger Republic (paid)",
    headline: "Burger Republic · 30% OFF today",
    description: "Flame-grilled smash burgers. Today only, free delivery over ₹299.",
    ctaLabel: "Order Now",
    kind: "sponsored",
    status: "active",
    target: { type: "restaurant", value: "burger-republic" },
    placements: ["home_hero"],
    priority: 60,
    displayOrder: 5,
    autoSlideMs: 4500,
    imageUrl: px(1639557),
    tint: "linear-gradient(135deg,#e5352b,#b31217)",
    glyph: "🍔",
    sponsorName: "Burger Republic",
  },
];
