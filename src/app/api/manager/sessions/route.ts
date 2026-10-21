import { NextResponse } from "next/server";
import {
  managerApiContext,
  managerWriteLimit,
  readJsonObject,
} from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The signed-in person's sessions (§15.6), through my_sessions() and
 * revoke_my_session() (migration 0141) on their own cookie-bound client, so
 * the database itself limits them to their own rows.
 *
 * GET    → { sessions: [{ id, createdAt, lastSeenAt, userAgent, ip, current }] }
 * DELETE { id }        → ends one other session
 * DELETE { all: true } → ends every session, this one included
 *
 * 501 `sessions_unavailable` when 0141 is not applied yet.
 */
interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string | null;
  user_agent: string | null;
  ip: string | null;
  is_current: boolean;
}

const UNAVAILABLE = () =>
  NextResponse.json({ error: "sessions_unavailable" }, { status: 501 });

export async function GET() {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_sessions");
  if (error) return UNAVAILABLE();
  return NextResponse.json({
    sessions: ((data ?? []) as SessionRow[]).map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.updated_at ?? s.created_at,
      userAgent: s.user_agent,
      ip: s.ip,
      current: s.is_current,
    })),
  });
}

export async function DELETE(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "sessions", 20);
  if (limited) return limited;

  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();

  if (body.all === true) {
    // The others end, and are logged, in one database call; then this one
    // signs out locally. Never the auth API's global sign-out, which leaves
    // nothing in the audit log if the log write fails afterwards.
    const { error } = await supabase.rpc("revoke_my_other_sessions");
    if (error) return UNAVAILABLE();
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    return NextResponse.json({ ok: true, signedOut: true });
  }

  if (!isUuid(body.id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { data, error } = await supabase.rpc("revoke_my_session", { p_id: body.id });
  if (error) {
    if (/use_sign_out/.test(error.message)) {
      return NextResponse.json({ error: "use_sign_out" }, { status: 409 });
    }
    return UNAVAILABLE();
  }
  // revoke_my_session() writes its own audit entry in the same transaction.
  if (data !== true) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
