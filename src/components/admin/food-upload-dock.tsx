"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CopyCheck,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { summarise, useFoodUpload } from "@/stores/food-upload-store";

/**
 * The window onto the background photo upload.
 *
 * Mounted once by `AdminShell`, so a folder started on the food photos page
 * keeps uploading while the operator works somewhere else in the console — the
 * queue itself lives in a module-level store, not in this component. Renders
 * nothing at all when there is no batch, which is nearly always.
 *
 * The one thing it must not do is let a batch disappear silently: leaving the
 * page kills the queue (a `File` handle cannot outlive the document), so it
 * puts up a beforeunload guard while anything is still in flight.
 */
export function FoodUploadDock({
  className,
  // The dock renders outside the shell div, so it carries `console-theme`
  // itself — and therefore has to be told which variant of it to be.
  "data-console": dataConsole,
}: {
  className?: string;
  "data-console"?: string;
}) {
  const router = useRouter();
  const items = useFoodUpload((s) => s.items);
  const paused = useFoodUpload((s) => s.paused);
  const collapsed = useFoodUpload((s) => s.collapsed);
  const finishedAt = useFoodUpload((s) => s.finishedAt);
  const setCollapsed = useFoodUpload((s) => s.setCollapsed);
  const pause = useFoodUpload((s) => s.pause);
  const resume = useFoodUpload((s) => s.resume);
  const cancelRemaining = useFoodUpload((s) => s.cancelRemaining);
  const retryFailed = useFoodUpload((s) => s.retryFailed);
  const dismiss = useFoodUpload((s) => s.dismiss);

  const stats = summarise(items);

  // The library grid is server-rendered; pull the new photos in once the batch
  // drains rather than re-rendering the route after every single file.
  useEffect(() => {
    if (finishedAt > 0) router.refresh();
  }, [finishedAt, router]);

  useEffect(() => {
    if (!stats.running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [stats.running]);

  if (items.length === 0) return null;

  const pct = stats.total ? Math.round((stats.settled / stats.total) * 100) : 0;
  const problems = items.filter(
    (i) => i.status === "failed" || i.status === "duplicate" || i.status === "cancelled"
  );

  return (
    <div
      data-console={dataConsole}
      className={cn(
        "fixed bottom-[88px] left-3 right-3 z-50 sm:bottom-4 sm:left-auto sm:right-4 sm:w-[368px]",
        className
      )}
      role="status"
      aria-live="polite"
    >
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
        <div className="flex items-center gap-2 px-3.5 py-3">
          {stats.running && !paused ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
          ) : stats.failed > 0 ? (
            <AlertTriangle className="size-4 shrink-0 text-deal" />
          ) : (
            <Check className="size-4 shrink-0 text-green" />
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-ink">
              {stats.running
                ? paused
                  ? `Paused — ${stats.settled} of ${stats.total} done`
                  : `Uploading ${Math.min(stats.settled + 1, stats.total)} of ${stats.total}`
                : `${stats.done} photo${stats.done === 1 ? "" : "s"} added`}
            </p>
            <p className="truncate text-[11px] text-muted">
              {summaryLine(stats)}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Show details" : "Hide details"}
            className="press grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
          >
            {collapsed ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>
          {!stats.running ? (
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss"
              className="press grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>

        <div className="h-1 bg-surface-2">
          <div
            className={cn(
              "h-full transition-[width] duration-300",
              stats.failed > 0 && !stats.running ? "bg-deal" : "bg-accent"
            )}
            style={{ width: `${pct}%` }}
          />
        </div>

        {!collapsed ? (
          <div className="space-y-2.5 px-3.5 py-3">
            {problems.length > 0 ? (
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {problems.slice(0, 40).map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start gap-1.5 text-[11.5px] leading-snug"
                  >
                    {item.status === "duplicate" ? (
                      <CopyCheck className="mt-0.5 size-3 shrink-0 text-muted" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-deal" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-ink">{item.title}</span>
                      <span className="text-muted">
                        {" — "}
                        {item.status === "duplicate"
                          ? "already in the library"
                          : item.status === "cancelled"
                            ? "cancelled"
                            : (item.error ?? "failed")}
                      </span>
                    </span>
                  </li>
                ))}
                {problems.length > 40 ? (
                  <li className="text-[11.5px] text-muted">
                    …and {problems.length - 40} more.
                  </li>
                ) : null}
              </ul>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              {stats.running ? (
                <>
                  <DockButton onClick={paused ? resume : pause}>
                    {paused ? (
                      <>
                        <Play className="size-3.5" /> Resume
                      </>
                    ) : (
                      <>
                        <Pause className="size-3.5" /> Pause
                      </>
                    )}
                  </DockButton>
                  <DockButton onClick={cancelRemaining}>
                    <X className="size-3.5" /> Stop
                  </DockButton>
                </>
              ) : null}

              {!stats.running && stats.failed + stats.cancelled > 0 ? (
                <DockButton onClick={retryFailed}>
                  <RotateCcw className="size-3.5" /> Try {stats.failed + stats.cancelled}{" "}
                  again
                </DockButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DockButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[12px] font-semibold text-ink hover:bg-line/60"
    >
      {children}
    </button>
  );
}

function summaryLine(stats: ReturnType<typeof summarise>): string {
  const parts: string[] = [];
  if (stats.running) parts.push(`${stats.done} added`);
  if (stats.duplicate > 0) parts.push(`${stats.duplicate} already there`);
  if (stats.failed > 0) parts.push(`${stats.failed} failed`);
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled`);
  if (parts.length === 0) {
    return stats.running
      ? "Keep this tab open — you can carry on working."
      : "All done.";
  }
  return parts.join(" · ");
}
