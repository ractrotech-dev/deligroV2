/**
 * The (timestamp, uuid) cursor of the customer sub-lists (complaints, feedback, refunds).
 * It is a timestamp and a uuid and nothing else: both halves are matched strictly, because
 * the decoded text goes into a PostgREST filter, where anything looser than that could
 * smuggle in filter syntax.
 */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const keyCursor = (at: string, id: string): string => Buffer.from(`${at}|${id}`, "utf8").toString("base64url");

export function decodeKeyCursor(s: string | null): { at: string; id: string } | null {
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const raw = Buffer.from(s, "base64url").toString("utf8");
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const at = raw.slice(0, bar), id = raw.slice(bar + 1);
  if (!ISO.test(at) || Number.isNaN(Date.parse(at)) || !UUID.test(id)) return null;
  return { at, id: id.toLowerCase() };
}
