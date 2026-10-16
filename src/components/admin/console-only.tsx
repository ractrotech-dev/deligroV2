"use client";

import { useState } from "react";
import { Check, Monitor, Send } from "lucide-react";
import { EmptyState } from "@/components/admin/admin-ui";
import { Button } from "@/components/ui/button";
import { useAdminShellMode } from "@/hooks/use-admin-shell-mode";
import { useIsDesktop } from "@/hooks/use-is-desktop";

/**
 * Tools that only work at console width, and an honest note where they aren't.
 *
 * The admin runs in two shells: the console, and a ~370px phone column that a
 * real handset is forced into (resolved server-side — see
 * `lib/shell-mode.server.ts`). A handful of screens are built for the console
 * and cannot be made to work in that column — a 960px vendor table, an
 * eight-step onboarding wizard, the platform fee form, the whole observability
 * section. Rather than ship them broken or delete them silently, they are
 * replaced on the phone with a line saying where they went. Nobody should hunt
 * for a feature they know exists.
 *
 * THIS IS PRESENTATION, NOT AUTHORIZATION. Hiding a tool here changes nothing
 * about who may call it: every exported `"use server"` function starts with its
 * own role check (AGENTS.md rule 3), and that is the only thing keeping it safe.
 * Do not read a hidden button as a control.
 *
 * Paired with `reach: "console"` in `admin-nav.ts` it becomes the route contract
 * described in AGENTS.md: the nav drops the entry *and* the route renders
 * `variant="page"`, so a bookmark or a deep link gets this notice rather than a
 * screen the phone cannot draw. One without the other is the bug that shipped.
 *
 * Note on what the gate actually stops: a *server* child passed as `children`
 * still renders on the server — the parent creates the element eagerly, so the
 * query behind it runs either way. What this stops is the *client mount*, which
 * is the part that costs a phone something: `AutoRefresh` polling, Recharts,
 * one live carousel per campaign card, a 1282-line wizard's autosave. Do not
 * "fix" the server half by converting pages to client components.
 *
 * Prefer the `@3xl:` container query over this component when all three hold:
 * the element is cheap and server-rendered, it needs no explanation, and hiding
 * it at 500px in web mode is *also* correct. This component is for the cases
 * where the operator has to be told, because `@3xl` is false in the web console
 * between 480 and 1024px too — a CSS gate would tell someone standing in the
 * console to go find the console.
 */
export function ConsoleOnly({
  tool,
  why,
  variant = "inline",
  notice = true,
  children,
}: Readonly<{
  /**
   * The thing that isn't here, named as the operator would name it. It becomes
   * the subject of a sentence — "{tool} runs in the web console only" — so write
   * it to read as one: "Building a settlement", "The menu editor". Not a bare
   * verb, not a sentence of its own.
   */
  tool: string;
  /**
   * The half of the message worth reading: what *does* still work on this
   * screen, or why the job wants a desk. One short sentence, ending in a full
   * stop. Skip it on a fully gated page and the notice falls back to a general
   * reassurance, which is the right thing there and wrong anywhere else — two
   * gates on one screen must not say the same sentence twice.
   */
  why?: string;
  /** `inline` replaces a control mid-page; `page` replaces a whole screen body. */
  variant?: "inline" | "page";
  /**
   * Set `false` when the explanation for this tool already appears elsewhere on
   * the page — a button in a header's `shrink-0` action slot has no room for a
   * notice card, so it drops out and a single `<ConsoleOnly tool={…} />` in the
   * body carries the message once. Never use it to hide something the operator
   * is told nothing about.
   */
  notice?: boolean;
  /** Omit to render the notice alone: nothing in the console, the note on a phone. */
  children?: React.ReactNode;
}>) {
  const mode = useAdminShellMode();
  if (mode === "web") return <>{children ?? null}</>;
  if (!notice) return null;
  return <ConsoleOnlyNotice tool={tool} why={why} variant={variant} />;
}

/**
 * The notice on its own, for slots where there is no `children` to gate — a
 * settings menu row that is simply replaced, for instance.
 */
export function ConsoleOnlyNotice({
  tool,
  why,
  variant = "inline",
}: Readonly<{
  tool: string;
  why?: string;
  variant?: "inline" | "page";
}>) {
  // Two different readers, two different fixes, so two different messages.
  //
  // On a desktop the operator is *previewing* the phone frame and the console
  // is one click away, so the note points at the Layout switcher. On a real
  // handset it is not one click away — it is not reachable at all, because the
  // phone frame is forced below 480px (and for a phone-shaped user agent on the
  // server), so `setPreference("web")` would change nothing on screen. Telling
  // that reader to "switch layout" would send them hunting for a control that
  // isn't there.
  const isDesktop = useIsDesktop();

  // Deliberately not "needs the width". Width is the reason for the vendor
  // table; it is not the reason for the platform fee form or for typing a UTR
  // against a bank transfer. The base sentence states the rule, and `why`
  // carries the reason that is actually true for this screen.
  const title = isDesktop ? "Switch to Web to use this" : "Open this on a computer";
  const lead = isDesktop
    ? `${tool} runs in the console layout — the Layout switcher is bottom-right, and this screen is already wide enough for it.`
    : `${tool} runs in the web console only, so it isn't available on a phone.`;
  // The fallback is for fully gated pages, where "the rest of this screen" does
  // not exist and the reassurance has to be about the admin as a whole.
  const body = `${lead} ${why ?? "Everything else in the admin works fine here."}`;

  if (variant === "page") {
    return (
      <div role="note">
        <EmptyState
          icon={Monitor}
          title={title}
          description={body}
          // Only on a real handset, and only when the whole screen is gated.
          // A desktop preview needs no link — the console is one click away —
          // and an inline notice sits beside working controls, where a button
          // saying "go elsewhere" competes with the work still on the page.
          action={isDesktop ? undefined : <SendToComputer />}
        />
      </div>
    );
  }

  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3"
    >
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-surface text-muted">
        <Monitor className="size-4" />
      </span>
      <p className="text-sm text-muted">
        <span className="font-semibold text-ink">{title}.</span> {body}
      </p>
    </div>
  );
}

/**
 * Hands the operator the one thing the notice above is missing: the address of
 * the page they are standing on, in a form they can open at a desk.
 *
 * "Open this on a computer" is only half an instruction — the other half is a
 * deep link into `/admin/vendors/new?draft=…` that nobody is going to retype
 * from a phone screen. The share sheet is the phone-native answer and lands in
 * WhatsApp, which is where an operator here will actually send it to themselves;
 * clipboard is the fallback where the sheet doesn't exist.
 *
 * The URL is read at click time, not at render: this component is mounted on
 * server-rendered pages, where `window` doesn't exist on the first pass.
 */
function SendToComputer() {
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);

  async function send() {
    const url = window.location.href;

    if (navigator.share) {
      try {
        await navigator.share({ title: "Deligro admin", url });
        return; // no confirmation needed — the sheet was the confirmation
      } catch {
        return; // dismissed, not failed
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setSent(true);
      setFailed(false);
    } catch {
      // Blocked clipboard, insecure context, an old webview. Say so rather than
      // leaving a button that looks like it worked.
      setFailed(true);
    }
  }

  if (failed) {
    return (
      <p className="text-xs text-muted">
        Copy the address from your browser&apos;s address bar and open it on a
        computer.
      </p>
    );
  }

  return (
    <Button type="button" variant="secondary" size="sm" onClick={send}>
      {sent ? <Check className="size-4" /> : <Send className="size-4" />}
      {sent ? "Link copied" : "Send myself this link"}
    </Button>
  );
}
