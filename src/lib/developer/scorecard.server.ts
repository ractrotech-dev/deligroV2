import "server-only";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getSystemHealth, type HealthRow } from "@/lib/obs/metrics";
import {
  classifyDatabaseLatency,
  configRows,
  deploymentRows,
  summarize,
  type ScoreSummary,
} from "@/lib/developer/health-checks";

interface ScoreGroup {
  title: string;
  subtitle: string;
  rows: HealthRow[];
}

export interface Scorecard {
  groups: ScoreGroup[];
  summary: ScoreSummary;
  /** ISO time the checks ran: every figure on the page is as of this moment. */
  checkedAt: string;
}

/** One small query, timed. A real round trip, not a figure read from telemetry. */
async function probeDatabase(): Promise<HealthRow> {
  if (!isSupabaseConfigured) {
    return {
      label: "Database round trip",
      state: "off",
      detail: "Supabase is not configured",
    };
  }
  const started = performance.now();
  try {
    const { error } = await createAdminClient()
      .from("platform_settings")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    return classifyDatabaseLatency(performance.now() - started, Boolean(error));
  } catch {
    return classifyDatabaseLatency(null, true);
  }
}

/**
 * Everything the Developer overview scores, run now.
 *
 * Reads only: environment variable names (never values), the Vercel build
 * facts, one timed query, and the observability health panel's own checks. It
 * calls no provider, so opening this page spends no money and sends nothing.
 */
export async function getScorecard(): Promise<Scorecard> {
  await requireRole("developer");

  const [system, database] = await Promise.all([
    getSystemHealth().catch(() => null),
    probeDatabase(),
  ]);

  const deployment = deploymentRows(process.env, process.version);
  const configuration = configRows(process.env);

  const groups: ScoreGroup[] = [
    {
      title: "Deployment",
      subtitle: "What is live and where it runs.",
      rows: deployment,
    },
    {
      title: "Configuration",
      subtitle: "Which settings are present. Names only, never values.",
      rows: configuration,
    },
    {
      title: "Database and monitoring",
      subtitle: "Observed now, and from the last hour of telemetry.",
      rows: [
        database,
        ...(system?.rows ?? [
          {
            label: "Monitoring pipeline",
            state: "unknown" as const,
            detail: "The health check could not run",
          },
        ]),
      ],
    },
  ];

  return {
    groups,
    summary: summarize(groups.flatMap((g) => g.rows)),
    checkedAt: new Date().toISOString(),
  };
}
