"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, ReceiptText, RotateCcw, Search, Store, X } from "lucide-react";
import { activeNavItem } from "@/components/admin/admin-nav";
import { ConsoleThemeToggle } from "@/components/admin/console/chrome";
import {
  ShellModeToggle,
  type ShellMode,
} from "@/components/shared/desktop-shell-switcher";
import type { AdminNavCounts } from "@/lib/data-access/admin-stats";
import type { ConsoleHealth } from "@/lib/console-health";
import { cn } from "@/lib/utils/cn";

/** Where the search box can send you — each is a page that really filters on `q`. */
const SCOPES = [
  { id: "vendors", label: "Vendors", href: "/admin/vendors" },
  { id: "orders", label: "Orders", href: "/admin/orders" },
  { id: "customers", label: "Customers", href: "/admin/customers" },
] as const;

type ScopeId = (typeof SCOPES)[number]["id"];

/**
 * The console's top bar: where you are, a search that goes somewhere real, the
 * queues that need a human, and the two switches that change how the console
 * itself looks.
 *
 * ## What is deliberately not here
 *
 * A primary action. This bar used to carry a hard-coded "New campaign" button,
 * which meant all forty-five admin screens offered the same irrelevant action
 * in the most prominent slot on the page — and the one screen where it *was*
 * the primary action already had its own. A page's primary action belongs to
 * that page's header, which is why `PageHeader` has an `actions` slot.
 *
 * ## What is here, and why each earns it
 *
 * - The section label, on narrow widths where the rail is a drawer and nothing
 *   else says what you are looking at.
 * - Search, scoped to a page that really filters on `q`. The `⌘K` hint is a
 *   promise, so it is bound here — this bar is mounted on every console screen
 *   and unmounted in phone mode, which is exactly the shortcut's scope.
 * - The health chip, so a misconfigured deployment is visible from any screen
 *   rather than only from the foot of the rail.
 * - The three queue counts, each a live figure linking to the screen that
 *   clears it. A badge with no queue behind it renders as a plain icon rather
 *   than as a zero.
 *
 * The bar is quiet on purpose: hairline bottom border, no fill of its own
 * beyond a blurred page tint, nothing bold. It should never be the first thing
 * read on a screen whose job is the data underneath it.
 */
export function AdminTopBar({
  counts,
  health,
  onMenu,
  shellMode,
  onShellModeChange,
  shellHydrated,
}: {
  counts: AdminNavCounts;
  health: ConsoleHealth;
  onMenu: () => void;
  /** Current layout, so the toggle can live in the header rather than float. */
  shellMode: ShellMode;
  onShellModeChange: (mode: ShellMode) => void;
  /** False until the stored preference has loaded; the toggle stays inert. */
  shellHydrated: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [scope, setScope] = useState<ScopeId>("vendors");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const active = activeNavItem(pathname);
  const target = SCOPES.find((s) => s.id === scope) ?? SCOPES[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `${target.href}?q=${encodeURIComponent(q)}` : target.href);
  };

  return (
    <header className="admin-top-bar sticky top-0 z-30 border-b border-line bg-[color:var(--bg)]/90 backdrop-blur-lg">
      {/* The height here is what `--c-top-h` on the shell is set to. A sticky
          toolbar on a page below offsets by that, so the two must agree. */}
      <div className="flex h-[52px] items-center gap-3 px-4 lg:px-6">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open navigation"
          className="press grid size-8 shrink-0 place-items-center rounded-[var(--c-r)] border border-line bg-surface text-muted lg:hidden"
        >
          <Menu className="size-4" />
        </button>

        <p className="shrink-0 text-[14px] font-bold tracking-[-0.01em] lg:hidden">
          {active?.label ?? "Admin"}
        </p>

        <form
          onSubmit={submit}
          className="ml-auto hidden min-w-0 shrink items-center sm:flex lg:ml-0 lg:basis-[360px]"
          role="search"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--c-r)] border border-line bg-surface px-2.5 py-[6px] focus-within:border-[var(--c-border-hover)]">
            <Search className="size-3.5 shrink-0 text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${target.label.toLowerCase()}…`}
              aria-label={`Search ${target.label.toLowerCase()}`}
              aria-keyshortcuts="Meta+K Control+K"
              className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="press grid size-4 shrink-0 place-items-center rounded-full bg-surface-2 text-muted"
              >
                <X className="size-2.5" />
              </button>
            ) : (
              <kbd className="text-data hidden shrink-0 rounded border border-line px-1 py-px text-[10px] text-muted md:block">
                ⌘K
              </kbd>
            )}
            {/* The scope is part of the query, not a filter applied after it —
                the three lists live on different pages. */}
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as ScopeId)}
              aria-label="Search in"
              className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-muted outline-none"
            >
              {SCOPES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </form>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <HealthChip health={health} liveOrders={counts.liveOrders} />

          <QuickAction
            href="/admin/orders"
            label="Live orders"
            count={counts.liveOrders}
            tone="blue"
            icon={<ReceiptText className="size-4" strokeWidth={1.8} />}
          />
          <QuickAction
            href="/admin/vendors"
            label="Pending approvals"
            count={counts.pendingApprovals}
            tone="accent"
            icon={<Store className="size-4" strokeWidth={1.8} />}
          />
          <QuickAction
            href="/admin/refunds"
            label="Refunds waiting"
            count={counts.pendingRefunds}
            tone="deal"
            icon={<RotateCcw className="size-4" strokeWidth={1.8} />}
          />

          <span
            aria-hidden
            className="mx-1 hidden h-5 w-px bg-line min-[480px]:block"
          />

          <ConsoleThemeToggle />

          {/* The layout switch, in the header rather than floating over the
              page. It belongs with the other controls that change what you are
              looking at, and a fixed pill in the bottom-right corner sat on top
              of table footers and action docks on every screen. */}
          <ShellModeToggle
            mode={shellMode}
            onChange={onShellModeChange}
            hydrated={shellHydrated}
          />
        </div>
      </div>
    </header>
  );
}

/**
 * Deployment state in one chip: how much is in flight, or what is not
 * configured.
 *
 * Configuration trouble wins over the live count. A console missing its
 * database keys is a fact about every screen, and burying it at the foot of a
 * rail the operator may have collapsed is how it goes unnoticed for a week.
 */
function HealthChip({
  health,
  liveOrders,
}: {
  health: ConsoleHealth;
  liveOrders: number;
}) {
  if (!health.ok) {
    const bad = health.rows.filter((r) => !r.ok).length;
    return (
      <Link
        href="/admin/settings"
        className="press hidden items-center gap-1.5 rounded-[var(--c-r)] bg-[var(--c-tint-amber)] px-2.5 py-1.5 text-[11.5px] font-semibold text-[color:var(--c-ink-amber)] xl:inline-flex"
      >
        <span className="c-status-dot" />
        {bad} to set up
      </Link>
    );
  }

  if (liveOrders <= 0) return null;

  return (
    <Link
      href="/admin/orders"
      className="press hidden items-center gap-1.5 rounded-[var(--c-r)] border border-line bg-surface px-2.5 py-1.5 text-[11.5px] font-medium text-ink transition-colors hover:border-[var(--c-border-hover)] xl:inline-flex"
    >
      <span className="c-dot bg-green" />
      {liveOrders} order{liveOrders === 1 ? "" : "s"} in flight
    </Link>
  );
}

const TONES = {
  blue: "bg-[var(--c-tint-blue)] text-blue",
  accent: "bg-accent-soft text-accent-ink",
  deal: "bg-deal-soft text-deal",
} as const;

function QuickAction({
  href,
  label,
  count,
  tone,
  icon,
}: {
  href: string;
  label: string;
  count: number;
  tone: keyof typeof TONES;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={count > 0 ? `${label}: ${count}` : label}
      title={count > 0 ? `${label}: ${count}` : label}
      className={cn(
        "press relative grid size-8 place-items-center rounded-[var(--c-r)] transition-colors",
        count > 0
          ? TONES[tone]
          : "text-muted hover:bg-[var(--c-hover)] hover:text-ink"
      )}
    >
      {icon}
      {count > 0 ? (
        <span className="text-data absolute -right-1 -top-1 min-w-[16px] rounded-full bg-ink px-1 text-center text-[9.5px] font-bold leading-4 text-[color:var(--surface)]">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
