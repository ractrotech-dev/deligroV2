"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Empty, Section, StatusText, Toolbar } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { cn } from "@/lib/utils/cn";
import { formatDateTime } from "@/lib/utils/relative-time";
import type {
  AccountFeatureRole,
  AccountSwitch,
  FeatureAccount,
  FeatureAccountExceptions,
  FeatureActions,
  FeatureRow,
} from "@/lib/features/switch-types";
import { Segmented } from "./segmented";

export interface FeatureSection {
  role: AccountFeatureRole;
  rows: FeatureRow[];
  exceptions: FeatureAccountExceptions[];
}

const SECTIONS: { role: AccountFeatureRole; label: string; noun: string; everyone: string }[] = [
  { role: "customer", label: "Customers", noun: "customer", everyone: "all customers" },
  { role: "vendor", label: "Shops", noun: "shop", everyone: "all shops" },
  { role: "driver", label: "Riders", noun: "rider", everyone: "all riders" },
  { role: "manager", label: "Managers", noun: "manager", everyone: "all managers" },
];

const inputCls =
  "h-8 rounded-[var(--c-r)] border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:border-[var(--c-border-hover)]";

/**
 * Admin → App features. A table per section for what everyone gets, and a second
 * view to find one customer, shop, rider or manager and set their own. Every change
 * saves as it is made and the page re-reads, so what is shown is what is stored.
 *
 * Desktop only, like all of Admin: flat sections, tables and dropdown filters.
 */
export function AppFeaturesPanel({
  sections,
  actions,
  disabled,
  initialRole,
  initialAccount,
}: Readonly<{
  sections: FeatureSection[];
  actions: FeatureActions;
  /** The switch table isn't there yet (0052 not applied). */
  disabled: boolean;
  initialRole: AccountFeatureRole;
  /** A deep link to one account, from the Team list. */
  initialAccount: FeatureAccount | null;
}>) {
  const [role, setRole] = useState<AccountFeatureRole>(initialRole);
  const [view, setView] = useState<"all" | "one">(initialAccount ? "one" : "all");
  const [account, setAccount] = useState<FeatureAccount | null>(initialAccount);
  const [onlyFeature, setOnlyFeature] = useState<string | null>(null);

  const section = sections.find((s) => s.role === role) ?? sections[0];
  const meta = SECTIONS.find((s) => s.role === role) ?? SECTIONS[0];

  function pickRole(next: AccountFeatureRole) {
    setRole(next);
    setAccount(null);
    setOnlyFeature(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="c-tabs no-scrollbar" aria-label="Who">
          {SECTIONS.map((s) => (
            <button
              key={s.role}
              type="button"
              aria-current={s.role === role ? "page" : undefined}
              onClick={() => pickRole(s.role)}
              className="c-tab press"
            >
              {s.label}
            </button>
          ))}
        </nav>
        <nav className="c-tabs no-scrollbar" aria-label="View">
          <button type="button" aria-current={view === "all" ? "page" : undefined} onClick={() => setView("all")} className="c-tab press">
            For everyone
          </button>
          <button type="button" aria-current={view === "one" ? "page" : undefined} onClick={() => setView("one")} className="c-tab press">
            For one {meta.noun}
          </button>
        </nav>
      </div>

      {view === "all" ? (
        <EveryoneView
          key={role}
          section={section}
          everyone={meta.everyone}
          actions={actions}
          disabled={disabled}
          onShowDifferent={(feature) => {
            setOnlyFeature(feature);
            setAccount(null);
            setView("one");
          }}
        />
      ) : (
        <OneAccountView
          key={role}
          section={section}
          noun={meta.noun}
          actions={actions}
          disabled={disabled}
          account={account}
          setAccount={setAccount}
          onlyFeature={onlyFeature}
          clearOnlyFeature={() => setOnlyFeature(null)}
        />
      )}
    </div>
  );
}

function ErrorLine({ text }: Readonly<{ text: string | null }>) {
  if (!text) return null;
  return (
    <p role="alert" className="text-sm font-semibold text-deal">
      {text}
    </p>
  );
}

/* ---------------- for everyone ---------------- */

function EveryoneView({
  section,
  everyone,
  actions,
  disabled,
  onShowDifferent,
}: Readonly<{
  section: FeatureSection;
  everyone: string;
  actions: FeatureActions;
  disabled: boolean;
  onShowDifferent: (feature: string) => void;
}>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [state, setState] = useState<"" | "on" | "off" | "different">("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<"on" | "off" | null>(null);

  const groups = useMemo(() => [...new Set(section.rows.map((r) => r.group))], [section.rows]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return section.rows.filter((r) => {
      if (group && r.group !== group) return false;
      if (state === "on" && !r.on) return false;
      if (state === "off" && r.on) return false;
      if (state === "different" && r.different === 0) return false;
      return !needle || `${r.label} ${r.offMeans} ${r.key} ${r.group}`.toLowerCase().includes(needle);
    });
  }, [section.rows, q, group, state]);

  // Only what can be changed. A switch waiting on its feature has no box.
  const pickable = rows.filter((r) => !r.pending);
  const pickedShown = pickable.filter((r) => picked.has(r.key));
  const allPicked = pickable.length > 0 && pickedShown.length === pickable.length;
  const busy = disabled || pending;

  /** A row is stored only when it differs from the default: back to default means no row. */
  function input(row: FeatureRow, want: boolean) {
    return { feature: row.key, subjectId: null, enabled: want === row.defaultOn ? null : want };
  }

  function setOne(row: FeatureRow, want: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await actions.save(input(row, want));
      if (!res.ok) setError(res.error ?? "Could not save.");
      router.refresh();
    });
  }

  function setPickedTo(want: boolean) {
    setError(null);
    setConfirming(null);
    const changes = pickedShown.filter((r) => r.on !== want).map((r) => input(r, want));
    if (!changes.length) return;
    startTransition(async () => {
      const res = await actions.saveMany(changes);
      if (res.ok) setPicked(new Set());
      else setError(res.error ?? "Could not save.");
      router.refresh();
    });
  }

  const columns: Column<FeatureRow>[] = [
    {
      key: "pick",
      header: "",
      width: "w-[36px]",
      cell: (r) =>
        r.pending ? null : (
          <input
            type="checkbox"
            aria-label={`Select ${r.label}`}
            checked={picked.has(r.key)}
            disabled={busy}
            onChange={(e) =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (e.target.checked) next.add(r.key);
                else next.delete(r.key);
                return next;
              })
            }
          />
        ),
    },
    {
      key: "feature",
      header: "Feature",
      width: "w-[220px]",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block text-[13px] font-semibold text-ink">{r.label}</span>
          {r.defaultOn ? null : <span className="block text-[11.5px] text-muted">Off until given</span>}
        </span>
      ),
    },
    { key: "group", header: "Group", width: "w-[120px]", cell: (r) => <span className="text-[12.5px] text-muted">{r.group}</span> },
    {
      key: "off",
      header: "Off means",
      cell: (r) => (
        <span className="block text-[12.5px] text-muted">
          {r.offMeans}
          {r.pending ? <span className="mt-0.5 block font-semibold text-ink">{r.pending}</span> : null}
        </span>
      ),
    },
    {
      key: "different",
      header: "Different",
      align: "right",
      width: "w-[90px]",
      cell: (r) =>
        r.different ? (
          <button type="button" onClick={() => onShowDifferent(r.key)} className="text-data text-[13px] font-semibold text-accent-ink hover:underline">
            {r.different}
          </button>
        ) : (
          <span className="text-data text-[13px] text-muted">0</span>
        ),
    },
    {
      key: "switch",
      header: "For everyone",
      align: "right",
      width: "w-[140px]",
      cell: (r) =>
        r.pending ? (
          <StatusText tone="neutral">{r.on ? "On" : "Off"} · locked</StatusText>
        ) : (
          <Segmented
            label={r.label}
            value={r.on ? "on" : "off"}
            options={[
              ["on", "On"],
              ["off", "Off"],
            ]}
            disabled={busy}
            onChange={(v) => setOne(r, v === "on")}
          />
        ),
    },
  ];

  return (
    <Section title="Features" meta={`${rows.length} of ${section.rows.length}`}>
      <div className="space-y-3">
        <Toolbar>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search features"
            aria-label="Search features"
            className={cn(inputCls, "min-w-[220px] flex-1")}
          />
          <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group" className={inputCls}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select
            value={state}
            onChange={(e) => setState(e.target.value as typeof state)}
            aria-label="On or off"
            className={inputCls}
          >
            <option value="">On and off</option>
            <option value="on">On</option>
            <option value="off">Off</option>
            <option value="different">Has a different setting</option>
          </select>
        </Toolbar>

        <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-muted">
          <label className="flex items-center gap-2 font-semibold text-ink">
            <input
              type="checkbox"
              checked={allPicked}
              disabled={busy || pickable.length === 0}
              onChange={(e) => setPicked(e.target.checked ? new Set(pickable.map((r) => r.key)) : new Set())}
            />
            Select all {pickable.length} shown
          </label>
          <span>{pickedShown.length} selected</span>
          {confirming ? (
            <>
              <span className="font-semibold text-ink">
                Turn {confirming} {pickedShown.length} {pickedShown.length === 1 ? "feature" : "features"} for {everyone}?
              </span>
              <button type="button" className="c-btn c-btn-dark press h-8" onClick={() => setPickedTo(confirming === "on")}>
                Yes, turn {confirming}
              </button>
              <button type="button" className="c-btn c-btn-quiet press h-8" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="c-btn c-btn-outline press h-8 disabled:opacity-50" disabled={busy || pickedShown.length === 0} onClick={() => setConfirming("on")}>
                Turn on
              </button>
              <button type="button" className="c-btn c-btn-outline press h-8 disabled:opacity-50" disabled={busy || pickedShown.length === 0} onClick={() => setConfirming("off")}>
                Turn off
              </button>
            </>
          )}
        </div>

        <ErrorLine text={error} />

        <DataTable
          caption="Features"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          dense
          minWidth={960}
          empty={<Empty>No feature matches these filters.</Empty>}
        />
      </div>
    </Section>
  );
}

/* ---------------- for one account ---------------- */

function OneAccountView({
  section,
  noun,
  actions,
  disabled,
  account,
  setAccount,
  onlyFeature,
  clearOnlyFeature,
}: Readonly<{
  section: FeatureSection;
  noun: string;
  actions: FeatureActions;
  disabled: boolean;
  account: FeatureAccount | null;
  setAccount: (a: FeatureAccount | null) => void;
  onlyFeature: string | null;
  clearOnlyFeature: () => void;
}>) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FeatureAccount[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  // Debounced, and only the newest answer counts: a slow reply must not overwrite
  // the list for what is in the box now.
  useEffect(() => {
    const seq = ++searchSeq.current;
    const needle = q.trim();
    if (needle.length < 2) return;
    const timer = setTimeout(() => {
      setSearching(true);
      actions
        .search(section.role, needle)
        .then((list) => {
          if (seq === searchSeq.current) {
            setResults(list);
            setError(null);
          }
        })
        .catch(() => {
          if (seq === searchSeq.current) setError("Could not search. Try again.");
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [q, section.role, actions]);

  const accountColumns: Column<FeatureAccount>[] = [
    {
      key: "name",
      header: `${noun[0].toUpperCase()}${noun.slice(1)}`,
      cell: (a) => (
        <button type="button" onClick={() => setAccount(a)} className="text-left text-[13px] font-semibold text-accent-ink hover:underline">
          {a.name}
        </button>
      ),
    },
    { key: "detail", header: "Details", cell: (a) => <span className="text-[12.5px] text-muted">{a.detail ?? "—"}</span> },
  ];

  const exceptions = onlyFeature
    ? section.exceptions.filter((x) => x.features.includes(onlyFeature))
    : section.exceptions;
  const onlyLabel = onlyFeature ? section.rows.find((r) => r.key === onlyFeature)?.label : null;
  const showResults = q.trim().length >= 2 && results;

  return (
    <div className="space-y-5">
      <Section title={`Find a ${noun}`} meta={searching ? "Searching…" : undefined}>
        <div className="space-y-3">
          <Toolbar>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={section.role === "vendor" ? "Shop name" : "Name or phone number"}
              aria-label={`Find a ${noun}`}
              className={cn(inputCls, "min-w-[280px] flex-1")}
            />
          </Toolbar>
          <ErrorLine text={error} />
          {showResults ? (
            <DataTable
              caption="Search results"
              columns={accountColumns}
              rows={results}
              rowKey={(a) => a.id}
              dense
              minWidth={480}
              empty={<Empty>{`No ${noun} matches that.`}</Empty>}
            />
          ) : null}
        </div>
      </Section>

      {account ? (
        <AccountTable
          key={account.id}
          section={section}
          account={account}
          actions={actions}
          disabled={disabled}
          onClose={() => setAccount(null)}
        />
      ) : null}

      <Section
        title={onlyLabel ? `Different from everyone: ${onlyLabel}` : "Different from everyone"}
        meta={`${exceptions.length}`}
      >
        <div className="space-y-2">
          {onlyLabel ? (
            <button type="button" onClick={clearOnlyFeature} className="text-[12.5px] font-semibold text-accent-ink hover:underline">
              Show every feature
            </button>
          ) : null}
          <DataTable
            caption={`Accounts with a different setting`}
            columns={[
              ...accountColumns.map((c) => ({
                ...c,
                cell: (x: FeatureAccountExceptions) => c.cell(x.account),
              })),
              {
                key: "count",
                header: "Features",
                align: "right" as const,
                width: "w-[90px]",
                cell: (x: FeatureAccountExceptions) => <span className="text-data text-[13px]">{x.features.length}</span>,
              },
            ]}
            rows={exceptions}
            rowKey={(x) => x.account.id}
            dense
            minWidth={480}
            empty={<Empty>{`No ${noun} has a different setting.`}</Empty>}
          />
        </div>
      </Section>
    </div>
  );
}

type Choice = "same" | "on" | "off";

interface AccountRow extends FeatureRow {
  choice: Choice;
  changedBy: string | null;
  changedAt: string | null;
}

function AccountTable({
  section,
  account,
  actions,
  disabled,
  onClose,
}: Readonly<{
  section: FeatureSection;
  account: FeatureAccount;
  actions: FeatureActions;
  disabled: boolean;
  onClose: () => void;
}>) {
  const router = useRouter();
  const [own, setOwn] = useState<AccountSwitch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { role } = section;
  const { id } = account;

  const load = useCallback(
    () =>
      actions
        .loadAccount(role, id)
        .then(setOwn)
        .catch(() => setError("Could not read this account's settings. Try again.")),
    [actions, role, id]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const rows: AccountRow[] = section.rows.map((r) => {
    const s = own?.find((x) => x.feature === r.key);
    return {
      ...r,
      choice: s?.own == null ? "same" : s.own ? "on" : "off",
      changedBy: s?.changedBy ?? null,
      changedAt: s?.changedAt ?? null,
    };
  });

  function set(row: AccountRow, choice: Choice) {
    setError(null);
    startTransition(async () => {
      const res = await actions.save({
        feature: row.key,
        subjectId: id,
        enabled: choice === "same" ? null : choice === "on",
      });
      if (!res.ok) setError(res.error ?? "Could not save.");
      await load();
      router.refresh();
    });
  }

  const columns: Column<AccountRow>[] = [
    {
      key: "feature",
      header: "Feature",
      width: "w-[220px]",
      cell: (r) => <span className="text-[13px] font-semibold text-ink">{r.label}</span>,
    },
    { key: "group", header: "Group", width: "w-[120px]", cell: (r) => <span className="text-[12.5px] text-muted">{r.group}</span> },
    {
      key: "everyone",
      header: "Everyone",
      width: "w-[80px]",
      cell: (r) => <span className="text-[12.5px] text-muted">{r.on ? "On" : "Off"}</span>,
    },
    {
      key: "result",
      header: "Result",
      width: "w-[80px]",
      cell: (r) => {
        const on = r.choice === "same" ? r.on : r.choice === "on";
        return <StatusText tone={on ? "green" : "red"}>{on ? "On" : "Off"}</StatusText>;
      },
    },
    {
      key: "who",
      header: "Changed by",
      cell: (r) => (
        <span className="text-[12.5px] text-muted">
          {r.pending
            ? r.pending
            : r.changedBy
              ? `${r.changedBy}${r.changedAt ? ` · ${formatDateTime(r.changedAt)}` : ""}`
              : "—"}
        </span>
      ),
    },
    {
      key: "choice",
      header: "This account",
      align: "right",
      width: "w-[260px]",
      cell: (r) => (
        <Segmented
          label={r.label}
          value={r.choice}
          options={[
            ["same", "Same as everyone"],
            ["on", "On"],
            ["off", "Off"],
          ]}
          disabled={disabled || pending || own === null || Boolean(r.pending)}
          onChange={(v) => set(r, v)}
        />
      ),
    },
  ];

  return (
    <Section title={account.name} meta={account.detail ?? undefined}>
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onClose} className="c-btn c-btn-quiet press h-8">
            Close
          </button>
        </div>
        <ErrorLine text={error} />
        <DataTable
          caption={`What ${account.name} can use`}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          dense
          minWidth={960}
        />
      </div>
    </Section>
  );
}
