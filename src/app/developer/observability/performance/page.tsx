import Link from "next/link";
import { Gauge } from "lucide-react";
import { AdminHero, EmptyState, Panel } from "@/components/admin/admin-ui";
import { NotMigratedNotice } from "@/components/developer/obs-ui";
import { getPageSpeed } from "@/lib/obs/read";
import { DOORS } from "@/lib/obs/page-speed";
import { cn } from "@/lib/utils/cn";

/**
 * Observability → Performance. How long pages take for real people, measured
 * in their own browsers (migration 0172): per page, the typical wait and the
 * slowest 1 in 10, for the visitor and for our server separately, so a slow
 * page can be told apart from a slow phone or connection. Slowest first.
 */
export const dynamic = "force-dynamic";

const DAYS = [1, 7];
const DEVICES = ["phone", "computer"] as const;

function seconds(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Plain-language colour: under 2.5 s is fine, over 4 s is slow (the web's own guide for page loads). */
function tone(ms: number | null): string {
  if (ms === null) return "text-muted";
  if (ms > 4000) return "text-deal font-semibold";
  if (ms > 2500) return "text-amber-600 font-semibold";
  return "text-ink";
}

type Query = { days?: string; door?: string; device?: string };

function href(current: Query, patch: Query): string {
  const q = { ...current, ...patch };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  const s = params.toString();
  return `/developer/observability/performance${s ? `?${s}` : ""}`;
}

function Chip({ on, to, children }: Readonly<{ on: boolean; to: string; children: React.ReactNode }>) {
  return (
    <Link
      href={to}
      className={cn(
        "rounded-full border px-3 py-1 text-[12.5px] font-semibold",
        on ? "border-ink bg-ink text-surface" : "border-line text-muted hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}

export default async function PerformancePage({ searchParams }: Readonly<{ searchParams: Promise<Query> }>) {
  const sp = await searchParams;
  const days = DAYS.includes(Number(sp.days)) ? Number(sp.days) : 1;
  const door = DOORS.includes(sp.door as (typeof DOORS)[number]) ? sp.door! : null;
  const device = DEVICES.includes(sp.device as (typeof DEVICES)[number]) ? (sp.device as "phone" | "computer") : null;
  const speed = await getPageSpeed({ days, door, device });
  const current: Query = { days: String(days), door: door ?? undefined, device: device ?? undefined };

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Performance"
        subtitle="How long pages take for real people. Typical wait and the slowest 1 in 10, split into our server's share and the rest (their phone and connection)."
      />

      {speed.notMigrated ? <NotMigratedNotice /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {DAYS.map((d) => (
          <Chip key={d} on={d === days} to={href(current, { days: String(d) })}>{d === 1 ? "Today" : "7 days"}</Chip>
        ))}
        <span className="mx-1 h-5 w-px bg-line" />
        <Chip on={!door} to={href(current, { door: undefined })}>All parts</Chip>
        {DOORS.map((d) => (
          <Chip key={d} on={door === d} to={href(current, { door: d })}>{d}</Chip>
        ))}
        <span className="mx-1 h-5 w-px bg-line" />
        <Chip on={!device} to={href(current, { device: undefined })}>All devices</Chip>
        <Chip on={device === "phone"} to={href(current, { device: "phone" })}>Phones</Chip>
        <Chip on={device === "computer"} to={href(current, { device: "computer" })}>Computers</Chip>
      </div>

      <Panel subtitle="Pages with at least 3 visits. A dash in the server columns means every visit was answered from the browser's own cache.">
        {speed.data.length === 0 ? (
          <EmptyState
            icon={Gauge}
            title="No visits measured yet"
            description="Page times are collected from visitors' browsers once migration 0172 is applied and the site is deployed."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="text-[11.5px] text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-semibold">Page</th>
                  <th className="py-2 pr-3 text-right font-semibold">Visits</th>
                  <th className="py-2 pr-3 text-right font-semibold">Typical wait</th>
                  <th className="py-2 pr-3 text-right font-semibold">Slowest 1 in 10</th>
                  <th className="py-2 pr-3 text-right font-semibold">Server, typical</th>
                  <th className="py-2 text-right font-semibold">Server, slowest 1 in 10</th>
                </tr>
              </thead>
              <tbody>
                {speed.data.map((r) => (
                  <tr key={r.page} className="border-b border-line/60 last:border-0">
                    <td className="text-data max-w-[280px] truncate py-2 pr-3 text-ink">{r.page}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted">{r.visits}</td>
                    <td className={cn("py-2 pr-3 text-right tabular-nums", tone(r.visitorP50))}>{seconds(r.visitorP50)}</td>
                    <td className={cn("py-2 pr-3 text-right tabular-nums", tone(r.visitorP90))}>{seconds(r.visitorP90)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted">{seconds(r.serverP50)}</td>
                    <td className="py-2 text-right tabular-nums text-muted">{seconds(r.serverP90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
