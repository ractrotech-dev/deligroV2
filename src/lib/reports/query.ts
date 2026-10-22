/**
 * GET /api/manager/reports query parsing — pure. A filter the kind does not
 * take is `bad_filter` (never silently ignored: a report that quietly drops a
 * vendor filter reads as that vendor's figures).
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { parseFinanceRange } from "@/lib/ops/finance-contract";
import { reportMeta, resolveKind, type ReportFilter, type ReportKindId } from "@/lib/reports/definitions";
import { MAX_PAGE_SIZE } from "@/lib/reports/payload";
import type { DateRange } from "@/lib/metrics";

export interface ReportQuery {
  kind: ReportKindId;
  range: DateRange;
  zoneId: string | null;
  vendorId: string | null;
  riderId: string | null;
  status: string | null;
  payment: "all" | "cod" | "online";
  page: number;
  pageSize: number;
  all: boolean;
}

export type ReportQueryError =
  | { error: "bad_kind" }
  | { error: "bad_range" }
  | { error: "bad_filter"; filter: string }
  | { error: "bad_request"; field: string };

export function parseReportQuery(p: URLSearchParams, now: Date): ({ ok: true } & ReportQuery) | ({ ok: false } & ReportQueryError) {
  const kind = resolveKind(p.get("kind"));
  if (!kind) return { ok: false, error: "bad_kind" };
  const def = reportMeta(kind);
  const r = parseFinanceRange(p, now);
  if (!r.ok) return r.error === "bad_range" ? { ok: false, error: "bad_range" } : { ok: false, error: "bad_request", field: r.field ?? "zone" };

  const takes = (f: ReportFilter) => def.filters.includes(f);
  const given = (f: string) => p.has(f) && p.get(f) !== "";
  for (const f of ["vendor", "rider", "status", "zone"] as const) {
    if (given(f) && !takes(f)) return { ok: false, error: "bad_filter", filter: f };
  }
  const payment = p.get("payment") || "all";
  if (payment !== "all" && !takes("payment")) return { ok: false, error: "bad_filter", filter: "payment" };
  if (payment !== "all" && payment !== "cod" && payment !== "online") return { ok: false, error: "bad_request", field: "payment" };

  const vendor = p.get("vendor");
  if (vendor && !isUuid(vendor)) return { ok: false, error: "bad_request", field: "vendor" };
  const rider = p.get("rider");
  if (rider && !isUuid(rider)) return { ok: false, error: "bad_request", field: "rider" };
  const status = p.get("status") || null;
  if (status && !def.statusOptions.some((s) => s.value === status)) return { ok: false, error: "bad_request", field: "status" };

  const page = Number(p.get("page") ?? "1");
  const pageSize = Number(p.get("pageSize") ?? "50");
  if (!Number.isInteger(page) || page < 1) return { ok: false, error: "bad_request", field: "page" };
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) return { ok: false, error: "bad_request", field: "pageSize" };

  return {
    ok: true,
    kind,
    range: r.range,
    zoneId: r.zone,
    vendorId: vendor ? vendor.toLowerCase() : null,
    riderId: rider ? rider.toLowerCase() : null,
    status,
    payment: payment as ReportQuery["payment"],
    page,
    pageSize,
    all: p.get("all") === "1",
  };
}
