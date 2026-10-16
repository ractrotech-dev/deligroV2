import { cn } from "@/lib/utils/cn";

/** Toned icon badges, shared with the rest of the app's coloured icons. */
const TONES = {
  muted: "bg-surface-2 text-muted",
  accent: "bg-accent/12 text-accent",
  green: "bg-green/12 text-green",
  blue: "bg-blue/12 text-blue",
  deal: "bg-deal/12 text-deal",
  violet: "bg-violet-500/15 text-violet-500",
} as const;

/**
 * P3 — Design the empty state first. Every empty state is an invitation,
 * never a shrug.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  tone = "muted",
}: Readonly<{
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  tone?: keyof typeof TONES;
}>) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-8 py-14 text-center",
        className
      )}
    >
      {icon ? (
        <div
          className={cn(
            "mb-4 grid size-16 place-items-center rounded-2xl",
            TONES[tone]
          )}
        >
          {icon}
        </div>
      ) : null}
      <h3 className="text-heading">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-[16rem] text-body text-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
