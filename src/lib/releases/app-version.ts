import type { PlatformSettings } from "@/types";

/**
 * The version gate for the two Android apps.
 *
 * Both apps are built outside this repo and installed from a direct `.apk`, so
 * there is no store to notice a bad build and no store to update from. This
 * module is the whole mechanism: an app reports the `versionCode` it is running
 * and gets back whether a newer one exists, whether the one it is on is still
 * allowed, and where the file is.
 *
 * Deliberately pure and free of `server-only` — it does no I/O, reads nothing
 * from the environment and is exercised directly by `scripts/qa/app-version.ts`.
 * The route (`/api/app-version`) is the thin part: read settings, call this.
 */

/** The two apps with their own release track. */
const RELEASE_APPS = ["rider", "customer"] as const;

export type ReleaseApp = (typeof RELEASE_APPS)[number];

export interface AppVersionAnswer {
  latestVersionCode: number;
  minSupportedVersionCode: number;
  /** A newer build exists. True whenever `forceUpdate` is. */
  updateAvailable: boolean;
  /** The running build is below the floor and must not keep running. */
  forceUpdate: boolean;
  apkUrl: string;
  releaseNotes: string;
}

/**
 * Narrow an untrusted `?app=` value. Returns null rather than defaulting to one
 * of the apps: answering a request for `?app=driver` with the customer track
 * would silently tell a rider fleet the wrong thing.
 */
export function parseReleaseApp(raw: string | null): ReleaseApp | null {
  return (RELEASE_APPS as readonly string[]).includes(raw ?? "")
    ? (raw as ReleaseApp)
    : null;
}

/**
 * Narrow an untrusted `?versionCode=`. Android `versionCode` is a positive
 * integer, so anything else — absent, empty, `1.2.3`, `-4`, `1e9`, `07x` — is a
 * malformed request rather than a version to compare against.
 *
 * `Number()` rather than `parseInt()` on purpose: `parseInt("1.9")` is 1 and
 * `parseInt("12abc")` is 12, both of which would quietly answer a question
 * nobody asked.
 */
export function parseVersionCode(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * An APK download URL we are willing to hand an app, or `""`.
 *
 * Stricter than `safeExternalHref` (which allows http, because a banner link is
 * a web page) and stricter on purpose. What is at the end of this URL gets
 * *installed*, by a phone that has already been told to trust sideloaded
 * builds. Over plain http any network between the rider and the file — a shop's
 * wifi, a hijacked DNS answer — can return a different APK, and the app has no
 * signal that it did. https is the only thing making "the file the operator
 * published" and "the file the rider installs" the same object.
 *
 * Applied when the value is written AND when it is served: the write-side check
 * only covers rows saved after this shipped, and a row predating it, or written
 * straight to PostgREST by an admin, would otherwise be served as-is.
 *
 * An empty string is a valid answer — it means "no link to offer", which is
 * what a fresh 0043 row holds. `updateAvailable` still travels, so an app can
 * say "an update exists, ask the office" rather than nothing at all.
 */
export function safeApkUrl(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).protocol === "https:" ? value.trim() : "";
  } catch {
    // Not an absolute URL, so not something a phone can download from.
    return "";
  }
}

/** The release track for one app, pulled out of the settings row. */
function trackFor(
  settings: PlatformSettings,
  app: ReleaseApp
): { latest: number; min: number; url: string; notes: string } {
  return app === "rider"
    ? {
        latest: settings.riderApkVersionCode,
        min: settings.riderApkMinVersionCode,
        url: settings.riderApkUrl,
        notes: settings.riderApkNotes,
      }
    : {
        latest: settings.customerApkVersionCode,
        min: settings.customerApkMinVersionCode,
        url: settings.customerApkUrl,
        notes: settings.customerApkNotes,
      };
}

/**
 * What to tell an app running `versionCode`.
 *
 * `min` is clamped to `latest` here as well as by the 0045 CHECK constraint and
 * by the admin form. The constraint only guards rows written after 0043 was
 * applied; this guards the answer itself, and the failure it prevents is the
 * worst one available — a minimum above the latest build force-updates every
 * installed app to a release that does not exist, and the APK URL points at the
 * one they already have. There is no way back from that without a new deploy.
 */
export function appVersionAnswer(
  settings: PlatformSettings,
  app: ReleaseApp,
  versionCode: number
): AppVersionAnswer {
  const track = trackFor(settings, app);
  const latest = Math.max(1, Math.trunc(track.latest));
  const min = Math.min(latest, Math.max(1, Math.trunc(track.min)));

  return {
    latestVersionCode: latest,
    minSupportedVersionCode: min,
    updateAvailable: versionCode < latest,
    forceUpdate: versionCode < min,
    apkUrl: safeApkUrl(track.url),
    releaseNotes: track.notes,
  };
}
