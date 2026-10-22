import Link from "next/link";
import { Fact, FactList, PageHeader, Section, StatusBadge, StatusText } from "@/components/admin/console";
import type { StaffThread } from "@/lib/data-access/support";
import { formatDateTime } from "@/lib/utils/relative-time";
import { STATUS_TONE, staffStatusLabel } from "./support-view";

const ROLE_LABEL: Record<string, string> = { rider: "Rider", vendor: "Shop", customer: "Customer", manager: "Manager", admin: "Admin" };

/**
 * One ticket's facts and its whole conversation, internal notes marked — the
 * admin desk and the manager's read-only view share it. `actions` is the
 * reply form on the desk, nothing on the manager's page.
 */
export function ThreadView({
  thread,
  back,
  canCall,
  actions,
}: Readonly<{
  thread: StaffThread;
  back: { href: string; label: string };
  canCall: boolean;
  actions?: React.ReactNode;
}>) {
  const t = thread.ticket;
  const emergency = t.priority === "emergency";
  const role = ROLE_LABEL[t.requesterRole] ?? t.requesterRole;
  return (
    <>
      <PageHeader
        title={`#${t.number} · ${t.subject}`}
        description={`${t.categoryLabel} · ${emergency ? "Emergency" : t.priority === "high" ? "High priority" : "Normal priority"}`}
        back={back}
        status={<StatusBadge tone={STATUS_TONE[t.status] ?? "neutral"}>{staffStatusLabel(t.status)}</StatusBadge>}
        actions={
          canCall && t.requesterPhone ? (
            <a href={`tel:${t.requesterPhone}`} className="c-btn c-btn-dark press">
              Call {role.toLowerCase()}
            </a>
          ) : undefined
        }
      />

      <div className="grid gap-5 @5xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <Section title="Conversation" meta={`${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"}`}>
            <ol className="space-y-2.5">
              {thread.messages.map((m) => (
                <li
                  key={m.id}
                  className={`rounded-lg border p-3 ${
                    m.internal ? "border-dashed border-line bg-surface-2" : m.fromStaff ? "border-line bg-surface @3xl:ml-10" : "border-line bg-surface @3xl:mr-10"
                  }`}
                >
                  <p className="mb-1 text-[11.5px] font-semibold text-muted">
                    {m.fromStaff ? `${m.authorName} (Deligro)` : `${m.authorName} · ${role}`} · {formatDateTime(m.createdAt)}
                    {m.internal ? <span className="ml-1.5 text-[color:var(--c-ink-amber)]">Internal note — not shown to the {role.toLowerCase()}</span> : null}
                  </p>
                  <p className="whitespace-pre-line text-[13.5px] text-ink">{m.body}</p>
                  {m.attachments.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {m.attachments.map((a) =>
                        a.url ? (
                          <a key={a.path} href={a.url} target="_blank" rel="noreferrer" className="block size-24 overflow-hidden rounded-lg border border-line">
                            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL; nothing to optimise */}
                            <img src={a.url} alt="Attached photo" className="size-full object-cover" />
                          </a>
                        ) : (
                          <span key={a.path} className="grid size-24 place-items-center rounded-lg border border-dashed border-line text-center text-[11px] text-muted">
                            Photo unavailable
                          </span>
                        )
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </Section>
          {actions}
        </div>

        <Section title="Details">
          <FactList>
            <Fact label="Raised by">
              {t.requesterName} · {role}
              {thread.ticket.riderCode ? ` · ${thread.ticket.riderCode}` : ""}
            </Fact>
            {canCall ? <Fact label="Phone">{t.requesterPhone ?? "No phone on file"}</Fact> : null}
            <Fact label="Priority">
              <StatusText tone={emergency ? "red" : t.priority === "high" ? "amber" : "neutral"}>
                {emergency ? "Emergency" : t.priority === "high" ? "High" : "Normal"}
              </StatusText>
            </Fact>
            <Fact label="Order">
              {t.orderId ? (
                <Link href={`/admin/orders/${t.orderId}`} className="text-data font-semibold text-accent-ink hover:underline">
                  {t.orderCode}
                </Link>
              ) : (
                "None"
              )}
            </Fact>
            <Fact label="Location">
              {t.locationUrl ? (
                <a href={t.locationUrl} target="_blank" rel="noreferrer" className="font-semibold text-accent-ink hover:underline">
                  Open in Maps
                </a>
              ) : (
                "Not shared"
              )}
            </Fact>
            <Fact label="Assigned to">{thread.ticket.assignedName ?? "Nobody yet"}</Fact>
            <Fact label="Opened">{formatDateTime(t.createdAt)}</Fact>
            {t.resolvedAt ? <Fact label="Resolved">{formatDateTime(t.resolvedAt)}</Fact> : null}
          </FactList>
        </Section>
      </div>
    </>
  );
}
