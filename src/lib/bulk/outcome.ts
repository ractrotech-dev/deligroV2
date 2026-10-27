/**
 * What a bulk menu / stock upload answers with. Types only, so the Partner app,
 * the manager app and the websites can all be written against one shape.
 */
import type { ColumnKey, RowIssue } from "@/lib/bulk/menu-sheet";

export type BulkAction = "create" | "update" | "unchanged" | "error";

export interface BulkItemOut {
  line: number;
  action: BulkAction;
  name: string;
  /** Plain-language list of what changes ("price 220 → 249"). */
  changes: string[];
  message?: string;
}

export interface BulkOutcome {
  mode: "preview" | "apply";
  counts: { create: number; update: number; unchanged: number; error: number };
  items: BulkItemOut[];
  /** Rows beyond `items` (the counts still cover them). */
  moreItems: number;
  issues: RowIssue[];
  columns: ColumnKey[];
  unknownColumns: string[];
  ignoredColumns: ColumnKey[];
  /** Present once applied. */
  applied?: {
    created: number;
    updated: number;
    failed: number;
    errors: string[];
    /** A manager's menu sheet: dishes saved but waiting for approval by someone else (restricted categories). */
    held?: number;
  };
}
