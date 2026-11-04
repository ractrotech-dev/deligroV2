import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireRole } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { driveConfig, googleSignInUrl } from "@/lib/drive/core";
import { DRIVE_STATE_COOKIE } from "../state";

/**
 * GET → Google's sign-in, for the owner's own account. The random state goes in an
 * httpOnly cookie and comes back on the callback, so a sign-in nobody started here
 * can't attach someone else's Drive.
 */
export async function GET(request: Request) {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`drive-connect:${admin.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const config = driveConfig();
  if (!config) return NextResponse.redirect(new URL("/admin/storage?tab=drive", request.url));

  const state = randomBytes(32).toString("base64url");
  const response = NextResponse.redirect(googleSignInUrl(config, state));
  response.cookies.set(DRIVE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(config.redirectUri).protocol === "https:",
    path: "/api/admin/drive",
    maxAge: 600,
  });
  return response;
}
