import Link from "next/link";
import { Trophy } from "lucide-react";
import { PageHeader, StatusText } from "@/components/admin/console";
import { PreviewNotice } from "@/components/admin/admin-ui";
import { DataTable, TableFooter, type Column } from "@/components/admin/data-table";
import { MIGRATION_MISSING, describeRule } from "@/lib/rider/admin-money";
import type { IncentiveRule } from "@/lib/rider/earnings-math";
import { RuleForm, RuleToggle } from "./rule-controls";

export type Rule = IncentiveRule & { awards: number };
export type RulesSearch = { edit?: string; new?: string };

const columns: Column<Rule>[] = [
  {
    key: "name",
    header: "Rule",
    role: "title",
    cell: (r) => {
      const d = describeRule(r);
      return (
        <span className="block min-w-0">
          <span className="block truncate text-[13px] font-semibold">{r.name}</span>
          <span className="block text-[11.5px] leading-snug text-muted">{d.target}</span>
        </span>
      );
    },
  },
  {
    key: "when",
    header: "When",
    width: "w-[200px]",
    cell: (r) => {
      const d = describeRule(r);
      return (
        <span className="block text-[12px] leading-snug text-muted">
          {d.window}
          <br />
          {d.dates}
        </span>
      );
    },
  },
  {
    key: "status",
    header: "Status",
    width: "w-[110px]",
    cell: (r) => <StatusText tone={r.active ? "green" : "neutral"}>{r.active ? "Active" : "Off"}</StatusText>,
  },
  {
    key: "awards",
    header: "Paid out",
    align: "right",
    width: "w-[100px]",
    cell: (r) => (
      <span className={r.awards > 0 ? "text-data text-[12.5px] tabular-nums" : "text-data text-[12.5px] tabular-nums text-muted"}>
        {r.awards} {r.awards === 1 ? "time" : "times"}
      </span>
    ),
  },
  {
    key: "actions",
    header: "",
    role: "actions",
    align: "right",
    width: "w-[200px]",
    cell: (r) => (
      <span className="inline-flex items-start gap-2">
        <Link href={`/admin/riders/incentives?edit=${r.id}`} className="c-btn-quiet press">
          Edit
        </Link>
        <RuleToggle id={r.id} active={r.active} />
      </span>
    ),
  },
];

/** The rules page, from rules already read (so a fixture can render it). */
export function RulesView({
  rules,
  sp,
  today,
  migrationMissing = false,
  failed = false,
}: Readonly<{ rules: Rule[]; sp: RulesSearch; today: string; migrationMissing?: boolean; failed?: boolean }>) {
  const editing = sp.edit ? (rules.find((r) => r.id === sp.edit) ?? null) : null;
  const creating = sp.new === "1" && !migrationMissing;
  const showEditor = Boolean(editing) || creating;
  const active = rules.filter((r) => r.active).length;

  return (
    <>
      <PageHeader
        back={{ href: "/admin/riders", label: "Riders" }}
        title="Incentive rules"
        description="Bonuses for hitting a delivery target in a day or a week. Riders see the active ones in their app."
        actions={
          migrationMissing ? undefined : (
            <Link href="/admin/riders/incentives?new=1" className="c-btn c-btn-dark press">
              New rule
            </Link>
          )
        }
      />

      {migrationMissing ? (
        <PreviewNotice>{MIGRATION_MISSING}. Rules can be created here once it is.</PreviewNotice>
      ) : null}
      {failed ? (
        <PreviewNotice>
          <strong>The rules could not be read.</strong> Reload in a moment; the problem has been logged.
        </PreviewNotice>
      ) : null}
      {sp.edit && !editing && !migrationMissing && !failed ? (
        <PreviewNotice>That rule no longer exists.</PreviewNotice>
      ) : null}

      <div className={showEditor ? "grid items-start gap-4 @6xl:grid-cols-[minmax(0,1fr)_380px]" : undefined}>
        <DataTable
          caption="Incentive rules"
          columns={columns}
          rows={rules}
          rowKey={(r) => r.id}
          minWidth={680}
          footer={
            <TableFooter
              page={1}
              totalPages={1}
              hrefFor={() => "/admin/riders/incentives"}
              summary={`${rules.length} ${rules.length === 1 ? "rule" : "rules"}, ${active} active`}
            />
          }
          empty={
            migrationMissing || failed ? null : (
              <div className="rounded-[var(--c-r)] border border-dashed border-line px-4 py-10 text-center">
                <Trophy className="mx-auto size-6 text-muted" aria-hidden="true" />
                <p className="mt-2 text-sm font-semibold">No incentive rules yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
                  Create one, for example &ldquo;10 deliveries in a day pays ₹150&rdquo;.
                </p>
              </div>
            )
          }
        />
        {showEditor ? <RuleForm key={editing?.id ?? "new"} rule={editing ?? undefined} today={today} /> : null}
      </div>

      {rules.length > 0 ? (
        <p className="text-xs text-muted">
          To retire a rule, switch it off. Rules are never deleted: a rule that has paid a rider stays on record.
        </p>
      ) : null}
    </>
  );
}
