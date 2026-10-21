import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LifeBuoy } from "lucide-react";
import { EmptyState, PreviewNotice } from "@/components/admin/admin-ui";
import { PageHeader, StatusText, Tabs } from "@/components/admin/console";
import { listAllTickets, SupportNotMigratedError, type TicketSummary } from "@/lib/data-access/support";
import { TICKET_STATUSES, type TicketStatus } from "@/lib/vendor/growth-input";
import { TICKET_TONE } from "./tone";

/**
 * Admin → Support. Tickets from shops (Partner app §12) and, once the rider
 * app's help screens land, riders — newest activity first, emergencies flagged.
 */
export const dynamic = "force-dynamic";


const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default async function AdminSupportPage({ searchParams }: Readonly<{ searchParams: Promise<{ status?: string; role?: string }> }>) {
  await requireRole("admin");
  const sp = await searchParams;
  const status = (TICKET_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as TicketStatus) : undefined;
  const role = sp.role === "vendor" || sp.role === "rider" ? sp.role : undefined;

  let tickets: TicketSummary[] = [];
  let migrated = true;
  try {
    tickets = await listAllTickets({ status, role });
  } catch (e) {
    if (!(e instanceof SupportNotMigratedError)) throw e;
    migrated = false;
  }

  const q = (s?: string) => `/admin/support${s ? `?status=${s}` : ""}`;
  return (
    <>
      <PageHeader title="Support" description="Tickets from shops and riders. Reply, leave internal notes, and close them out." />
      {!migrated ? <PreviewNotice>Apply migration 0064 to take support tickets.</PreviewNotice> : null}
      <Tabs
        label="Status"
        active={q(status)}
        items={[{ href: q(), label: "All" }, ...TICKET_STATUSES.map((s) => ({ href: q(s), label: s.replaceAll("_", " ") }))]}
      />
      {tickets.length === 0 ? (
        <EmptyState icon={LifeBuoy} title="No tickets" description="Nothing matches this view." />
      ) : (
        <ul className="card mt-4 divide-y divide-line">
          {tickets.map((t) => (
            <li key={t.id}>
              <Link href={`/admin/support/${t.id}`} className="flex items-center gap-4 px-5 py-3.5 hover:bg-surface-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold">
                    {t.priority === "emergency" ? "🚨 " : ""}#{t.number} · {t.subject}
                  </p>
                  <p className="text-[12.5px] text-muted">
                    {t.requesterName} · {t.requesterRole} · {t.category} · updated {when.format(new Date(t.updatedAt))}
                  </p>
                </div>
                <StatusText tone={TICKET_TONE[t.status]}>{t.status.replaceAll("_", " ")}</StatusText>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
