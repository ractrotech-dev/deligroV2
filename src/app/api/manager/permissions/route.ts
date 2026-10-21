import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { featuresFor, isDefaultOn } from "@/lib/features/catalog";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/permissions — every manager power with its label and the
 * signed-in person's state (§15.4: role and permission display).
 *
 * → { role, permissions: [{ key, label, offMeans, on, defaultOn }] }
 *
 * Labels come from the catalog the admin's Feature access panel reads, so the
 * app and the panel always name a power the same way.
 */
export async function GET() {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  return NextResponse.json({
    role: ctx.profile.role,
    permissions: featuresFor("manager").map((f) => ({
      key: f.key,
      label: f.label,
      offMeans: f.offMeans,
      on: ctx.permissions[f.key] === true,
      defaultOn: isDefaultOn(f),
    })),
  });
}
