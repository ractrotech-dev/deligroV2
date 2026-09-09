import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { ConsoleOnly } from "@/components/admin/console-only";
import { Toolbar } from "@/components/admin/console";
import { ObsNav } from "./obs-nav";
import { classifySearch } from "@/lib/obs/read";

/**
 * Observability shell: the role gate, the console gate, the section tabs, and
 * the search box.
 *
 * ## The console gate
 *
 * Every screen under here is a dense table, a stack trace or a request
 * waterfall — a phone can show none of them usefully. `admin-nav.ts` marks the
 * section `reach: "console"`, but that only keeps it out of the phone's menu;
 * the route stayed open, so a bookmark, a deep link out of an alert, or the
 * back button dropped a ten-tab console with 560px-wide tables into a 370px
 * column. `ConsoleOnly variant="page"` replaces the whole section with a line
 * saying where it went, which is the same treatment the vendor wizard and the
 * settlement builder already get.
 *
 * **This is presentation, not authorization.** It changes nothing about who may
 * read this data: `requireRole("admin")` below, the same check in every action
 * in `actions.ts`, and a third in the data layer where RLS is actually
 * bypassed, are what keep it safe. A phone with an admin session is still an
 * admin — it is just being told to open this at a desk.
 *
 * ## The gate
 *
 * `requireRole("admin")` again, even though `/admin/layout.tsx` already ran it.
 * That is not redundancy for its own sake — it is the project's own rule that a
 * layout guard protects a page and not the data beneath it, and this section
 * reaches for `createAdminClient()` on nearly every screen. The data layer
 * (`lib/obs/read.ts`, `lib/obs/metrics.ts`) checks the role a third time, at the
 * point where RLS is actually bypassed. Three checks, each at a boundary
 * something could be added below.
 *
 * `manager` does not reach here. Deligro has no admin sub-roles — `profiles.role`
 * is a five-value enum for the whole platform — so the read-only and
 * support-scoped tiers the brief describes have nothing to hang on, and
 * inventing a permission dimension for one feature is a security change of its
 * own. Recorded as decision Q1 in docs/OBSERVABILITY_PLAN.md §12.
 *
 * ## The search box
 *
 * One field, no mode selector. During an incident whatever is in the clipboard
 * came off the last screen — an issue id, a trace id, an order uuid — and asking
 * an operator to first classify it is a step that exists only because the
 * software could not be bothered to look at it. `classifySearch` dispatches on
 * shape; anything unrecognised falls through to a message search over the logs.
 */
export default async function ObservabilityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole("admin");

  async function search(formData: FormData) {
    "use server";
    // A Server Action is a public HTTP endpoint (AGENTS.md rule 3), so it
    // re-checks the role rather than trusting that the page it is rendered on
    // was gated. This one only routes — it reads nothing — but the rule has no
    // exemption for "internal" helpers, and one day it will read something.
    await requireRole("admin");

    const raw = String(formData.get("q") ?? "").trim();
    if (!raw) redirect("/admin/observability");

    const { kind, value } = classifySearch(raw);
    const base = "/admin/observability";
    switch (kind) {
      case "issue":
        redirect(`${base}/issues/${value}`);
      case "incident":
        redirect(`${base}/incidents/${value}`);
      case "trace":
        redirect(`${base}/traces/${value}`);
      case "request":
        redirect(`${base}/logs?requestId=${encodeURIComponent(value)}&range=7d`);
      case "order":
        redirect(`${base}/logs?orderId=${encodeURIComponent(value)}&range=7d`);
      default:
        redirect(`${base}/logs?q=${encodeURIComponent(value)}&range=24h`);
    }
  }

  return (
    <ConsoleOnly
      variant="page"
      tool="The observability console"
      why="Issues, traces and logs are wide tables and stack traces that a phone cannot show usefully. Orders, refunds and the vendor list all work here."
    >
      <div className="flex flex-col gap-[var(--c-gap)]">
        {/* Sticky, like every other console toolbar: during an incident this
            search box is reached for from the bottom of a thousand-line log,
            and scrolling back to the top to paste a trace id is a tax paid at
            exactly the worst moment. */}
        <Toolbar>
          <ObsNav />
          <form
            action={search}
            className="flex min-w-[220px] flex-1 items-center gap-2"
          >
            <input
              type="search"
              name="q"
              placeholder="Issue, trace, request or order id…"
              aria-label="Search observability"
              className="text-data h-8 min-w-0 flex-1 rounded-[var(--c-r)] border border-line bg-surface px-2.5 text-[12px] text-ink outline-none placeholder:text-muted focus:border-[var(--c-border-hover)]"
            />
            <button
              type="submit"
              className="c-btn c-btn-dark press h-8 shrink-0"
            >
              Find
            </button>
          </form>
        </Toolbar>
        {children}
      </div>
    </ConsoleOnly>
  );
}
