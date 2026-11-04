/**
 * Vendor lifecycle status — a client-safe module (no "server-only"), so both the
 * server data-access layer and client components (filters, row actions) can
 * share one source of truth without pulling server code into the browser bundle.
 */
export type VendorStatus = "active" | "inactive" | "suspended";

export const VENDOR_STATUSES: VendorStatus[] = [
  "active",
  "inactive",
  "suspended",
];

/**
 * The directory's filters. Each is an allow-list, because the values arrive from
 * the URL and choose which query runs.
 */
export const VENDOR_GAPS = [
  { value: "no_pin", label: "No map pin" },
  { value: "no_email", label: "No contact email" },
  { value: "incomplete", label: "Unfinished storefront" },
] as const;
export type VendorGap = (typeof VENDOR_GAPS)[number]["value"];

export const VENDOR_RATES = [
  { value: "platform", label: "Platform rate" },
  { value: "own", label: "Own rate" },
] as const;
export type VendorRate = (typeof VENDOR_RATES)[number]["value"];

export const VENDOR_OPEN_STATES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
] as const;
export type VendorOpenState = (typeof VENDOR_OPEN_STATES)[number]["value"];

/** The URL's value if it is one of `options`, otherwise no filter. */
export function pickFilter<T extends string>(
  options: readonly { value: T }[],
  raw: string | undefined
): T | undefined {
  return options.find((o) => o.value === raw)?.value;
}
