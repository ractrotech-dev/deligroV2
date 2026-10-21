import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import {
  appVersionAnswer,
  parseReleaseApp,
  parseVersionCode,
} from "@/lib/releases/app-version";

/**
 * GET /api/app-version?app=rider|customer|vendor|manager&versionCode=<int>
 *
 * The update check for the two Android apps. They are built outside this repo
 * and installed from a direct `.apk` — there is no Play Store to notice a bad
 * build — so this is the only way to tell a fleet it is out of date.
 *
 * No auth: an app has to find out whether it is too old to run BEFORE it has a
 * session to ask with. Nothing here is private either — a version number and a
 * download URL both ship inside every APK already.
 *
 * Writes nothing, so no rate limit (AGENTS.md §6). The one moving part is
 * `platform_settings`, which is public-read by policy, and the answer is the
 * same for every caller.
 *
 * **Fails open, deliberately, and for free.** `getSettings()` never throws — an
 * unreadable or un-migrated backend gives back the `DEFAULT_SETTINGS` shape,
 * where every version code is 1. Any real installed build has a versionCode
 * >= 1, so it compares as neither behind the latest nor below the minimum and
 * this route answers "you are current" with no fallback branch to write. That
 * is the safe direction here: AGENTS.md §2 is about authorization, and this
 * grants nothing — failing the other way would force-update an entire fleet off
 * the back of a transient database fault, with an APK URL we could not read.
 * (Contrast `outageSettings()`, which fails *closed* on `acceptingOrders`. Same
 * outage, opposite safe direction, because that field gates money.)
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const app = parseReleaseApp(url.searchParams.get("app"));
  const versionCode = parseVersionCode(url.searchParams.get("versionCode"));

  if (!app || versionCode === null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const settings = await getSettings();
  return NextResponse.json(appVersionAnswer(settings, app, versionCode));
}
