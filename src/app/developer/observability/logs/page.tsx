import { ScrollText } from "lucide-react";
import { AdminHero, EmptyState, Panel } from "@/components/admin/admin-ui";
import { FilterChips, SearchForm } from "@/components/admin/admin-filters";
import {
  AttrGrid,
  Ago,
  LevelTag,
  NotMigratedNotice,
  StackViewer,
  ms,
} from "@/components/developer/obs-ui";
import { listEvents, OBS_RANGES, type ObsRange } from "@/lib/obs/read";
import type { ObsEnv, ObsLevel } from "@/lib/obs/types";
import { OBS_PROVIDERS } from "@/lib/obs/types";

/**
 * Observability → Logs. The structured log viewer.
 *
 * Not a text console. Every row here is a typed record with a level, a source,
 * a duration and a set of correlation ids, so filtering is a query rather than
 * a grep — and the fields that matter (trace, request, order) are columns, not
 * substrings someone has to spot inside a sentence.
 *
 * Two behaviours worth knowing about:
 *
 *   * **The level filter is a floor, not an equality.** Asking for warnings and
 *     being shown warnings while errors are hidden is the opposite of what
 *     anyone means by it.
 *   * **Rows expand in place** using `<details>`, so the stack and the attribute
 *     bag are one click away and no row is ever tall enough to lose your place.
 *     No JavaScript: this page has to work on a bad connection during an
 *     incident, which is the only time anybody opens it.
 */
export const dynamic = "force-dynamic";

const LEVELS: ObsLevel[] = ["debug", "info", "warn", "error", "fatal"];
const KINDS = ["http", "error", "provider", "domain", "client", "db", "log"];
const ENVS: ObsEnv[] = ["production", "preview", "development"];

interface Query {
  level?: string;
  kind?: string;
  provider?: string;
  env?: string;
  range?: string;
  q?: string;
  traceId?: string;
  requestId?: string;
  orderId?: string;
  route?: string;
}

function href(current: Query, patch: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return `/developer/observability/logs${qs ? `?${qs}` : ""}`;
}

export default async function LogsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Query>;
}>) {
  const sp = await searchParams;

  const level = LEVELS.includes(sp.level as ObsLevel)
    ? (sp.level as ObsLevel)
    : null;
  const kind = KINDS.includes(sp.kind ?? "") ? sp.kind! : null;
  const provider = OBS_PROVIDERS.includes(sp.provider as never)
    ? sp.provider!
    : null;
  const env = ENVS.includes(sp.env as ObsEnv) ? (sp.env as ObsEnv) : "production";
  const range = OBS_RANGES.some((r) => r.value === sp.range)
    ? (sp.range as ObsRange)
    : "1h";

  const events = await listEvents({
    env,
    level: level ?? "all",
    kind: kind ?? undefined,
    provider: provider ?? undefined,
    range,
    q: sp.q,
    traceId: sp.traceId,
    requestId: sp.requestId,
    orderId: sp.orderId,
    route: sp.route,
    limit: 300,
  });

  // A pinned id is the reason the page was opened — surfaced as a line rather
  // than hidden among the chips, so it is obvious why the list is short.
  const pinned = sp.traceId ?? sp.requestId ?? sp.orderId ?? sp.route ?? null;

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Logs"
        subtitle="Structured events. Filter by level, service, provider, or an id from anywhere else in the console."
        tag={`${events.data.length} rows`}
      />

      {events.notMigrated ? <NotMigratedNotice /> : null}

      {pinned ? (
        <p className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink">
          Filtered to <code className="text-data">{pinned}</code>.{" "}
          <a
            href={href({}, { env: sp.env, range: sp.range })}
            className="underline underline-offset-2"
          >
            Clear
          </a>
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <SearchForm
          action="/developer/observability/logs"
          defaultValue={sp.q}
          placeholder="Search message text"
          carry={{
            level: sp.level,
            kind: sp.kind,
            provider: sp.provider,
            env: sp.env,
            range: sp.range,
            traceId: sp.traceId,
            requestId: sp.requestId,
            orderId: sp.orderId,
          }}
        />
        <FilterChips
          label="Minimum level"
          options={LEVELS.map((l) => ({ value: l, label: l }))}
          active={level}
          hrefFor={(v) => href(sp, { level: v ?? undefined })}
        />
        <FilterChips
          label="Kind"
          options={KINDS.map((k) => ({ value: k, label: k }))}
          active={kind}
          hrefFor={(v) => href(sp, { kind: v ?? undefined })}
        />
        <div className="flex flex-wrap gap-4">
          <FilterChips
            label="Provider"
            options={OBS_PROVIDERS.map((p) => ({ value: p, label: p }))}
            active={provider}
            hrefFor={(v) => href(sp, { provider: v ?? undefined })}
          />
          <FilterChips
            label="Window"
            options={OBS_RANGES.map((r) => ({ value: r.value, label: r.label }))}
            active={range}
            hrefFor={(v) => href(sp, { range: v ?? undefined })}
          />
          <FilterChips
            label="Environment"
            options={ENVS.map((e) => ({ value: e, label: e }))}
            active={env}
            hrefFor={(v) => href(sp, { env: v ?? undefined })}
          />
        </div>
      </div>

      <Panel>
        {events.data.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No events"
            description={
              events.notMigrated
                ? "Observability is not installed on this database."
                : "Nothing matches these filters in this window. Note that successful, fast requests are sampled at 10% — a quiet log is not proof of a quiet platform."
            }
          />
        ) : (
          <ul className="-mx-2 flex flex-col">
            {events.data.map((e) => (
              <li key={e.id} className="border-b border-line/60 last:border-0">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-baseline gap-2 px-2 py-1.5 hover:bg-[var(--line)]/20">
                    <LevelTag level={e.level} />
                    <Ago iso={e.occurredAt} className="w-[64px] shrink-0" />
                    <span className="text-data w-[130px] shrink-0 truncate text-[11.5px] text-muted">
                      {e.source}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                      {e.message}
                    </span>
                    {e.durationMs !== null ? (
                      <span className="text-data hidden w-[56px] shrink-0 text-right text-[11.5px] tabular-nums text-muted @xl:inline">
                        {ms(e.durationMs)}
                      </span>
                    ) : null}
                    {e.httpStatus ? (
                      <span className="text-data w-[32px] shrink-0 text-right text-[11.5px] tabular-nums text-muted">
                        {e.httpStatus}
                      </span>
                    ) : null}
                  </summary>

                  <div className="flex flex-col gap-3 px-2 pb-3 pt-1">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-[12px]">
                      <dt className="text-muted">Time</dt>
                      <dd className="text-data text-ink">
                        {new Date(e.occurredAt).toISOString()}
                      </dd>
                      {e.httpRoute ? (
                        <>
                          <dt className="text-muted">Endpoint</dt>
                          <dd className="text-data text-ink">
                            {e.httpMethod} {e.httpRoute}
                          </dd>
                        </>
                      ) : null}
                      {e.errorType ? (
                        <>
                          <dt className="text-muted">Error type</dt>
                          <dd className="text-data text-ink">{e.errorType}</dd>
                        </>
                      ) : null}
                      {e.traceId ? (
                        <>
                          <dt className="text-muted">Trace</dt>
                          <dd>
                            <a
                              href={`/developer/observability/traces/${e.traceId}`}
                              className="text-data break-all text-ink underline underline-offset-2"
                            >
                              {e.traceId}
                            </a>
                          </dd>
                        </>
                      ) : null}
                      {e.requestId ? (
                        <>
                          <dt className="text-muted">Request</dt>
                          <dd className="text-data break-all text-ink">
                            {e.requestId}
                          </dd>
                        </>
                      ) : null}
                      {e.orderId ? (
                        <>
                          <dt className="text-muted">Order</dt>
                          <dd>
                            <a
                              href={`/admin/orders/${e.orderId}`}
                              className="text-data text-ink underline underline-offset-2"
                            >
                              {e.orderId.slice(0, 8).toUpperCase()}
                            </a>
                          </dd>
                        </>
                      ) : null}
                      {e.release ? (
                        <>
                          <dt className="text-muted">Release</dt>
                          <dd className="text-data text-ink">{e.release}</dd>
                        </>
                      ) : null}
                    </dl>

                    {Object.keys(e.attrs).length ? (
                      <AttrGrid attrs={e.attrs} />
                    ) : null}

                    {e.stack ? <StackViewer stack={e.stack} /> : null}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="px-1 text-[11px] italic text-muted">
        Raw events are kept 14 days and then dropped a partition at a time.
        Aggregate counts survive in the rollups; individual rows do not.
      </p>
    </div>
  );
}
