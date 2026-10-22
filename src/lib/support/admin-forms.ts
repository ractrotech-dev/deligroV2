import { parseAnnouncement, parseStaffReply } from "@/lib/support/rules";

/**
 * The admin support desk's and announcement composer's forms, parsed — what
 * every action in `app/admin/support/actions.ts` and
 * `app/admin/announcements/actions.ts` runs straight after its role gate.
 * Pure (FormData in, a value or an error code out) so the QA script runs it
 * bare; the sentences an operator reads are here too.
 */

const field = (form: FormData, key: string): string | null => {
  const v = form.get(key);
  return typeof v === "string" ? v : null;
};

/** A reply or internal note, with an optional status. */
export function replyFromForm(form: FormData) {
  return parseStaffReply({
    body: field(form, "body"),
    internal: field(form, "internal") === "on",
    status: field(form, "status") || null,
  });
}

const DESK_ERRORS: Record<string, string> = {
  invalid_body: "Write a reply first (up to 4000 characters).",
  invalid_status: "Pick a status from the list.",
  not_found: "That ticket no longer exists.",
};

export function deskError(code: string): string {
  return DESK_ERRORS[code] ?? "That didn't save. Try again.";
}

/**
 * A `datetime-local` value typed in IST ("2030-01-05T09:30") as an instant.
 * Blank is null (now / no end); anything unreadable is passed through so the
 * parser refuses it.
 */
export function istLocalToIso(value: string | null): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
  const t = Date.parse(`${value}:00+05:30`);
  return Number.isFinite(t) ? new Date(t).toISOString() : value;
}

/** An announcement from the composer. English only (owner decision). */
export function announcementFromForm(form: FormData) {
  return parseAnnouncement({
    audience: field(form, "audience"),
    title: field(form, "title"),
    body: field(form, "body"),
    startsAt: istLocalToIso(field(form, "startsAt")),
    endsAt: istLocalToIso(field(form, "endsAt")),
    push: field(form, "push") === "on",
  });
}

const ANNOUNCEMENT_ERRORS: Record<string, string> = {
  invalid_audience: "Pick who it is for.",
  invalid_title: "Give it a title of 3 to 120 characters.",
  invalid_body: "Write the message (up to 2000 characters).",
  invalid_dates: "Check the dates: the end has to come after the start (and after now).",
};

export function announcementError(code: string): string {
  return ANNOUNCEMENT_ERRORS[code] ?? "Check the form and try again.";
}
