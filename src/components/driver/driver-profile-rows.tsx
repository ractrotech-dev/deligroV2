"use client";

import { useState } from "react";
import { ChevronRight, Phone, User } from "lucide-react";
import { ProfileEditSheet } from "@/components/profile/profile-edit-sheet";

/**
 * The two editable rows on the rider's profile, and the sheet they open.
 *
 * A client island rather than a client page: everything around it — the avatar,
 * the name, the "what customers see" panel — is server-rendered, so the screen
 * paints with the rider's real details instead of a spinner. Only the part that
 * needs `useState` is a client component.
 *
 * `ProfileEditSheet` is reused untouched. It already owns the phone-change OTP
 * flow, which is not a detail worth reimplementing here: `profiles.phone` is
 * what OTP login resolves an account from, so a rider changing it is changing
 * how they sign in.
 */
export function DriverProfileRows({
  name,
  phone,
  editable,
}: {
  name: string;
  phone: string | null;
  /** False with no backend — the rows render, disabled, rather than vanishing. */
  editable: boolean;
}) {
  const [field, setField] = useState<"name" | "phone" | null>(null);

  const rows = [
    {
      key: "name" as const,
      icon: User,
      label: "Name",
      value: name || "Not set",
      unset: !name,
      hint: "Shown to customers while you deliver",
    },
    {
      key: "phone" as const,
      icon: Phone,
      label: "Phone",
      value: phone || "Not set",
      unset: !phone,
      hint: "You sign in with this",
    },
  ];

  return (
    <>
      <section className="card divide-y divide-[color:var(--line)] overflow-hidden p-0">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <button
              key={row.key}
              type="button"
              disabled={!editable}
              onClick={() => setField(row.key)}
              className="press flex w-full items-center gap-3 px-4 py-3.5 text-left disabled:opacity-60"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold">
                  {row.label}
                </span>
                <span
                  className={
                    "block truncate text-sm" +
                    (row.unset ? " text-muted" : " text-ink")
                  }
                >
                  {row.value}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {row.hint}
                </span>
              </span>
              {editable ? (
                <ChevronRight className="size-4 shrink-0 text-muted" />
              ) : null}
            </button>
          );
        })}
      </section>

      {/* Mounted only while open so the sheet's draft state starts from the
          saved value each time, rather than from whatever was typed and
          abandoned last time. */}
      {field ? (
        <ProfileEditSheet
          open
          field={field}
          value={(field === "name" ? name : phone) ?? ""}
          onClose={() => setField(null)}
        />
      ) : null}
    </>
  );
}
