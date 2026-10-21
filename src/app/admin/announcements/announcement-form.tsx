"use client";

import { useActionState, useTransition } from "react";
import { fieldCls, labelCls } from "@/components/ui/field";
import { createAnnouncementAction, endAnnouncementAction } from "@/app/admin/growth-actions";

export function AnnouncementForm() {
  const [state, action, pending] = useActionState(createAnnouncementAction, null);
  return (
    <form action={action} className="card mt-4 grid gap-3 p-5 md:grid-cols-2">
      <label className="space-y-1">
        <span className={labelCls}>For</span>
        <select name="audience" defaultValue="vendor" className={fieldCls}>
          <option value="vendor">Shops (Partner app)</option>
          <option value="rider">Riders</option>
          <option value="manager">Managers</option>
          <option value="all">Everyone working</option>
        </select>
      </label>
      <label className="space-y-1">
        <span className={labelCls}>Title</span>
        <input name="title" required minLength={3} maxLength={120} className={fieldCls} />
      </label>
      <label className="space-y-1 md:col-span-2">
        <span className={labelCls}>Message</span>
        <textarea name="body" required rows={3} maxLength={2000} className={fieldCls} />
      </label>
      <label className="space-y-1">
        <span className={labelCls}>Starts (IST, blank = now)</span>
        <input type="datetime-local" name="startsAt" className={fieldCls} />
      </label>
      <label className="space-y-1">
        <span className={labelCls}>Ends (IST, blank = until ended)</span>
        <input type="datetime-local" name="endsAt" className={fieldCls} />
      </label>
      <div className="flex flex-wrap items-center gap-3 md:col-span-2">
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" name="push" defaultChecked /> Push it to their phones now (when it starts now)
        </label>
        <button disabled={pending} className="c-btn c-btn-dark press">
          {pending ? "Publishing…" : "Publish"}
        </button>
        {state ? (
          <span role="status" className={state.ok ? "text-green" : "text-deal"}>
            {state.ok ? state.message : state.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function EndAnnouncementButton({ id }: Readonly<{ id: string }>) {
  const [pending, start] = useTransition();
  return (
    <button disabled={pending} onClick={() => start(async () => void (await endAnnouncementAction(id)))} className="c-btn press text-[13px]">
      End now
    </button>
  );
}
