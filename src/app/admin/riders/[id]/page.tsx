import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import {
  Fact,
  FactList,
  Figure,
  FigureRow,
  PageHeader,
  Section,
  StatusBadge,
  Tabs,
  Toolbar,
  type Tone,
} from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { getRiderRatingsForAdmin } from "@/lib/data-access/rider-insights";
import { getRiderForAdmin, getRiderMoney, type RiderMoney, type RiderPhase } from "@/lib/data-access/admin-riders";
import { MIGRATION_MISSING, formatDay, formatMoney } from "@/lib/rider/admin-money";
import { istDay } from "@/lib/rider/earnings-math";
import { formatDateTime, formatRelativeTime } from "@/lib/utils/relative-time";
import { MoneyTab } from "./money-tab";
import { ProfileTab } from "./profile-tab";
import { DocumentsTab } from "./documents-tab";
import { getRiderProfileForAdmin, type AdminRiderProfile } from "@/lib/data-access/admin-rider-profile";
import { getPayoutAccountForAdmin } from "@/lib/data-access/rider-payout-accounts";

export const metadata: Metadata = { title: "Rider · Admin · Deligro" };

/**
 * Admin → Riders → one rider. Tabs: Overview, Profile (verification, payout
 * account in full, change requests), Documents (view, verify, reject) and
 * Money.
 *
 * Platform: BOTH. The tab is a query parameter, not state: it survives a
 * reload and can be sent to a colleague. The Money tab's tables are
 * `DataTable`s and its forms size against their own container.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PHASE_TONE: Record<RiderPhase, Tone> = { online: "green", break: "amber", stale: "amber", offline: "neutral" };
const PHASE_LABEL: Record<RiderPhase, string> = {
  online: "Online",
  break: "On break",
  stale: "Online, no recent position",
  offline: "Offline",
};

type Search = { tab?: string; from?: string; to?: string; cursor?: string };
type Tab = "overview" | "profile" | "documents" | "money";
const TABS: readonly Tab[] = ["overview", "profile", "documents", "money"];
const PROFILE_MISSING = "Rider profiles (migration 0086) aren't applied to this database yet";

export default async function AdminRiderPage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ id: string }>; searchParams: Promise<Search> }>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id) || !isSupabaseConfigured) notFound();

  const rider = await getRiderForAdmin(id);
  if (!rider) notFound();

  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "overview";
  const base = `/admin/riders/${id}`;
  const today = istDay(new Date());

  // Ratings (0084): shown on the Overview; a read that fails costs this section, not the page.
  let ratings: Awaited<ReturnType<typeof getRiderRatingsForAdmin>> | null = null;
  if (tab === "overview") {
    try {
      ratings = await getRiderRatingsForAdmin(id);
    } catch (e) {
      captureError(e, { source: "admin-riders/ratings", attrs: { event: "ratings_read_failed", driverId: id } });
    }
  }

  let money: RiderMoney | null = null;
  let moneyPending = false;
  if (tab === "money") {
    try {
      money = await getRiderMoney(id, { from: sp.from, to: sp.to, cursor: sp.cursor ?? null });
    } catch (e) {
      if (isRiderSchemaPending(e)) moneyPending = true;
      else {
        captureError(e, { source: "admin-riders/money", attrs: { event: "money_read_failed", driverId: id } });
        throw e;
      }
    }
  }

  // Profile and Documents read the same thing; Money needs only the account
  // the next payout goes to (masked) and whether a change is waiting.
  let profile: AdminRiderProfile | null = null;
  let profilePending = false;
  let payTo: { masked: string | null; changePending: boolean } | null = null;
  try {
    if (tab === "profile" || tab === "documents") {
      profile = await getRiderProfileForAdmin(id);
    } else if (tab === "money") {
      const view = await getPayoutAccountForAdmin(id);
      payTo = { masked: view.account?.masked ?? null, changePending: view.pending !== null };
    }
  } catch (e) {
    if (isRiderSchemaPending(e)) profilePending = true;
    else {
      captureError(e, { source: "admin-riders/profile", attrs: { event: "profile_read_failed", driverId: id } });
      throw e;
    }
  }
  if ((tab === "profile" || tab === "documents") && !profilePending && !profile) notFound();

  return (
    <>
      <PageHeader
        title={rider.name ?? "Unnamed rider"}
        description={[rider.riderCode, rider.phone].filter(Boolean).join(" · ") || undefined}
        back={{ href: "/admin/riders", label: "Riders" }}
        status={<StatusBadge tone={PHASE_TONE[rider.phase]}>{PHASE_LABEL[rider.phase]}</StatusBadge>}
        actions={
          rider.phone ? (
            <a href={`tel:${rider.phone}`} className="c-btn c-btn-outline press">
              Call
            </a>
          ) : undefined
        }
      />

      <Toolbar>
        <Tabs
          label="Rider sections"
          active={tab === "overview" ? base : `${base}?tab=${tab}`}
          items={[
            { href: base, label: "Overview" },
            { href: `${base}?tab=profile`, label: "Profile" },
            { href: `${base}?tab=documents`, label: "Documents" },
            { href: `${base}?tab=money`, label: "Money" },
          ]}
        />
      </Toolbar>

      {tab === "overview" ? (
        <div className="space-y-5">
          <FigureRow>
            <Figure label="Delivered today" value={rider.delivered.today} />
            <Figure label="This week" value={rider.delivered.week} note="From Monday" />
            <Figure label="All time" value={rider.delivered.total} />
            <Figure
              label="Owed"
              value={rider.pending === null ? "-" : formatMoney(rider.pending)}
              note={rider.pending === null ? "Rider money (0083) isn't applied yet" : "Not yet paid out"}
            />
          </FigureRow>

          <Section title="Right now">
            <FactList>
              <Fact label="Status">{PHASE_LABEL[rider.phase]}</Fact>
              {rider.onlineSince ? <Fact label="Online since">{formatDateTime(rider.onlineSince)}</Fact> : null}
              {rider.phase !== "offline" ? (
                <Fact label="Last position">{rider.lastFixAt ? formatRelativeTime(rider.lastFixAt) : "None yet"}</Fact>
              ) : null}
              {rider.phase === "break" && rider.breakUntil ? (
                <Fact label="Break until">{formatDateTime(rider.breakUntil)}</Fact>
              ) : null}
              <Fact label="On delivery">
                {rider.activeOrderId ? (
                  <Link href={`/admin/orders/${rider.activeOrderId}`} className="text-data font-semibold text-accent-ink hover:underline">
                    {rider.activeOrderCode}
                  </Link>
                ) : (
                  "None"
                )}
              </Fact>
            </FactList>
          </Section>

          <Section title="Ratings">
            {ratings === null ? (
              <p className="text-xs text-muted">Ratings could not be read just now.</p>
            ) : (
              <>
                <FigureRow>
                  <Figure
                    label="Average"
                    value={ratings.average === null ? "-" : ratings.average.toFixed(2)}
                    note={ratings.count === 0 ? "No ratings yet" : "Out of 5"}
                  />
                  <Figure label="Ratings" value={ratings.count} />
                </FigureRow>
                {ratings.recent.some((r) => r.comment) ? (
                  <FactList>
                    {ratings.recent
                      .filter((r) => r.comment)
                      .map((r) => (
                        <Fact key={r.orderId} label={`${r.orderCode} · ${formatDay(istDay(r.at))}`}>
                          <Link href={`/admin/orders/${r.orderId}`} className="text-data font-semibold text-accent-ink hover:underline">
                            {r.rating}/5
                          </Link>
                          {" — "}
                          {r.comment}
                        </Fact>
                      ))}
                  </FactList>
                ) : null}
              </>
            )}
          </Section>

          <Section title="Account">
            <FactList>
              <Fact label="Rider ID">{rider.riderCode ?? "Not issued yet"}</Fact>
              <Fact label="Phone">{rider.phone ?? "No phone on file"}</Fact>
              <Fact label="Joined">{formatDay(istDay(rider.joinedAt))}</Fact>
            </FactList>
            <p className="text-xs text-muted">
              <Link href={`${base}?tab=money`} className="font-semibold text-accent-ink hover:underline">
                Open the Money tab
              </Link>{" "}
              to see earnings, record a payout or add a bonus or deduction.
            </p>
          </Section>
        </div>
      ) : tab === "profile" || tab === "documents" ? (
        profilePending || !profile ? (
          <PreviewNotice>
            {PROFILE_MISSING}. The rider&apos;s profile, documents and change requests appear here once it is.
          </PreviewNotice>
        ) : tab === "profile" ? (
          <ProfileTab profile={profile} />
        ) : (
          <DocumentsTab profile={profile} />
        )
      ) : moneyPending || !money ? (
        <PreviewNotice>
          {MIGRATION_MISSING}. Earnings, payouts and adjustments appear here once it is.
        </PreviewNotice>
      ) : (
        <MoneyTab riderId={id} money={money} today={today} cursor={sp.cursor ?? null} payTo={payTo} />
      )}
    </>
  );
}
