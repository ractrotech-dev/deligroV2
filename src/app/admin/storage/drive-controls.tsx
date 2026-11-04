"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fieldCls } from "@/components/ui/field";
import { disconnectDriveAction, setDriveFolderAction } from "./drive-actions";

export function DriveDisconnect({ email }: Readonly<{ email: string }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="ml-auto inline-flex items-center gap-3">
      {error ? <span className="text-[12.5px] font-medium text-deal">{error}</span> : null}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Disconnect ${email}? Photos already on dishes stay there.`)) return;
          start(async () => {
            setError(null);
            const res = await disconnectDriveAction();
            if (!res.ok) setError(res.error);
            router.refresh();
          });
        }}
        className="c-btn c-btn-outline disabled:opacity-50"
      >
        Disconnect
      </button>
    </span>
  );
}

export function DriveFolderForm({
  current,
  count,
}: Readonly<{ current: string | null; count: number }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(!current);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <p className="flex flex-wrap items-center gap-2.5 text-[13.5px] text-ink">
        Photo folder: <span className="font-semibold">{current}</span>
        <span className="text-muted">
          {count} named photo{count === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-[12.5px] font-semibold text-accent-ink hover:underline"
        >
          Change
        </button>
      </p>
    );
  }

  return (
    <div className="admin-measure space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Paste the Drive folder link"
          aria-label="Drive folder link"
          disabled={pending}
          className={`${fieldCls} h-9 flex-1`}
        />
        <button
          type="button"
          disabled={pending || !link.trim()}
          onClick={() =>
            start(async () => {
              setError(null);
              const res = await setDriveFolderAction(link);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              setEditing(false);
              setLink("");
              router.refresh();
            })
          }
          className="c-btn c-btn-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {current ? (
          <button type="button" disabled={pending} onClick={() => setEditing(false)} className="c-btn-quiet">
            Cancel
          </button>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-[12.5px] font-medium text-deal">{error}</p> : null}
    </div>
  );
}
