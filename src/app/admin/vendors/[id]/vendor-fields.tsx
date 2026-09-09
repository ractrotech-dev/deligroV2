import { Fact, FactList, Section } from "@/components/admin/console";

export function fmtDate(iso: string | null): string {
  return iso
    ? new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(new Date(iso))
    : "—";
}

export function fmtTime(t: string | null): string {
  return t ? t.slice(0, 5) : "—";
}

export function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

/**
 * A labelled group of facts about a shop.
 *
 * A `Section` and a `FactList`, not a bordered card: eight of these tile the
 * Business and Payment tabs, and eight boxes to carry eight short label/value
 * lists is exactly the shape the redesign set out to remove. The heading and
 * the hairline above it do the grouping, and the facts underneath get the full
 * column width instead of a padded inset.
 */
export function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Section title={title}>
      <FactList>{children}</FactList>
    </Section>
  );
}

/**
 * One fact. An empty value is an em-dash rather than a blank, so a missing
 * field reads as "nothing recorded" instead of as a rendering fault.
 */
export function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <Fact label={label}>
      {value || <span className="text-[color:var(--c-faint)]">—</span>}
    </Fact>
  );
}
