export type VendorHistoryKind = "cancelled" | "completed";

export type VendorHistoryRange =
  | "all"
  | "this_month"
  | "previous_month"
  | "date";

export interface VendorHistoryQuery {
  restaurantId: string;
  kind: VendorHistoryKind;
  range?: VendorHistoryRange;
  /** YYYY-MM-DD when range is `date` */
  date?: string;
  search?: string;
  limit?: number;
  /** Rows to skip, for paging past the first page. */
  offset?: number;
}
