import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { listIncentiveRules } from "@/lib/data-access/rider-earnings";
import { istDay } from "@/lib/rider/earnings-math";
import { RulesView, type Rule, type RulesSearch } from "./rules-view";

export const metadata: Metadata = { title: "Rider incentives · Admin · Deligro" };

/**
 * Admin → Riders → Incentive rules. "N deliveries in a day or week pays ₹X",
 * optionally inside a time window and between two dates.
 *
 * Platform: BOTH. The list is a `DataTable`; the editor sits beside it in a
 * wide container and under it in a narrow one.
 *
 * There is deliberately no delete. A rule that has paid anyone can never be
 * removed (the awards reference it), and switching it off already stops it:
 * one way to retire a rule, and it is the safe one. A rule's period and start
 * date are fixed once it exists (0083 enforces that for every role), so the
 * editor shows them read-only.
 */
export const dynamic = "force-dynamic";

export default async function IncentiveRulesPage({ searchParams }: Readonly<{ searchParams: Promise<RulesSearch> }>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const sp = await searchParams;
  let rules: Rule[] = [];
  let migrationMissing = false;
  let failed = false;
  if (isSupabaseConfigured) {
    try {
      rules = await listIncentiveRules();
    } catch (e) {
      if (isRiderSchemaPending(e)) migrationMissing = true;
      else {
        failed = true;
        captureError(e, { source: "admin-riders/rules", attrs: { event: "rules_list_failed" } });
      }
    }
  }

  return (
    <RulesView rules={rules} sp={sp} today={istDay(new Date())} migrationMissing={migrationMissing} failed={failed} />
  );
}
