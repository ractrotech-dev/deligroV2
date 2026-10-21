import { NextResponse } from "next/server";
import {
  managerApiContext,
  managerWriteLimit,
  readJsonObject,
} from "@/lib/auth/manager-api.server";
import { logOpsActionSafely } from "@/lib/data-access/ops-audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, createPublicClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/password  { current, next } — change the signed-in
 * person's password (§15.5).
 *
 * The current password is checked first with a client that keeps no session,
 * so a stolen unlocked phone cannot lock the owner out. Five tries per 15
 * minutes per person.
 *
 *   200 { ok: true }
 *   400 bad_request | weak_password (fewer than 8 characters, or same as current)
 *   401 bad_credentials
 *   409 no_email — the account signs in by OTP only; set a password from the admin desk
 */
const MIN_LENGTH = 8;

export async function POST(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  const body = await readJsonObject(request);
  const current = typeof body?.current === "string" ? body.current : "";
  const next = typeof body?.next === "string" ? body.next : "";
  if (!body || !current || !next) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (next.length < MIN_LENGTH || next === current) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  const limited = await managerWriteLimit(ctx, "password", 5, 15 * 60_000);
  if (limited) return limited;

  const { data: auth } = await (await createClient()).auth.getUser();
  const email = auth.user?.email;
  if (!email) return NextResponse.json({ error: "no_email" }, { status: 409 });

  const verifier = createPublicClient();
  const check = await verifier.auth.signInWithPassword({ email, password: current });
  if (check.error || !check.data.session) {
    return NextResponse.json({ error: "bad_credentials" }, { status: 401 });
  }
  // The check opened a session of its own; end that one only. The default
  // scope is global and would sign the app out too.
  await verifier.auth.signOut({ scope: "local" }).catch(() => undefined);

  const { error } = await createAdminClient().auth.admin.updateUserById(ctx.profile.id, {
    password: next,
  });
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 502 });

  await logOpsActionSafely({
    actorId: ctx.profile.id,
    action: "password.change",
    entityType: "profile",
    entityId: ctx.profile.id,
  });
  return NextResponse.json({ ok: true });
}
