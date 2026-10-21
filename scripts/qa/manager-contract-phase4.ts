/**
 * Phase 4 fixtures for the manager contract check: vendors, products and the
 * ticket thread, run through the routes' own serialisers. Imported by
 * `manager-contract-emit.ts`, which writes them next to the Phase 3 files.
 */
import {
  buildVendorDetail,
  toReviewItem,
  toTicketSummary,
  toVendorDocument,
  toVendorListItem,
  type TicketRow,
  type VendorDetailRow,
  type VendorListRow,
} from "../../src/lib/ops/vendor-contract";
import { allowedVendorActions } from "../../src/lib/ops/vendor-rules";
import {
  aggregateCategories,
  buildProductInsights,
  toProductDetail,
  toImageReviewItem,
  toProductListItem,
  type ProductRow,
} from "../../src/lib/ops/product-contract";
import { allowedProductActions } from "../../src/lib/ops/product-rules";
import { buildTicketThread } from "../../src/lib/ops/ticket-thread";

const NOW = new Date("2026-10-21T08:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const uuid = (n: number) => `3f2c1a${String(n).padStart(2, "0")}-1111-4222-8333-${String(n).padStart(12, "0")}`;

// ── vendors ──────────────────────────────────────────────────────────────────

const vRow = (n: number, status: string, over: Partial<VendorDetailRow> = {}): VendorDetailRow => ({
  id: uuid(n),
  name: n === 90 ? "Spice Hub" : `Shop ${n}`,
  slug: `shop-${n}`,
  status,
  category: "Restaurant",
  zone_id: uuid(80),
  zone_name: "Bemetara",
  image_url: null,
  rating: "4.36",
  rating_count: 120,
  created_at: ago(60 * 24 * 30),
  status_reason: status === "suspended" ? "Repeated late orders" : null,
  status_changed_at: status === "suspended" ? ago(120) : null,
  description: "North Indian thalis",
  shop_phone: "+919800000001",
  owner_name: "Meena Sahu",
  owner_mobile: "+919800000002",
  owner_email: null,
  address: "Station Road",
  landmark: "Near the post office",
  pincode: "491335",
  lat: 21.7,
  lng: 81.5,
  opening_time: "09:00:00",
  closing_time: "22:30:00",
  weekly_off: ["Monday"],
  closed_until: null,
  delivery_available: true,
  self_pickup: false,
  prep_minutes: 20,
  fssai_number: "12345678901234",
  tc_accepted_at: ago(60 * 24 * 30),
  tc_version: "v1",
  ...over,
});

const vendorRows: VendorListRow[] = [vRow(90, "active"), vRow(91, "pending"), vRow(92, "suspended")];

export const vendorsList = {
  items: vendorRows.map((r, i) =>
    toVendorListItem(r, {
      openState: i === 0 ? "open" : "closed",
      todayOrders: 14 - i,
      pendingDocuments: i,
      openComplaints: i === 0 ? 1 : 0,
    })
  ),
  nextCursor: null,
  counts: { all: 3, pending: 1, active: 1, suspended: 1, rejected: 0, inactive: 0, online: 1 },
};

const ticketRow = (n: number, over: Partial<TicketRow> = {}): TicketRow => ({
  id: uuid(n),
  number: 17,
  subject: "Cold food delivered",
  category: "food_quality",
  priority: "high",
  status: "in_progress",
  requester_role: "customer",
  order_id: uuid(3),
  created_at: ago(90),
  updated_at: ago(80),
  ...over,
});

const staffNames = new Map([[uuid(60), "Ravi Kumar"]]);

const vendorDetailInput = (status: string) => ({
  row: vRow(90, status),
  extras: { openState: "open" as const, todayOrders: 14, pendingDocuments: 1, openComplaints: 1 },
  statusChangedBy: status === "suspended" ? { id: uuid(60), name: "Ravi Kumar" } : null,
  documents: [
    toVendorDocument(
      {
        id: uuid(50), doc_type: "fssai", file_name: "fssai.pdf", status: "verified", remarks: null,
        reviewed_by: uuid(60), reviewed_at: ago(600), created_at: ago(900),
      },
      staffNames
    ),
    toVendorDocument(
      {
        id: uuid(51), doc_type: "bank_proof", file_name: "cheque.jpg", status: null, remarks: null,
        reviewed_by: null, reviewed_at: null, created_at: ago(300),
      },
      staffNames
    ),
  ],
  holidays: [{ starts_on: "2026-11-01", ends_on: "2026-11-02", note: "Diwali" }],
  performance: {
    from: "2026-09-22",
    to: "2026-10-21",
    orders: 412,
    sales: 98_450,
    aov: 239,
    cancellationRate: 0.031,
    rejectionRate: 0.012,
    avgAcceptMinutes: 2.4,
    avgPrepMinutes: 18.5,
    rating: 4.4,
    ratingCount: 120,
    ratingDistribution: { "1": 3, "2": 4, "3": 10, "4": 38, "5": 65 },
  },
  finance: {
    commissionPct: 18,
    commissionGstPct: 18,
    otherChargesPerOrder: 0,
    settlementCycle: "weekly",
    pendingPayment: 12_430,
    recoverable: 0,
    commissionThisPeriod: 17_721,
    settlements: [
      {
        id: uuid(40), periodStart: "2026-10-07", periodEnd: "2026-10-13", netPayable: 21_050,
        status: "paid" as const, paidAt: ago(60 * 24 * 5), paymentRef: "UTR123456",
      },
    ],
  },
  openComplaints: [toTicketSummary(ticketRow(30))],
});

const vendorPerms = { "manager.vendors.view": true, "manager.vendors.status": true, "manager.vendors.onboard": true };

export const vendorDetailFull = buildVendorDetail(
  { ...vendorDetailInput("active"), allowed: allowedVendorActions({ status: "active" }, vendorPerms) },
  { ...vendorPerms, "manager.finance.view": true }
);

export const vendorDetailNoFinance = buildVendorDetail(
  { ...vendorDetailInput("suspended"), allowed: allowedVendorActions({ status: "suspended" }, vendorPerms) },
  vendorPerms
);

export const vendorReviews = {
  items: [
    toReviewItem({
      id: uuid(20), rating: 5, comment: "Hot and on time", created_at: ago(200), status: "published", order_id: uuid(3),
      food_quality: 5, packaging: 4, delivery_experience: 5, value_for_money: 4,
      profiles: { full_name: "Asha Verma" },
      review_replies: { reply_text: "Thank you!", created_at: ago(150), removed_at: null },
    }),
    toReviewItem({
      id: uuid(21), rating: 2, comment: null, created_at: ago(400), status: "hidden", order_id: null,
      food_quality: null, packaging: null, delivery_experience: null, value_for_money: null,
      profiles: null, review_replies: null,
    }),
  ],
  nextCursor: null,
};

export const vendorComplaints = {
  items: [
    toTicketSummary(ticketRow(30)),
    toTicketSummary(ticketRow(31, { requester_role: "vendor", priority: "normal", status: "open", order_id: null })),
  ],
  nextCursor: null,
};

export const vendorsDirectory = {
  vendors: vendorRows.map((r) => ({ id: r.id, name: r.name ?? "Shop", status: r.status, zoneId: r.zone_id, zoneName: r.zone_name })),
};

// ── products ─────────────────────────────────────────────────────────────────

const pRow = (n: number, over: Partial<ProductRow> = {}): ProductRow => ({
  id: uuid(n),
  name: n === 10 ? "Paneer Tikka" : `Dish ${n}`,
  restaurant_id: uuid(90),
  category: n % 3 === 0 ? null : n % 2 ? "Starters" : "Beverages",
  price: 180 + n,
  discount_price: n === 10 ? 160 : null,
  pending_price: null,
  image_url: null,
  veg: true,
  available: n !== 12,
  stock_qty: n === 11 ? 3 : null,
  low_stock_at: n === 11 ? 5 : null,
  sold_out_by_stock: false,
  approval_status: "approved",
  hidden_by_ops: false,
  updated_at: ago(30),
  restaurants: { name: "Spice Hub", zone_id: uuid(80) },
  ...over,
});

const productRows = [
  pRow(10),
  pRow(11),
  pRow(12, { approval_status: "pending", pending_price: 210 }),
  pRow(13, { hidden_by_ops: true }),
];

export const productsList = {
  items: productRows.map((r, i) => toProductListItem(r, i === 0 ? 1 : 0)),
  nextCursor: null,
  counts: { unavailable: 1, outOfStock: 0, lowStock: 1, pendingApproval: 1, openFlags: 1, hidden: 1 },
};

/** A cursor page: the same list, so it repeats no counts. */
export const productsListPage2 = { items: [toProductListItem(pRow(14), 0)], nextCursor: null, counts: null };

export const imageReviews = {
  items: [
    toImageReviewItem({
      change: { change_id: 42, old_value: "https://cdn.example/old.jpg", new_value: "https://cdn.example/new-42.jpg", created_at: "2026-10-21T09:30:00+00:00" },
      product: productRows[1],
      openFlags: 0,
      changedBy: { id: "u-v2", name: "Kiran Sahu" },
    }),
    toImageReviewItem({
      change: { change_id: 41, old_value: null, new_value: "https://cdn.example/new-41.jpg", created_at: "2026-10-21T09:00:00+00:00" },
      product: productRows[0],
      openFlags: 1,
      changedBy: null,
    }),
  ],
  nextBefore: 41,
};

const productPerms = { "manager.products.view": true, "manager.products.moderate": true, "manager.products.adjust_stock": true };

export const productDetail = toProductDetail({
  row: productRows[2],
  extra: { description: "Smoky cottage cheese", approval_note: "Price rise above 15%", hidden_reason: null },
  openFlags: 1,
  variants: [{ name: "Half", price: 120 }],
  addonGroups: [{ name: "Extras", addons: [{ name: "Mint chutney", price: 10 }] }],
  changes: [
    {
      id: 1, field: "price", from: "191", to: "210", source: "vendor",
      actor: { id: uuid(61), name: "Meena Sahu", role: "restaurant" }, at: ago(40),
    },
    { id: 2, field: "available", from: "true", to: "false", source: "system", actor: null, at: ago(20) },
  ],
  flags: [
    {
      id: uuid(55), reason: "wrong_image", note: "Photo shows a burger", status: "open",
      raisedBy: { id: uuid(60), name: "Ravi Kumar" }, raisedAt: ago(15),
      resolution: null, resolvedBy: null, resolvedAt: null,
    },
  ],
  sales: {
    from: "2026-09-22", to: "2026-10-21", units: 86, revenue: 15_480, orders: 70, rankInVendor: 3,
    daily: [{ date: "2026-10-21", units: 4 }],
  },
  availability: { timesUnavailable: 2, hoursUnavailable: 31.5 },
  allowed: allowedProductActions({ approvalStatus: "pending", hidden: false, openFlags: 1 }, productPerms),
});

export const productCategories = {
  categories: aggregateCategories(
    productRows.map((r) => ({ category: r.category, available: r.available, restaurant_id: r.restaurant_id })),
    ["beverages"]
  ),
};

export const productInsights = {
  from: "2026-09-22",
  to: "2026-10-21",
  ...buildProductInsights({
    items: productRows,
    sales: new Map([
      [uuid(10), { units: 86, revenue: 13_760 }],
      [uuid(11), { units: 2, revenue: 382 }],
    ]),
    availabilityChanges: [
      { itemId: uuid(12), at: "2026-10-01T05:00:00Z", to: false },
      { itemId: uuid(12), at: "2026-10-01T09:00:00Z", to: true },
      { itemId: uuid(12), at: "2026-10-05T05:00:00Z", to: false },
      { itemId: uuid(12), at: "2026-10-06T08:00:00Z", to: true },
      { itemId: uuid(12), at: "2026-10-10T05:00:00Z", to: false },
    ],
    priceChanges: [{ itemId: uuid(10), at: "2026-10-12T05:00:00Z", from: "170", to: "190", source: "vendor" }],
    range: { start: new Date("2026-09-21T18:30:00Z"), endExclusive: new Date("2026-10-21T18:30:00Z") },
    limit: 10,
    openFlags: new Map([[uuid(10), 1]]),
  }),
};

// ── tickets ──────────────────────────────────────────────────────────────────

export const ticketThread = buildTicketThread(
  {
    ...ticketRow(30),
    requester_id: uuid(62),
    restaurant_id: uuid(90),
    zone_id: uuid(80),
    escalation_level: 0,
    resolution: null,
    first_response_at: ago(85),
    resolved_at: null,
    restaurants: { name: "Spice Hub" },
  },
  [
    {
      id: uuid(56), author_id: uuid(62), author_role: "customer", body: "The food was cold.", internal: false,
      attachments: ["t/30/photo.jpg"], created_at: ago(90), profiles: { full_name: "Asha Verma" },
    },
    {
      id: uuid(57), author_id: uuid(60), author_role: "manager", body: "Called the kitchen.", internal: true,
      attachments: null, created_at: ago(85), profiles: { full_name: "Ravi Kumar" },
    },
  ],
  new Map([["t/30/photo.jpg", "https://example.test/signed/photo.jpg"]])
);

/** Generated file name → the body the route sends. Detail routes wrap: { vendor } / { product }. */
export const phase4Files: Record<string, unknown> = {
  vendors_list: vendorsList,
  vendor_detail: { vendor: vendorDetailFull },
  vendor_detail_no_finance: { vendor: vendorDetailNoFinance },
  vendor_reviews: vendorReviews,
  vendor_complaints: vendorComplaints,
  vendors_directory: vendorsDirectory,
  products_list: productsList,
  products_list_page2: productsListPage2,
  image_reviews: imageReviews,
  product_detail: { product: productDetail },
  product_categories: productCategories,
  product_insights: productInsights,
  ticket_thread: ticketThread,
};

/** What the app is promised; each failure is a sentence. */
export function phase4Failures(): string[] {
  const f: string[] = [];
  if (!("finance" in vendorDetailFull)) f.push("vendor detail with manager.finance.view carries finance");
  if ("finance" in vendorDetailNoFinance) f.push("vendor detail without manager.finance.view has no finance key");
  if (!Array.isArray(vendorDetailFull.openComplaints)) f.push("vendor detail openComplaints is the ticket array");
  if (vendorComplaints.items.some((t) => t.requesterRole === "vendor" || t.requesterRole === "rider")) {
    f.push("ticket requester roles use the contract's words (restaurant, driver)");
  }
  if (productInsights.frequentlyUnavailable.length === 0) f.push("a frequently unavailable dish is in the insights fixture");
  if (productsListPage2.counts !== null) f.push("a cursor page of products carries counts: null");
  if (!imageReviews.items.some((i) => i.previousImageUrl === null)) f.push("a new dish's photo (no previous image) is in the image review fixture");
  if (!ticketThread.messages.some((m) => m.internal)) f.push("an internal note is in the thread fixture");
  return f;
}
