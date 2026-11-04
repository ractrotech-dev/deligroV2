"use client";

import { useState } from "react";
import { Phone, User } from "lucide-react";
import type { ProfileSummary } from "@/lib/data-access/profile";
import { ProfileEditSheet } from "@/components/profile/profile-edit-sheet";
import { useT } from "@/components/providers/lang-provider";

export function ProfileAccountRows({
  summary,
  readOnly = false,
}: Readonly<{
  summary: ProfileSummary;
  /** A customer with "Edit profile" switched off: shown, not changeable. */
  readOnly?: boolean;
}>) {
  const [editField, setEditField] = useState<"name" | "phone" | null>(null);
  const t = useT();

  return (
    <div className="relative">
      <div className="divide-y divide-line">
        <EditRow
          icon={<User className="size-[18px]" />}
          tone="bg-blue/12 text-blue"
          value={summary.name}
          onEdit={readOnly ? undefined : () => setEditField("name")}
        />
        {summary.phone ? (
          <EditRow
            icon={<Phone className="size-[18px]" />}
            tone="bg-green/12 text-green"
            value={summary.phone}
            onEdit={readOnly ? undefined : () => setEditField("phone")}
          />
        ) : (
          <EditRow
            icon={<Phone className="size-[18px]" />}
            tone="bg-green/12 text-green"
            value={t("Add phone number", "फ़ोन नंबर जोड़ें")}
            muted
            onEdit={readOnly ? undefined : () => setEditField("phone")}
          />
        )}
      </div>

      <ProfileEditSheet
        open={editField === "name"}
        field="name"
        value={summary.name}
        onClose={() => setEditField(null)}
      />
      <ProfileEditSheet
        open={editField === "phone"}
        field="phone"
        value={summary.phone ?? ""}
        onClose={() => setEditField(null)}
      />
    </div>
  );
}

function EditRow({
  icon,
  tone,
  value,
  onEdit,
  muted,
}: Readonly<{
  icon: React.ReactNode;
  tone: string;
  value: string;
  onEdit?: () => void;
  muted?: boolean;
}>) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onEdit}
      disabled={!onEdit}
      className="press flex w-full items-center gap-3 py-3 text-left"
    >
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-xl ${tone}`}
      >
        {icon}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[15px] font-medium${
          muted ? " text-muted" : ""
        }`}
      >
        {value}
      </span>
      {onEdit ? (
        <span className="text-sm font-bold text-accent-ink">
          {t("Edit", "बदलें")}
        </span>
      ) : null}
    </button>
  );
}
