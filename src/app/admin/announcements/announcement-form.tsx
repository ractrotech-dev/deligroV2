"use client";

import { useActionState, useState, useTransition } from "react";
import { Field, fieldCls } from "@/components/ui/field";
import { Panel } from "@/components/admin/console";
import { createAnnouncementAction, endAnnouncementAction, type ComposerResult } from "./actions";

const AUDIENCES = [
  { value: "rider", label: "Riders" },
  { value: "vendor", label: "Shops (Partner app)" },
  { value: "manager", label: "Managers" },
  { value: "all", label: "Everyone working (riders, shops, managers)" },
] as const;

function Outcome({ result }: Readonly<{ result: ComposerResult | null }>) {
  if (!result) return null;
  return (
    <p
      role={result.ok ? "status" : "alert"}
      className={`rounded-lg border px-3 py-2 text-[12.5px] font-medium ${
        result.ok ? "border-green/30 bg-green-soft text-green" : "border-deal/30 bg-deal-soft text-deal"
      }`}
    >
      {result.ok ? (result.message ?? "Published.") : result.error}
    </p>
  );
}

/**
 * The composer: who it is for, the message, when it runs (IST), whether to
 * push it now — and a preview of the inbox card people will see. English only
 * (owner decision for the rider and Partner apps).
 */
export function AnnouncementForm() {
  const [state, action, pending] = useActionState(createAnnouncementAction, null);
  const [audience, setAudience] = useState<string>("rider");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [push, setPush] = useState(true);
  const label = AUDIENCES.find((a) => a.value === audience)?.label ?? audience;

  return (
    <div className="grid gap-4 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Panel title="New announcement" description="Pinned at the top of their inbox while it runs.">
        <form action={action} className="space-y-3">
          <Field label="For">
            <select name="audience" value={audience} onChange={(e) => setAudience(e.target.value)} className={fieldCls}>
              {AUDIENCES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title" hint="3 to 120 characters.">
            <input name="title" required minLength={3} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={fieldCls} />
          </Field>
          <Field label="Message">
            <textarea name="body" required rows={4} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} className={fieldCls} />
          </Field>
          <div className="grid gap-3 @lg:grid-cols-2">
            <Field label="Starts (IST)" hint="Blank: now.">
              <input type="datetime-local" name="startsAt" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={fieldCls} />
            </Field>
            <Field label="Ends (IST)" hint="Blank: until you end it.">
              <input type="datetime-local" name="endsAt" className={fieldCls} />
            </Field>
          </div>
          <label className="flex min-h-9 items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" name="push" checked={push} onChange={(e) => setPush(e.target.checked)} />
            Also send it as a notification now {startsAt ? "(only when it starts now — a scheduled one appears in the inbox at its start)" : ""}
          </label>
          <Outcome result={state} />
          <button type="submit" disabled={pending} className="c-btn c-btn-dark press">
            {pending ? "Publishing…" : startsAt ? "Schedule" : "Publish"}
          </button>
        </form>
      </Panel>

      <Panel title="Preview" description={`What ${label.toLowerCase()} see in their inbox.`}>
        <div className="rounded-lg border border-line bg-surface p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-accent-ink">Announcement</p>
          <p className="mt-1 text-[14px] font-bold text-ink">{title.trim() || "Your title"}</p>
          <p className="mt-1 whitespace-pre-line text-[13px] text-ink">{body.trim() || "Your message."}</p>
        </div>
        {push && !startsAt ? (
          <p className="mt-2 text-[12px] text-muted">
            Riders who switched announcements off in their app get the inbox entry without the notification.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

export function EndAnnouncementButton({ id, scheduled }: Readonly<{ id: string; scheduled: boolean }>) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await endAnnouncementAction(id);
            setError(r.ok ? null : r.error);
          })
        }
        className="c-btn-quiet press"
      >
        {scheduled ? "Withdraw" : "End now"}
      </button>
      {error ? <span className="text-[11.5px] text-deal">{error}</span> : null}
    </span>
  );
}
