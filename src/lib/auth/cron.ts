import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * The door of every `/api/cron/*` route: `Authorization: Bearer <CRON_SECRET>`,
 * the header Vercel Cron attaches on its own, compared in constant time.
 *
 * Fails closed (AGENTS.md rule 2): with no secret configured, or one shorter
 * than 16 characters, nobody is authorised — a cron route must never become a
 * public "push every rider" button because an env var is missing.
 */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 16) return false;
  const header = req.headers.get("authorization") ?? "";
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
