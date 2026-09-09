"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { fieldCls, labelCls } from "@/components/ui/field";
import { DatePicker } from "@/components/ui/date-picker";
import {
  REPORT_KINDS,
  type PaymentFilter,
  type ReportKind,
} from "@/lib/reports/kinds";

/**
 * Report type, dates, shop and payment method — all in the URL.
 *
 * GET-driven so a report is a link. "Send me the earnings for last month for
 * Sharma Foods" is then a URL someone can paste, which is the difference
 * between a report screen and a report.
 *
 * The five report kinds are tabs rather than a row of soft buttons: they are
 * mutually exclusive views of one workspace, which is exactly what a tab strip
 * means and what five equally-weighted buttons do not. They keep their own
 * markup rather than using the kit's `Tabs` because this component navigates
 * through the router — it has to merge the patch into the existing query
 * string, so that a change of report keeps the dates and the shop.
 */
export function ReportFilters({
  vendors,
  kind,
  from,
  to,
  vendorId,
  payment,
}: {
  vendors: { id: string; name: string }[];
  kind: ReportKind;
  from: string;
  to: string;
  vendorId: string;
  payment: PaymentFilter;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const navigate = (patch: Record<string, string>) => {
    const usp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v && v !== "all") usp.set(k, v);
      else usp.delete(k);
    }
    start(() => router.push(`/admin/reports?${usp.toString()}`));
  };

  return (
    <div
      className="flex flex-col gap-2.5 print:hidden"
      data-pending={pending ? "true" : undefined}
    >
      <nav className="c-tabs no-scrollbar" aria-label="Report">
        {REPORT_KINDS.map((r) => (
          <button
            key={r.value}
            type="button"
            disabled={pending}
            aria-current={kind === r.value ? "true" : undefined}
            onClick={() => navigate({ kind: r.value })}
            className="c-tab"
          >
            {r.label.replace(" report", "")}
          </button>
        ))}
      </nav>

      {/* Not a bordered panel. Four labelled controls in a row are already
          legible as a group — the labels do the grouping — and boxing them
          added an edge that competed with the table below. */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2.5">
        <label className="block min-w-[132px] flex-1 space-y-1">
          <span className={labelCls}>From</span>
          <DatePicker
            className={fieldCls}
            value={from}
            disabled={pending}
            onChange={(v) => navigate({ from: v })}
          />
        </label>
        <label className="block min-w-[132px] flex-1 space-y-1">
          <span className={labelCls}>To</span>
          <DatePicker
            className={fieldCls}
            value={to}
            disabled={pending}
            onChange={(v) => navigate({ to: v })}
          />
        </label>
        <label className="block min-w-[170px] flex-[1.4] space-y-1">
          <span className={labelCls}>Shop</span>
          <select
            className={fieldCls}
            value={vendorId}
            disabled={pending}
            onChange={(e) => navigate({ vendor: e.target.value })}
          >
            <option value="">All shops</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-[170px] flex-1 space-y-1">
          <span className={labelCls}>Payment</span>
          <select
            className={fieldCls}
            value={payment}
            disabled={pending}
            onChange={(e) => navigate({ payment: e.target.value })}
          >
            <option value="all">Cash and online</option>
            <option value="cod">Cash on delivery only</option>
            <option value="online">Online only</option>
          </select>
        </label>
      </div>
    </div>
  );
}
