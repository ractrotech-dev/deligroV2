/**
 * What anyone gets instead of the admin panel on a small screen. It says the one
 * thing there is to say, large enough to read at arm's length.
 *
 * Two places show it, and they differ by one line:
 *   - `/desktop-only`, where the proxy sends a phone. No extra line.
 *   - `DesktopOnlyGate`, for a window too narrow to fit the panel. That reader may
 *     be on a computer, with the window small or the browser zoomed in, so they
 *     are told the fix.
 */
export function DesktopOnlyNotice({
  windowHint = false,
}: Readonly<{ windowHint?: boolean }>) {
  return (
    <main className="flex min-h-[100dvh] flex-col justify-center bg-[#0d0f12] px-7 py-10 text-white">
      <h1 className="text-[clamp(44px,14vw,88px)] font-extrabold leading-[1.02] tracking-[-0.035em]">
        Not made for mobile
      </h1>
      <p className="mt-5 text-[clamp(22px,6.5vw,36px)] font-semibold leading-tight text-white/70">
        Log in on a desktop
      </p>
      {windowHint ? (
        <p className="mt-8 text-[15px] leading-snug text-white/50">
          Already on a computer? Make this window wider.
        </p>
      ) : null}
    </main>
  );
}

/**
 * Covers the admin panel when the window is too narrow for it. Pure CSS
 * (`.admin-desktop-gate` in globals.css), so nothing flashes before it appears and
 * printing a statement is unaffected. Render it first, beside the content it covers:
 * the stylesheet hides what follows it, which keeps the keyboard out of that too.
 */
export function DesktopOnlyGate() {
  return (
    <div className="admin-desktop-gate">
      <DesktopOnlyNotice windowHint />
    </div>
  );
}
