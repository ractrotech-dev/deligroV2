import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { driveConfig } from "@/lib/drive/core";
import { completeDriveConnection } from "@/lib/data-access/google-drive";
import { logOpsAction } from "@/lib/data-access/ops-audit";
import { captureError } from "@/lib/obs/emit";
import { DRIVE_STATE_COOKIE } from "../state";

function sameState(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Google sends the owner back here. Back to the page from the configured address, not the Host header. */
export async function GET(request: NextRequest) {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`drive-connect:${admin.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const config = driveConfig();
  const origin = config ? new URL(config.redirectUri).origin : request.nextUrl.origin;
  const back = (result: string) => {
    const response = NextResponse.redirect(new URL(`/admin/storage?tab=drive&drive=${result}`, origin));
    response.cookies.delete({ name: DRIVE_STATE_COOKIE, path: "/api/admin/drive" });
    return response;
  };

  const params = request.nextUrl.searchParams;
  if (!sameState(request.cookies.get(DRIVE_STATE_COOKIE)?.value, params.get("state"))) return back("failed");
  if (params.get("error")) return back("denied");
  const code = params.get("code");
  if (!config || !code) return back("failed");

  try {
    const result = await completeDriveConnection(code, admin.id);
    if (!result.ok) return back(result.reason);
    // Saved already; a failed audit write must not report it as failed.
    await logOpsAction({
      actorId: admin.id,
      action: "storage.drive_connected",
      entityType: "platform",
      entityId: null,
      after: { email: result.email },
    }).catch(() => undefined);
    revalidatePath("/admin/storage");
    return back("connected");
  } catch (e) {
    captureError(e, { source: "google-drive", attrs: { event: "drive_connect_failed" } });
    return back("failed");
  }
}
