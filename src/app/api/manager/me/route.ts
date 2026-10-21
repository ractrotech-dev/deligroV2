import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { citiesInScope, listCitiesWithZones } from "@/lib/data-access/zones";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/me — the Manager app's first call after sign-in.
 *
 * → { profile: { id, fullName, phone, email, role },
 *     zones: { all, cities: [{ id, name, zones: [{ id, name, slug, isDefault }] }] },
 *     permissions: { "manager.…": boolean } }
 *
 * `zones.all` is true for an admin. A manager with no zones gets
 * `{ all: false, cities: [] }` and the app says so instead of showing a city.
 */
export async function GET() {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const { profile, scope, permissions } = ctx;

  try {
    const supabase = await createClient();
    const [{ data: auth }, cities] = await Promise.all([
      supabase.auth.getUser(),
      listCitiesWithZones().catch(() => []),
    ]);

    return NextResponse.json({
      profile: {
        id: profile.id,
        fullName: profile.full_name,
        phone: profile.phone,
        email: auth.user?.email ?? null,
        role: profile.role,
      },
      zones: {
        all: scope.all,
        cities: citiesInScope(cities, scope).map((c) => ({
          id: c.id,
          name: c.name,
          zones: c.zones.map((z) => ({ id: z.id, name: z.name, slug: z.slug, isDefault: z.isDefault })),
        })),
      },
      permissions,
    });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
