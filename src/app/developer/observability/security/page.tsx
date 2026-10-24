import { ShieldCheck } from "lucide-react";
import { AdminHero, EmptyState, Panel, RangeTabs } from "@/components/admin/admin-ui";
import { Ago, Figure, FigureStrip, NotMigratedNotice } from "@/components/developer/obs-ui";
import { getSignInSummary, type SignInRow } from "@/lib/obs/read";

/**
 * Observability → Security. Who signed in, who could not, and sign-ins from a
 * phone or country that person has not used before (migration 0171).
 *
 * Production only. A failed attempt is tied to the account of the number that
 * was typed, so "who keeps failing" has a name; only the last four digits of a
 * number are ever kept.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");
const RANGES = [1, 7, 30];

function who(r: { name: string | null; actorId: string | null; phoneTail: string | null }): string {
  if (r.name) return r.name;
  if (r.actorId) return "Unnamed account";
  return r.phoneTail ? `Unknown number ending ${r.phoneTail}` : "Unknown number";
}

function line(r: SignInRow): string {
  const parts = [r.method === "otp" ? "code" : "password", r.device, r.country].filter(Boolean);
  return parts.join(" · ");
}

export default async function SecurityPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ days?: string }> }>) {
  const sp = await searchParams;
  const days = RANGES.includes(Number(sp.days)) ? Number(sp.days) : 7;
  const summary = await getSignInSummary(days);
  const s = summary.data;
  const rate = s.total ? Math.round((s.failures / s.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Security"
        subtitle="Sign-ins and failed attempts, and sign-ins from a new phone or country."
        action={
          <RangeTabs
            options={RANGES.map((d, i) => ({ value: i, label: d === 1 ? "Today" : `${d} days` }))}
            active={RANGES.indexOf(days)}
            hrefFor={(i) => `/developer/observability/security?days=${RANGES[i]}`}
          />
        }
      />

      {summary.notMigrated ? <NotMigratedNotice /> : null}

      <FigureStrip>
        <Figure label="Sign-ins" value={nf.format(s.successes)} note={`in the last ${days === 1 ? "day" : `${days} days`}`} />
        <Figure label="Failed attempts" value={nf.format(s.failures)} tone={s.failures > 0 ? "warn" : undefined} />
        <Figure label="Failure rate" value={`${rate}%`} tone={rate >= 30 ? "bad" : rate >= 10 ? "warn" : undefined} />
        <Figure label="New phone or country" value={nf.format(s.risky.length)} note="for that person" tone={s.risky.length > 0 ? "warn" : undefined} />
      </FigureStrip>

      {s.total === 0 ? (
        <Panel>
          <EmptyState
            icon={ShieldCheck}
            title="No sign-ins recorded yet"
            description="Sign-ins are recorded from the phone-code and password sign-in screens once migration 0171 is applied."
          />
        </Panel>
      ) : (
        <div className="flex flex-col gap-4 @3xl:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <Panel title="New phone or country" subtitle="A person signing in from a device or country they have not used before. Their very first sign-in is never counted.">
              {s.risky.length === 0 ? (
                <p className="py-2 text-[13px] text-muted">None in this window.</p>
              ) : (
                <ul className="flex flex-col">
                  {s.risky.map((r, i) => (
                    <li key={`${r.occurredAt}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line/60 py-2 text-[13px] last:border-0">
                      <span className="min-w-0 flex-1 truncate font-semibold text-ink">{who(r)}</span>
                      <span className="text-[11.5px] text-muted">
                        {[r.newDevice ? `new phone: ${r.device}` : null, r.newCountry ? `new country: ${r.country}` : null].filter(Boolean).join(" · ")}
                      </span>
                      <span className="shrink-0"><Ago iso={r.occurredAt} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Recent failed attempts">
              {s.recentFailures.length === 0 ? (
                <p className="py-2 text-[13px] text-muted">None in this window.</p>
              ) : (
                <ul className="flex flex-col">
                  {s.recentFailures.map((r, i) => (
                    <li key={`${r.occurredAt}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line/60 py-2 text-[13px] last:border-0">
                      <span className="min-w-0 flex-1 truncate font-semibold text-ink">{who(r)}</span>
                      <span className="text-[11.5px] text-muted">{[r.reason, line(r)].filter(Boolean).join(" · ")}</span>
                      <span className="shrink-0"><Ago iso={r.occurredAt} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="flex w-full flex-col gap-4 @3xl:w-[340px]">
            <Panel title="Most failed attempts" subtitle="Per account, or per number when it matches no account.">
              {s.failingAccounts.length === 0 ? (
                <p className="py-2 text-[13px] text-muted">None.</p>
              ) : (
                <ul className="flex flex-col">
                  {s.failingAccounts.map((a, i) => (
                    <li key={`${a.actorId ?? a.phoneTail}-${i}`} className="flex items-center gap-3 border-b border-line/60 py-2 text-[13px] last:border-0">
                      <span className="min-w-0 flex-1 truncate font-semibold text-ink">{who(a)}</span>
                      {a.role ? <span className="text-[11.5px] text-muted">{a.role}</span> : null}
                      <span className="text-data text-[12px] tabular-nums text-ink">{nf.format(a.failures)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Where from">
              <ul className="flex flex-col">
                {s.countries.map((c) => (
                  <li key={c.country} className="flex items-center justify-between border-b border-line/60 py-1.5 text-[13px] last:border-0">
                    <span className="text-ink">{c.country}</span>
                    <span className="text-data tabular-nums text-muted">{nf.format(c.count)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
