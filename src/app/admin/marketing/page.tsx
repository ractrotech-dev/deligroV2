import { requireRole } from "@/lib/auth";
import { Megaphone } from "lucide-react";
import { EmptyState, PreviewNotice } from "@/components/admin/admin-ui";
import { PageHeader, StatusText, Tabs, type Tone } from "@/components/admin/console";
import { listAllMarketing, MarketingNotMigratedError, type MarketingRequest } from "@/lib/data-access/marketing";
import { MARKETING_STATUSES, type MarketingStatus } from "@/lib/vendor/growth-input";
import { formatINR } from "@/lib/utils/format";
import { MarketingDecisionForm } from "./decision-form";

/**
 * Admin → Marketing requests (Partner app requirements §6). Shops ask for
 * banners, featured slots, discount campaigns and the rest; this is where each
 * one is approved, rejected (always with a reason) or moved along, and every
 * step pushes to the shop's Partner app.
 */
export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  banner: "Banner",
  featured: "Featured listing",
  discount_offer: "Discount & offer",
  social_media: "Social media",
  push_campaign: "Push campaign",
  other: "Other",
};

const TONE: Record<MarketingStatus, Tone> = {
  pending: "amber",
  approved: "blue",
  in_progress: "accent",
  completed: "green",
  rejected: "red",
  cancelled: "neutral",
};

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

export default async function AdminMarketingPage({ searchParams }: Readonly<{ searchParams: Promise<{ status?: string }> }>) {
  await requireRole("admin");
  const sp = await searchParams;
  const status = (MARKETING_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as MarketingStatus) : undefined;

  let requests: MarketingRequest[] = [];
  let migrated = true;
  try {
    requests = await listAllMarketing(status);
  } catch (e) {
    if (!(e instanceof MarketingNotMigratedError)) throw e;
    migrated = false;
  }

  return (
    <>
      <PageHeader
        title="Marketing requests"
        description="Campaign asks from shops. Approve, reject with a reason, or move them along — the shop is told every time."
      />
      {!migrated ? <PreviewNotice>Apply migration 0064 to take marketing requests.</PreviewNotice> : null}
      <Tabs
        label="Status"
        active={status ? `/admin/marketing?status=${status}` : "/admin/marketing"}
        items={[
          { href: "/admin/marketing", label: "All" },
          ...MARKETING_STATUSES.map((s) => ({ href: `/admin/marketing?status=${s}`, label: s.replace("_", " ") })),
        ]}
      />
      {requests.length === 0 ? (
        <EmptyState icon={Megaphone} title="Nothing here" description="No marketing requests match." />
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {requests.map((r) => (
            <article key={r.id} className="card space-y-3 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[12px] text-muted">
                    #{r.number} · {r.restaurantName} · {KIND_LABEL[r.kind] ?? r.kind}
                  </p>
                  <h2 className="text-[16px] font-bold leading-snug">{r.title}</h2>
                </div>
                <StatusText tone={TONE[r.status]}>{r.status.replace("_", " ")}</StatusText>
              </div>
              <p className="whitespace-pre-line text-[14px] text-ink/85">{r.details}</p>
              <p className="text-[13px] text-muted">
                {r.budget != null ? `Budget ${formatINR(r.budget)}` : "No budget given"}
                {r.startsOn ? ` · ${day.format(new Date(r.startsOn))}${r.endsOn ? ` – ${day.format(new Date(r.endsOn))}` : ""}` : ""}
                {` · asked ${day.format(new Date(r.createdAt))}`}
              </p>
              {r.updates.length > 1 ? (
                <ol className="space-y-1 border-l border-line pl-3 text-[12.5px] text-muted">
                  {r.updates.map((u, i) => (
                    <li key={i}>
                      {day.format(new Date(u.at))} · {u.by === "deligro" ? "Deligro" : "Shop"} · {u.status.replace("_", " ")}
                      {u.remarks ? ` — ${u.remarks}` : ""}
                    </li>
                  ))}
                </ol>
              ) : null}
              <MarketingDecisionForm id={r.id} status={r.status} />
            </article>
          ))}
        </div>
      )}
    </>
  );
}
