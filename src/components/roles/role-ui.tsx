import { cn } from "@/lib/utils/cn";

type StatTone = "accent" | "green" | "muted";

export function StatCard({
  label,
  value,
  delta,
  tone = "muted",
  deltaTone,
  compact = false,
}: Readonly<{
  label: string;
  value: string;
  delta?: string;
  tone?: StatTone;
  deltaTone?: StatTone;
  compact?: boolean;
}>) {
  const toneClass =
    tone === "green"
      ? "text-green"
      : tone === "accent"
        ? "text-accent"
        : "text-muted";
  const deltaClass =
    deltaTone === "green"
      ? "text-green"
      : deltaTone === "accent"
        ? "text-accent"
        : toneClass;
  return (
    <div className={cn("card", compact ? "p-3" : "p-4")}>
      <p className={cn(compact ? "text-[11px]" : "text-label")}>{label}</p>
      <p
        className={cn(
          "text-data font-semibold text-ink",
          compact ? "mt-1 text-xl" : "mt-2 text-2xl"
        )}
      >
        {value}
      </p>
      {delta ? (
        <p className={cn("mt-1 text-xs font-semibold", deltaClass)}>{delta}</p>
      ) : null}
    </div>
  );
}

export function SectionTitle({
  children,
  right,
}: Readonly<{
  children: React.ReactNode;
  right?: React.ReactNode;
}>) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-label">{children}</h2>
      {right}
    </div>
  );
}

export function Pill({
  tone = "muted",
  children,
}: Readonly<{
  tone?: "accent" | "green" | "muted";
  children: React.ReactNode;
}>) {
  return <span className={cn("pill", `pill-${tone}`)}>{children}</span>;
}
