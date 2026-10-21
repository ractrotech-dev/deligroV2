import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { PageHeader, StatusText } from "@/components/admin/console";
import { getTicketForAdmin } from "@/lib/data-access/support";
import { TICKET_TONE } from "../tone";
import { TicketReplyForm } from "./reply-form";

export const dynamic = "force-dynamic";

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** One ticket: the whole thread (internal notes marked), attachments, reply and status. */
export default async function AdminTicketPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const profile = await requireRole("admin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await getTicketForAdmin(id, profile.id);
  if (!data) notFound();
  const { ticket, messages } = data;

  return (
    <>
      <PageHeader
        title={`#${ticket.number} · ${ticket.subject}`}
        description={`${ticket.requesterName} · ${ticket.requesterRole} · ${ticket.category}${ticket.orderId ? ` · order ${ticket.orderId.slice(0, 8)}` : ""}`}
        status={<StatusText tone={TICKET_TONE[ticket.status]}>{ticket.status.replaceAll("_", " ")}</StatusText>}
        back={{ href: "/admin/support", label: "Support" }}
      />
      <ol className="mt-4 space-y-3">
        {messages.map((m) => (
          <li
            key={m.id}
            className={`card p-4 ${m.internal ? "border-dashed bg-surface-2" : ""} ${m.authorRole === "admin" ? "ml-8" : "mr-8"}`}
          >
            <p className="mb-1 text-[12px] text-muted">
              {m.authorRole === "admin" ? (m.fromYou ? "You" : "Deligro") : ticket.requesterName} · {when.format(new Date(m.createdAt))}
              {m.internal ? " · internal note" : ""}
            </p>
            <p className="whitespace-pre-line text-[14.5px]">{m.body}</p>
            {m.attachments.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {m.attachments.map((a) =>
                  a.url ? (
                    <a key={a.path} href={a.url} target="_blank" rel="noreferrer" className="block size-24 overflow-hidden rounded-lg border border-line">
                      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimisable */}
                      <img src={a.url} alt="Attachment" className="size-full object-cover" />
                    </a>
                  ) : null
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <TicketReplyForm id={ticket.id} status={ticket.status} />
    </>
  );
}
