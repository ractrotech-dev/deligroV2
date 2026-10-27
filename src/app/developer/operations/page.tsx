import { AdminHero, Panel } from "@/components/admin/admin-ui";
import { requireRole } from "@/lib/auth";
import { getPlatformLock, listPlatformLockEvents } from "@/lib/platform-lock";
import type { PlatformLockLevel } from "@/lib/platform-lock-rules";
import { setPlatformLockAction } from "./actions";

export const dynamic = "force-dynamic";

const LEVELS: { value: PlatformLockLevel; title: string; detail: string }[] = [
  { value: "off", title: "Running", detail: "Normal operation." },
  {
    value: "orders",
    title: "Stop new orders",
    detail: "No new orders anywhere (site, apps, phone orders). Customers see your message. Everything else keeps working.",
  },
  {
    value: "full",
    title: "Pause operations",
    detail:
      "No new orders, and the Admin console and Manager app show a paused screen with your message. Shops and riders can still finish orders already placed.",
  },
];

const LABEL: Record<PlatformLockLevel, string> = { off: "Running", orders: "New orders stopped", full: "Operations paused" };

/**
 * Developer → Operations: the platform developer's pause switch (0177). It is
 * visible to the business (customers see the message; staff see "paused by the
 * platform developer"), every change is recorded, and only a developer account
 * can set or lift it. It is a switch, not DRM: whoever owns the database can
 * remove it.
 */
export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireRole("developer");
  const [{ saved, error }, lock, events] = await Promise.all([searchParams, getPlatformLock(), listPlatformLockEvents()]);
  const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Operations"
        subtitle="Stop new orders or pause the whole platform. Customers and staff see the message you write here; every change is recorded below."
      />
      {saved && <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm font-semibold">Saved.</p>}
      {error && <p className="rounded-xl bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-600">{error}</p>}

      <Panel title="Now" subtitle={lock.since ? `Since ${fmt.format(new Date(lock.since))} IST` : undefined}>
        <p className="text-lg font-extrabold">{LABEL[lock.level]}</p>
        {lock.level !== "off" && lock.message && <p className="mt-1 text-sm text-muted">“{lock.message}”</p>}
      </Panel>

      <Panel title="Change">
        <form action={setPlatformLockAction} className="flex flex-col gap-3">
          {LEVELS.map((l) => (
            <label key={l.value} className="flex cursor-pointer gap-3 rounded-xl border border-line p-3">
              <input type="radio" name="level" value={l.value} defaultChecked={lock.level === l.value} className="mt-1" />
              <span>
                <span className="block font-bold">{l.title}</span>
                <span className="block text-sm text-muted">{l.detail}</span>
              </span>
            </label>
          ))}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Message customers and staff see</span>
            <textarea
              name="message"
              maxLength={500}
              rows={3}
              defaultValue={lock.level !== "off" ? lock.message : ""}
              placeholder="Ordering is paused for now. Please check back later."
              className="rounded-xl border border-line bg-surface p-3"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirm" value="yes" />
            I understand this stops new orders for every customer.
          </label>
          <button type="submit" className="self-start rounded-xl bg-ink px-4 py-2 text-sm font-bold text-bg">
            Save
          </button>
        </form>
      </Panel>

      <Panel title="History">
        {events.length === 0 ? (
          <p className="text-sm text-muted">No changes yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {events.map((e, i) => (
              <li key={i}>
                <span className="font-semibold">{LABEL[e.level]}</span> · {fmt.format(new Date(e.at))} IST
                {e.actor ? ` · ${e.actor}` : ""}
                {e.message ? <span className="block text-muted">“{e.message}”</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
