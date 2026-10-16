"use client";

/**
 * An inline <script> for before-paint work (e.g. the theme bootstrap) that runs
 * on hard loads yet doesn't trip React's dev warning "Scripts inside React
 * components are never executed when rendering on the client."
 *
 * It renders `type="text/javascript"` on the server — so the browser runs it
 * synchronously while parsing the HTML, before the first paint — and
 * `type="text/plain"` on the client, where it's inert. `suppressHydrationWarning`
 * absorbs the resulting type mismatch. This is the pattern from Next.js's
 * "Preventing Flash Before Hydration" guide.
 *
 * `"use client"` is load-bearing, not decoration. The `typeof window` branch has
 * to be evaluated *in the browser* to ever pick `text/plain`. Rendered from a
 * Server Component (this was called straight from the root layout), it is
 * resolved once on the server, the RSC payload carries `text/javascript`, and
 * React warns about the script tag anyway when it replays that payload during
 * hydration — the exact warning this component exists to prevent.
 */
export function InlineScript({ html }: Readonly<{ html: string }>) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
