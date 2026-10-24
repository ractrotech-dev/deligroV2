/**
 * Who a failing server request belonged to, read straight out of the
 * Supabase session cookie WITHOUT verifying it (OBSERVABILITY_V2.md, phase 2).
 *
 * This is a label on an error report, never a permission: nothing is granted
 * on it, so an unverified (even forged) cookie can at worst mislabel a row.
 * Verifying it would mean a network call inside a request that is already
 * failing, which is the wrong time to add one.
 *
 * Runtime-agnostic (Node and Edge): no imports, `atob` only.
 */

const COOKIE = /^sb-[a-z0-9]+-auth-token(?:\.(\d+))?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64UrlDecode(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
}

/** The signed-in profile id in a `Cookie` header, or null. */
export function actorIdFromCookieHeader(header: string | null | undefined): string | null {
  try {
    if (!header) return null;
    const chunks: { index: number; value: string }[] = [];
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      const match = COOKIE.exec(name);
      if (!match) continue;
      chunks.push({ index: match[1] ? Number(match[1]) : -1, value: decodeURIComponent(part.slice(eq + 1).trim()) });
    }
    if (chunks.length === 0) return null;
    chunks.sort((a, b) => a.index - b.index);
    let raw = chunks.map((c) => c.value).join("");
    if (raw.startsWith("base64-")) raw = base64UrlDecode(raw.slice(7));
    const session = JSON.parse(raw) as { access_token?: unknown };
    if (typeof session.access_token !== "string") return null;
    const payload = session.access_token.split(".")[1];
    if (!payload) return null;
    const sub = (JSON.parse(base64UrlDecode(payload)) as { sub?: unknown }).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub.toLowerCase() : null;
  } catch {
    return null;
  }
}
