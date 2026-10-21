import { requireRole } from "@/lib/auth";
import { PageHeader, StatusText } from "@/components/admin/console";
import { listAnnouncements } from "@/lib/data-access/user-notifications";
import { AnnouncementForm, EndAnnouncementButton } from "./announcement-form";

/**
 * Admin → Announcements: a message to every shop, rider or manager (or all of
 * them), shown pinned in their app's inbox while it runs and pushed when it
 * starts now.
 */
export const dynamic = "force-dynamic";

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default async function AdminAnnouncementsPage() {
  await requireRole("admin");
  const list = await listAnnouncements();
  return (
    <>
      <PageHeader title="Announcements" description="Tell shops, riders or managers something. It pins to the top of their inbox while it runs." />
      <AnnouncementForm />
      <ul className="card mt-6 divide-y divide-line">
        {list.length === 0 ? <li className="p-5 text-muted">No announcements yet.</li> : null}
        {list.map((a) => {
          const live = a.state === "live";
          const scheduled = a.state === "scheduled";
          return (
            <li key={a.id} className="flex items-start gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-muted">
                  For {a.audience === "all" ? "everyone working" : `${a.audience}s`} · {when.format(new Date(a.startsAt))}
                  {a.endsAt ? ` – ${when.format(new Date(a.endsAt))}` : ""}
                </p>
                <p className="text-[15px] font-semibold">{a.title}</p>
                <p className="whitespace-pre-line text-[14px] text-ink/80">{a.body}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <StatusText tone={live ? "green" : scheduled ? "blue" : "neutral"}>{live ? "Live" : scheduled ? "Scheduled" : "Ended"}</StatusText>
                {live || scheduled ? <EndAnnouncementButton id={a.id} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
