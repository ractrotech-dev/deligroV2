import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import {
  Empty,
  Fact,
  FactList,
  Figure,
  FigureRow,
  PageHeader,
  Section,
  StatusBadge,
  StatusText,
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
import { adminPaymentMode, waitingPaymentForRider } from "@/lib/data-access/admin-rider-payments";
import { MIGRATION_MISSING, formatDay, formatMoney } from "@/lib/rider/admin-money";
import { istDay } from "@/lib/rider/earnings-math";
import { formatDateTime, formatRelativeTime } from "@/lib/utils/relative-time";
import { MoneyTab } from "./money-tab";
import { AccountAccess } from "@/components/admin/feature-access/account-access";
import { ProfileTab } from "./profile-tab";
import { getStaffAccount } from "@/lib/data-access/staff-access";
import { listStaffLoginEmails } from "@/lib/data-access/employees";
import { StaffAccessControls } from "@/app/admin/settings/employees/staff-access-controls";
import { DocumentsTab } from "./documents-tab";
import { getRiderProfileForAdmin, type AdminRiderProfile } from "@/lib/data-access/admin-rider-profile";
import { getPayoutAccountForAdmin } from "@/lib/data-access/rider-payout-accounts";
import { listTicketsOfRequester, type TicketSummary } from "@/lib/data-access/support";
import { STATUS_TONE, staffStatusLabel } from "@/app/admin/support/support-view";

export const metadata: Metadata = { title: "Rider · Admin · Deligro" };

/**
 * Admin → Riders → one rider. Three tabs: Overview, Salary, and Details
 * (verification, payout account in full, change requests, documents, and which
 * sections of the rider app this rider may use). Older addresses
 * (?tab=money, profile, documents, access) land on the tab that now holds them.
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
type Tab = "overview" | "salary" | "details";
const TAB_OF = new Map<string, Tab>([
  ["salary", "salary"],
  ["money", "salary"],
  ["details", "details"],
  ["profile", "details"],
  ["documents", "details"],
  ["access", "details"],
]);
const PROFILE_MISSING = "Rider profiles (migration 0086) aren't applied to this database yet";

export default async function AdminRiderPage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ id: string }>; searchParams: Promise<Search> }>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  const admin = await requireRole("admin");

  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id) || !isSupabaseConfigured) notFound();

  const rider = await getRiderForAdmin(id);
  if (!rider) notFound();

  const account = await getStaffAccount(id);
  const stopped = account !== null && account.accountStatus !== "active";
  // Still reachable from old orders and reports, with nothing left to do to them.
  const removed = account?.removed === true;

  const tab: Tab = TAB_OF.get(sp.tab ?? "") ?? "overview";
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
  let mayPayNow = false;
  let waiting: { amount: number; askedBy: string } | null = null;
  if (tab === "salary") {
    try {
      money = await getRiderMoney(id, { from: sp.from, to: sp.to, cursor: sp.cursor ?? null });
      const [mode, request] = await Promise.all([adminPaymentMode(), waitingPaymentForRider(admin, id)]);
      mayPayNow = mode === true;
      waiting = request ? { amount: request.amount, askedBy: request.requestedBy.name } : null;
    } catch (e) {
      if (isRiderSchemaPending(e)) moneyPending = true;
      else {
        captureError(e, { source: "admin-riders/money", attrs: { event: "money_read_failed", driverId: id } });
        throw e;
      }
    }
  }

  // Details reads the whole profile; Salary needs only the account
  // the next payout goes to (masked) and whether a change is waiting.
  let profile: AdminRiderProfile | null = null;
  let profilePending = false;
  let payTo: { masked: string | null; changePending: boolean } | null = null;
  try {
    if (tab === "details") {
      profile = await getRiderProfileForAdmin(id);
    } else if (tab === "salary") {
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
  if (tab === "details" && !profilePending && !profile) notFound();

  // Tickets and incidents (0087). Its failure — or a database without the
  // tables — costs only this list.
  let tickets: TicketSummary[] | null = null;
  if (tab === "overview") {
    try {
      tickets = (await listTicketsOfRequester(id)).slice(0, 10);
    } catch (e) {
      if (!isRiderSchemaPending(e)) {
        captureError(e, { source: "admin-riders/tickets", attrs: { event: "rider_tickets_failed", driverId: id } });
      }
    }
  }

  const loginEmail =
    tab === "details" ? ((await listStaffLoginEmails([id]).catch(() => null))?.get(id) ?? null) : null;

  return (
    <>
      <PageHeader
        title={rider.name ?? "Unnamed rider"}
        description={[rider.riderCode, rider.phone].filter(Boolean).join(" · ") || undefined}
        back={{ href: "/admin/riders", label: "Riders" }}
        status={
          stopped ? (
            <StatusBadge tone="red">{removed ? "Deleted" : "Deactivated"}</StatusBadge>
          ) : (
            <StatusBadge tone={PHASE_TONE[rider.phase]}>{PHASE_LABEL[rider.phase]}</StatusBadge>
          )
        }
        actions={
          <>
            {rider.phone ? (
              <a href={`tel:${rider.phone}`} className="c-btn c-btn-outline">
                Call
              </a>
            ) : null}
            {removed ? null : <StaffAccessControls id={id} name={rider.name ?? "this rider"} role="driver" stopped={stopped} afterRemove="/admin/riders" />}
          </>
        }
      />

      <Toolbar>
        <Tabs
          label="Rider sections"
          active={tab === "overview" ? base : `${base}?tab=${tab}`}
          items={[
            { href: base, label: "Overview" },
            { href: `${base}?tab=salary`, label: "Salary" },
            { href: `${base}?tab=details`, label: "Details" },
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
              label="Rating"
              value={ratings?.average == null ? "-" : ratings.average.toFixed(2)}
              note={ratings === null ? "Could not be read just now" : ratings.count === 0 ? "No ratings yet" : `Out of 5, from ${ratings.count}`}
            />
            <Figure
              label="To pay"
              value={rider.pending === null ? "-" : formatMoney(rider.pending)}
              note={rider.pending === null ? "Rider money isn't set up yet" : "Not yet paid"}
            />
          </FigureRow>

          <Section title="Status">
            <FactList>
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
              <Fact label="Joined">{formatDay(istDay(rider.joinedAt))}</Fact>
            </FactList>
          </Section>

          {ratings?.recent.some((r) => r.comment) ? (
            <Section title="What customers said">
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
            </Section>
          ) : null}

          <Section
            title="Tickets and incidents"
            meta={tickets ? `${tickets.length === 10 ? "latest 10" : tickets.length}` : undefined}
            actions={
              <Link href="/admin/support?role=rider" className="text-[12px] font-semibold text-accent-ink hover:underline">
                Support desk
              </Link>
            }
          >
            {tickets === null ? (
              <Empty>Support tickets need migration 0087 applied to this database.</Empty>
            ) : tickets.length === 0 ? (
              <Empty>This rider has not raised a ticket or reported an incident.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {tickets.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                    <Link href={`/admin/support/${t.id}`} className="min-w-0 hover:underline">
                      <span className={`block truncate text-[13px] font-semibold ${t.priority === "emergency" ? "text-deal" : "text-ink"}`}>
                        #{t.number} · {t.subject}
                      </span>
                      <span className="block truncate text-[11.5px] text-muted">
                        {t.categoryLabel}
                        {t.orderCode ? ` · order ${t.orderCode}` : ""} · {formatRelativeTime(t.updatedAt)}
                      </span>
                    </Link>
                    <StatusText tone={STATUS_TONE[t.status] ?? "neutral"}>{staffStatusLabel(t.status)}</StatusText>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      ) : tab === "details" ? (
        <div className="space-y-5">
          <Section title="Login" flush>
            <FactList>
              <Fact label="Email">
                <span className="text-data">{loginEmail ?? "Not available"}</span>
              </Fact>
              <Fact label="Mobile">
                <span className="text-data">{rider.phone ?? "None"}</span>
              </Fact>
              <Fact label="Password">{"Can't be shown. Reset password, at the top of this page, gives a new one."}</Fact>
            </FactList>
          </Section>
          {profilePending || !profile ? (
            <PreviewNotice>
              {PROFILE_MISSING}. The rider&apos;s profile, documents and change requests appear here once it is.
            </PreviewNotice>
          ) : (
            <>
              <ProfileTab profile={profile} />
              <Section title="Documents" id="documents">
                <DocumentsTab profile={profile} />
              </Section>
            </>
          )}
          <Section title="App access" id="access" description="Turn parts of the rider app on or off for this rider.">
            <details open={sp.tab === "access"}>
              <summary className="cursor-pointer text-[12.5px] font-semibold text-accent-ink">Show the switches</summary>
              <div className="mt-3">
                <AccountAccess role="driver" subjectId={id} subjectName={rider.name ?? "this rider"} />
              </div>
            </details>
          </Section>
        </div>
      ) : moneyPending || !money ? (
        <PreviewNotice>
          {MIGRATION_MISSING}. Earnings, payouts and adjustments appear here once it is.
        </PreviewNotice>
      ) : (
        <MoneyTab mayPayNow={mayPayNow} waiting={waiting} riderId={id} money={money} today={today} cursor={sp.cursor ?? null} payTo={payTo} />
      )}
    </>
  );
}
