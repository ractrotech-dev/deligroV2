import { Bike, Phone, User } from "lucide-react";
import { ProfileAvatar } from "@/components/profile/profile-avatar";
import { DriverProfileRows } from "@/components/driver/driver-profile-rows";
import { requireRole } from "@/lib/auth";
import { getProfileSummary } from "@/lib/data-access/profile";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * The rider's own details.
 *
 * Platform: BOTH is not a meaningful answer here — the courier app has one
 * shell, the phone frame (see `driver/layout.tsx`). No `ConsoleOnly`, no
 * container-query columns; this is a phone screen and only ever a phone screen.
 *
 * Why it exists at all: the customer's tracking screen already renders
 * "{rider} is heading to you" (`lib/utils/order-status.ts`) and falls back to
 * "Your courier" when `profiles.full_name` is empty. The caption was never
 * missing — riders simply had nowhere to set the name it reads. That is the
 * whole feature, and it is why the name field carries a line saying so.
 *
 * Almost entirely assembly. `ProfileEditSheet` and `ProfileAvatar` are already
 * role-agnostic and already post to `/api/profile` and `/api/profile/avatar`,
 * both of which authorise any signed-in user, rate limit, and make a phone
 * change consume an OTP delivered to the NEW number. No new endpoint, no new
 * server action, no migration: `full_name`, `phone` and `avatar_url` have all
 * existed on `profiles` since 0001/0012.
 */
export const dynamic = "force-dynamic";

export default async function DriverProfilePage() {
  // The layout already gates this to drivers. Repeated because a Server
  // Component is reachable on its own and "the layout checked" is exactly the
  // assumption AGENTS.md rule 3 exists to refuse.
  const profile = await requireRole("driver");

  const summary = isSupabaseConfigured ? await getProfileSummary() : null;

  const name = summary?.name ?? profile.full_name ?? "";
  const phone = summary?.phone ?? profile.phone ?? null;

  return (
    <div className="space-y-5">
      <header className="flex flex-col items-center gap-3 pt-1 text-center">
        <ProfileAvatar
          name={name}
          initials={summary?.initials ?? "🙂"}
          avatarUrl={summary?.avatarUrl ?? null}
        />
        <div>
          <p className="text-lg font-extrabold tracking-tight">
            {name || "Set your name"}
          </p>
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs font-medium text-muted">
            <Bike className="size-3.5" />
            Deligro rider
            {summary?.memberSince ? ` · since ${summary.memberSince}` : ""}
          </p>
        </div>
      </header>

      {/* The rows are a client island because each opens `ProfileEditSheet`.
          Everything above is server-rendered, so the first paint carries the
          real name and photo rather than a spinner. */}
      <DriverProfileRows
        name={name}
        phone={phone}
        editable={isSupabaseConfigured}
      />

      <section className="card space-y-2.5 p-4">
        <p className="text-label">What customers see</p>
        <p className="text-sm leading-relaxed text-muted">
          {name ? (
            <>
              While you&apos;re delivering, the customer&apos;s order screen
              says{" "}
              <span className="font-semibold text-ink">
                “{name.split(/\s+/)[0]} is heading to you”
              </span>
              .
            </>
          ) : (
            <>
              Until you set your name, customers just see{" "}
              <span className="font-semibold text-ink">“Heading to you”</span>.
              Adding it tells them who is at the door.
            </>
          )}
        </p>
        <p className="text-xs leading-relaxed text-muted">
          Your phone number is only shown to a customer while you are carrying
          their order, so they can call about the door or the gate.
        </p>
      </section>

      <ul className="space-y-2 text-xs leading-relaxed text-muted">
        <li className="flex items-start gap-2">
          <User className="mt-0.5 size-3.5 shrink-0" />
          Your name and photo are yours to change any time.
        </li>
        <li className="flex items-start gap-2">
          <Phone className="mt-0.5 size-3.5 shrink-0" />
          Changing your number needs a code sent to the new one — it is also
          what you sign in with.
        </li>
      </ul>
    </div>
  );
}
