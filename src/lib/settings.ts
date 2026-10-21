import "server-only";
import { cache } from "react";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";
import {
  SettingsNotMigratedError,
  SettingsUnavailableError,
  getSettingsFromDb,
  riderRateCardAvailable,
  settingsTableExists,
} from "@/lib/data-access/settings";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { PlatformSettings } from "@/types";

/**
 * Server facade for platform settings. Live Supabase row when configured and
 * migrated, otherwise the shared defaults — so the app behaves identically
 * before the Settings tab is ever opened. Mirrors `catalog.ts` / `banners.ts`.
 *
 * `cache()` dedupes the read within a single request: the fee, the availability
 * gate, and the support footer can each call `getSettings()` and hit the DB once.
 */

/**
 * Where the settings in hand came from.
 *
 * - `live`        — read from `platform_settings`.
 * - `defaults`    — nothing to read: demo mode, or migration 0015 not applied.
 *   The defaults are the configuration, and the platform runs normally.
 * - `unavailable` — the row exists and we could not read it. We do not know
 *   what the admin configured, so ordering is off.
 */
type SettingsSource = "live" | "defaults" | "unavailable";

export interface SettingsSnapshot {
  settings: PlatformSettings;
  source: SettingsSource;
}

/**
 * Shown to customers while the settings row is unreadable. Deliberately says
 * "paused", not "error": it is the accurate description of what is happening to
 * them, and the cause is ours to fix, not theirs to understand.
 */
const SETTINGS_OUTAGE_MESSAGE =
  "We can't confirm today's prices and availability right now, so ordering is paused. Please try again in a few minutes.";

/**
 * What we serve when the settings read fails on a configured backend.
 *
 * `acceptingOrders: false` is the whole point. The previous behaviour returned
 * DEFAULT_SETTINGS, which sets it to `true` — so during a Supabase incident or
 * an RLS regression on `platform_settings` the platform kept taking orders at
 * the default fee and the default tax rate, ignored the configured minimum, and
 * silently overrode an active maintenance pause. An operator who had stopped the
 * platform watched orders keep landing with nothing anywhere to say why.
 *
 * AGENTS.md §2: a failed config read must reduce what is possible, never widen
 * it. The fee and tax carried here are the defaults because something has to
 * render — but nothing can be ordered at them, so they cannot misprice anything.
 */
function outageSettings(): PlatformSettings {
  return {
    ...DEFAULT_SETTINGS,
    acceptingOrders: false,
    maintenanceMessage: SETTINGS_OUTAGE_MESSAGE,
  };
}

/**
 * Settings plus the provenance of the answer, for callers that need to tell
 * "configured this way" from "we could not find out" — the admin Settings
 * screen, and anything that would otherwise report an outage as a policy.
 */
export const getSettingsSnapshot = cache(
  async (): Promise<SettingsSnapshot> => {
    if (!isSupabaseConfigured) {
      return { settings: DEFAULT_SETTINGS, source: "defaults" };
    }

    try {
      return { settings: await getSettingsFromDb(), source: "live" };
    } catch (err) {
      // Not migrated yet → defaults, so nothing breaks during rollout. This is
      // a known state, not a failure: there is nothing configured to lose.
      if (err instanceof SettingsNotMigratedError) {
        return { settings: DEFAULT_SETTINGS, source: "defaults" };
      }

      // Everything else is an outage. Logged rather than swallowed: the old
      // code produced no signal at all, so the first evidence of a settings
      // failure was a customer being charged the wrong fee.
      console.error(
        "[settings] platform_settings unreadable — ordering paused",
        err instanceof SettingsUnavailableError ? err.cause : err
      );
      return { settings: outageSettings(), source: "unavailable" };
    }
  }
);

export async function getSettings(): Promise<PlatformSettings> {
  return (await getSettingsSnapshot()).settings;
}

/** Is the settings backend live and migrated? Drives the Admin notice. */
export async function settingsBackendReady(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  try {
    return await settingsTableExists();
  } catch {
    return false;
  }
}

/**
 * Can the rider rate card be saved here? False when migration 0083 has not
 * added its four columns, so the form can say so instead of accepting numbers
 * that go nowhere. Demo mode and any read failure answer true: neither is
 * evidence that the columns are missing.
 */
export async function riderRateCardReady(): Promise<boolean> {
  if (!isSupabaseConfigured) return true;
  try {
    return await riderRateCardAvailable();
  } catch {
    return true;
  }
}
