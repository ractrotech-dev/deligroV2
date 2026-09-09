<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Deligro project rules

## Before shipping

Two checklists are the standing gates. Work through the relevant one rather than
re-deriving what matters each time:

- [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md) — run before every release,
  and **always** when a change touches an RLS policy, a `grant`, an auth path,
  an upload, or adds a column to a table that anon/authenticated can read.
- [`docs/DEPLOYMENT_AUDIT.md`](docs/DEPLOYMENT_AUDIT.md) — run before every
  promotion to production.

Both have a log table at the bottom. Fill it in; the history is the point.

## Security rules that are easy to get wrong here

1. **RLS filters rows, not columns.** Adding a column to a publicly-readable
   table is a security change. `restaurants` grants SELECT on an explicit
   column list (migration 0022) — a new column is invisible until granted on
   purpose. If a field doesn't appear in the app, that is the guard working.
2. **Never fail open.** A missing env var, an unreachable service or a failed
   config check must reduce access, never widen it. `requireRole()` returning a
   synthetic admin when Supabase keys are absent was a real bug (H-1).
3. **Server Actions are public HTTP endpoints.** Every exported `"use server"`
   function starts with a role check. No exceptions for "internal" helpers.
4. **Credentials are never stored in reproducible form.** Show once, then drop.
   The single, documented exception is `vendor_login_credentials` (migration
   0039): vendors are onboarded by hand and the admin desk has to read their
   login back to them. It is defensible only because of its containment — own
   table, RLS on with no policies, all privileges revoked from
   `anon`/`authenticated`, `service_role` only, reached through the
   `server-only` `vendor-credentials.ts` behind `requireRole("admin")`. Do not
   extend the exception, and do not put a plaintext credential on a table that
   anon or authenticated can read — that was audit finding C-2.
5. **`createAdminClient()` bypasses RLS.** Every call needs an authorization
   check above it in the same path.
6. **Rate-limit every write endpoint.** `user.id` when authenticated,
   `clientIp(request)` when not.

## Resolving conflicting or duplicated code

When two implementations of the same thing exist — a merge conflict, a leftover
from a refactor, two data-access paths for one concept — do not default to
"newest wins" or "keep both". Judge them, and keep the one that is better
**for this project**, in this order:

1. **Correctness and security.** The version that enforces authorization at the
   database, validates server-side, and fails closed wins outright. This
   outranks everything below it.
2. **Integration.** The version already wired into the rest of the app — the one
   whose types, RLS policies, callers and tests line up — beats the more elegant
   orphan. A better function nobody calls is worse than an adequate one the app
   depends on.
3. **Completeness.** The version that handles the real cases (guest vs user vs
   operator, missing migration, offline SMS provider) beats the happy path.
4. **Clarity.** Only when the above tie.

Then **delete the loser**. Dead alternates are how a codebase acquires two
sources of truth, and the next person cannot tell which one is live. If both
versions have something worth keeping, merge deliberately into one and say so in
the commit message — do not leave the other in place "just in case".

If the better-integrated version is the less secure one, fix its security rather
than swapping in the orphan. Keep the wiring, raise the floor.

## Web and app are two shells, not two stylesheets

Admin, vendor and manager each run **two top-level shells**: the ops console
(sidebar or header + fluid column) and the phone frame (`.device` > `.app-shell`,
402px, bezel and all). They are separate branches of the element tree, not one
layout with breakpoints, and they share everything below the chrome — data
access, business logic, roles, and the `admin-ui` / `console-ui` / `DataTable`
primitives.

1. **The shell is resolved on the server.** `resolveShellMode(portal)`
   (`lib/shell-mode.server.ts`) reads a cookie, falls back to a phone-shaped
   user agent, then to `"web"`. The layout passes the answer to the shell as
   `initialMode`, and `ShellModeProvider` carries it down. Do not add a
   client-only shell decision: that was the bug — SSR had no answer, resolved to
   `"app"`, and every console page server-rendered inside a 402px iPhone mock
   that swapped to the console after hydration.
2. **Never put phone chrome in the console branch.** No `.device`, `.app-shell`,
   `.app-scroll`, `StatusBar`, tab bar, phone header, `max-w-md`, or 80px bottom
   padding below the `effective === "web"` return. `scripts/qa/platform-separation.ts`
   asserts this structurally; run `npm run test:platform` after touching a shell.
3. **The console has its own palette, and it is not `data-theme`.**
   `.console-theme` is dark-first and reads `data-console`, resolved from a
   cookie in the portal layout (`lib/console-theme.server.ts`) exactly as the
   shell mode is. `data-theme` belongs to the customer PWA: it is global, lives
   in localStorage, and defaults to light. Do not wire the console to it — that
   is how an operations preference re-skins a storefront.

   Two consequences. Anything that carries `console-theme` outside the shell
   div (the nav drawer, the upload dock) must be handed `data-console` as well,
   or it renders dark inside a light console. And **never use a raw Tailwind
   palette colour or a `dark:` variant in the console**: no `dark` custom
   variant is configured, so `dark:` falls back to `prefers-color-scheme` — the
   OS setting, which is unrelated to both themes. `text-blue-800
   dark:text-blue-300` on a dark console reads at about 2:1. Use the tokens;
   `@theme inline` exists so they follow the palette for free.

4. **Size against the container, not the window.** Both shells wrap content in
   `@container`, so a page uses `@3xl:` / `@5xl:`, never `md:` / `lg:`. A
   viewport breakpoint reports "wide" for a 390px phone frame previewed on a
   1920px screen, which is precisely backwards. Viewport breakpoints are for
   chrome that really is viewport-scale (the sidebar's `lg:hidden`).
5. **Desktop is not mobile stretched.** A console screen uses the width it is
   given: multi-column rows for panels that are read together, real tables via
   `DataTable`, and `.admin-measure` for forms and prose so a text field is not
   1500px wide.

## The console design system lives in `components/admin/console`

One kit, both portals. `PageHeader`, `Toolbar`, `Tabs`, `Section`,
`SectionRow`/`SectionCol`, `Panel`, `ChartPanel`, `MetricRow`, `Figure`,
`StatusDot`/`StatusText`/`StatusBadge`, `AttentionList`, `Timeline`,
`FinancialBreakdown`, `FactList`, `Empty`, `ShareBar`. Tables are
`components/admin/data-table`; charts are `components/admin/charts`.

Three rules it exists to enforce:

1. **Group with a hairline, not a box.** `Section` is the default and draws no
   border, no fill and no radius. `Panel` is for content that genuinely needs
   an edge — a chart with its own coordinate space, a form. A screen with eight
   ideas on it should not draw eight boxes.
2. **Colour states meaning, on the smallest mark that carries it.** A status in
   a table column is `StatusText` (a dot and a word), never a tinted capsule: a
   column of forty capsules is a wall, and a wall is not a signal.
   `StatusBadge` is for one page-level state. Green success, red critical,
   amber pending, blue informational, neutral for merely normal.
3. **A filtered list that came back empty gets `Empty`** — one dashed line
   where the rows would have been. `EmptyState` (the centred one) is for a
   screen that is empty in its entirety.

`AdminHero`, `Panel`/`ChartCard` in `admin-ui`, `KpiStrip`/`StatTile` in
`console-ui`, and `VendorHero`/`VendorMetricCard` in `vendor-ui` are **adapters
over this kit, not second implementations** — each maps old prop names onto the
one component and is marked deprecated. Prefer the kit in new code; converting
a screen means swapping the import, not choosing between two behaviours.

## `reach: "console"` is a route contract

`admin-nav.ts` marks a nav entry `reach: "console"` when the screen behind it
cannot work on a handset. That is **not** "hide it from the menu". It means:

- the entry is dropped from `ADMIN_PHONE_MENU` (derived, so this cannot be
  forgotten), **and**
- the route itself renders `<ConsoleOnly variant="page">`, so a bookmark, a deep
  link out of an alert, or the back button gets the notice rather than a broken
  screen.

Both halves, or neither. Observability had only the first for a release, and a
phone reaching the URL got a ten-tab console with 560px tables inside a 370px
column. `npm run test:platform` fails if a console-reach entry has no gate.

## Platform is presentation; roles are the security boundary

**Never use the shell mode, `navigator.userAgent`, or a viewport query as
authorization.** `ConsoleOnly` hides a control; it does not stop anyone calling
what the control called. What stops them is what has always stopped them:
`requireRole()` at the top of every exported `"use server"` function and every
API route (rule 3), above every `createAdminClient()` (rule 5), with RLS
underneath.

So a phone holding an admin session is still an admin. It is being told to open
this at a desk, not being denied.

Do not invent a per-platform permission model. `profiles.role` is a five-value
platform enum; a capability dimension crossed with a device class is a security
change of its own, and none of the screens gated so far needed one.

## New admin features declare a platform

Say which shells a feature is for, in the page's doc comment, and build to it:

- **BOTH** — the default. One page, container queries, `DataTable` where there
  is a table. Most screens.
- **WEB** — `reach: "console"` on the nav entry *and* `<ConsoleOnly
  variant="page">` on the route. For screens a handset genuinely cannot show:
  the vendor onboarding wizard, the settlement builder, observability.
- **WEB control on a BOTH page** — an inline `<ConsoleOnly>` around the control,
  with a `why` that says what still works. Exports, chart panels, bulk editors.
  Prefer this to gating a whole screen: read-only value is worth keeping on a
  phone even when the editing is not.

Write the `tool` and `why` strings as sentences an operator would say. The
notice is the only thing they get, so "Exporting a report" plus what still works
is the whole feature from their side.
## Reports and audits go in the project as standalone HTML

When Claude produces a report-shaped deliverable for this project — a financial
audit, a business-model document, a security/performance audit, or similar —
write it as a standalone `.html` file committed to the repo, not only as a
Claude Artifact or a scratch/temp file. This repo already does this
(`audit-report.html`, `audit-report-2.html`); follow that pattern: a
self-contained file at the repo root, named for its content
(`financial-audit-report.html`, `financial-constitution.html`, etc.), openable
directly in a browser with no build step. Markdown reports (`AUDIT_REPORT*.md`,
`docs/*_AUDIT.md`) remain fine for engineering-facing findings meant to be read
in an editor or diffed; use HTML when the deliverable is meant to be read as a
finished document (tables, sections, a founder/stakeholder audience).

## Documentation must match behaviour

`SECURITY.md`, migration comments and doc comments are load-bearing — the audit
found admin MFA documented as enforced in three places while
`MFA_REQUIRED_ROLES` was an empty array. When you change a control, update what
claims it exists. A stale security doc is worse than none, because it stops the
next reviewer from looking.
