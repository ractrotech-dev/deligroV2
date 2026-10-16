import type { HealthRow } from "@/lib/obs/metrics";

/**
 * The Developer overview's own checks: what is deployed and how it is
 * configured. Pure, so they can be tested without a server.
 *
 * Two rules carry over from the observability health panel. A check that cannot
 * be answered is `unknown`, never `ok`: failing open on a health check is the
 * same mistake as failing open on an auth check. And a service nobody configured
 * is `off`, not `down`: colouring an unused integration red trains whoever is
 * reading to ignore red.
 *
 * Nothing here returns a secret. Configuration is reported as variable NAMES
 * that are set or missing, and never a value, a prefix or a length.
 */

/** Keep in step with `.nvmrc`; `scripts/qa/developer-health.ts` fails if they drift. */
export const EXPECTED_NODE_MAJOR = 24;

type Env = Record<string, string | undefined>;

const has = (env: Env, name: string): boolean => (env[name] ?? "").trim() !== "";

export function nodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version);
  return m ? Number(m[1]) : null;
}

/** What is running: the release, where it runs, and on which Node. */
export function deploymentRows(
  env: Env,
  nodeVersion: string,
  expectedMajor: number = EXPECTED_NODE_MAJOR
): HealthRow[] {
  const rows: HealthRow[] = [];

  const sha = (env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  const ref = (env.VERCEL_GIT_COMMIT_REF ?? "").trim();
  const vercelEnv = (env.VERCEL_ENV ?? "").trim();
  if (!sha) {
    rows.push({
      label: "Release",
      state: "unknown",
      detail: "Not running on Vercel, or no commit is exposed to the build",
      note: "Cannot say which commit is live, so it is not reported as healthy",
    });
  } else {
    const where = [sha.slice(0, 7), ref, vercelEnv].filter(Boolean).join(" · ");
    rows.push(
      vercelEnv === "production"
        ? { label: "Release", state: "ok", detail: where }
        : {
            label: "Release",
            state: "degraded",
            detail: where,
            note: "This is not the production environment",
          }
    );
  }

  const region = (env.VERCEL_REGION ?? "").trim();
  rows.push(
    region
      ? {
          label: "Function region",
          state: "unknown",
          detail: region,
          note: "Compare with the Supabase project's region: a mismatch costs a network round trip on every database call",
        }
      : {
          label: "Function region",
          state: "unknown",
          detail: "Not exposed here",
        }
  );

  const major = nodeMajor(nodeVersion);
  if (major === null) {
    rows.push({ label: "Node.js", state: "unknown", detail: `Cannot read "${nodeVersion}"` });
  } else if (major === expectedMajor) {
    rows.push({ label: "Node.js", state: "ok", detail: `${nodeVersion} (matches .nvmrc ${expectedMajor})` });
  } else {
    rows.push({
      label: "Node.js",
      state: "degraded",
      detail: `${nodeVersion}, but .nvmrc and the deploy checklist say ${expectedMajor}`,
      note: "Set the project's Node version to match",
    });
  }

  return rows;
}

interface Group {
  label: string;
  /** Every name here must be set for the group to be healthy. */
  all?: string[];
  /** Each entry is a set of names where any one satisfies it (a renamed key). */
  anyOf?: string[][];
  /** Missing means the area is off, not that something is broken. */
  optional?: boolean;
}

const GROUPS: Group[] = [
  {
    label: "Core: database, sign-in, SMS",
    anyOf: [
      ["NEXT_PUBLIC_SUPABASE_URL"],
      ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
      ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
      ["OTP_PEPPER"],
      ["RENFLAIR_API_KEY"],
    ],
  },
  {
    label: "Payments (Razorpay)",
    all: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "NEXT_PUBLIC_RAZORPAY_KEY_ID"],
    optional: true,
  },
  {
    label: "Push (OneSignal)",
    all: ["ONESIGNAL_APP_ID", "ONESIGNAL_REST_API_KEY", "NEXT_PUBLIC_ONESIGNAL_APP_ID"],
    optional: true,
  },
  {
    label: "Maps and address search",
    all: ["NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"],
    optional: true,
  },
];

/** Variables that must NOT exist in production (see docs/DEPLOYMENT_AUDIT.md). */
const MUST_BE_ABSENT = ["MFA_EXEMPT_EMAILS"];

/** One group's row: all set, deliberately off, or missing something it needs. */
function groupRow(env: Env, g: Group): HealthRow {
  const missing: string[] = [];
  let total = 0;
  for (const name of g.all ?? []) {
    total++;
    if (!has(env, name)) missing.push(name);
  }
  for (const alternatives of g.anyOf ?? []) {
    total++;
    if (!alternatives.some((n) => has(env, n))) missing.push(alternatives.join(" or "));
  }

  if (missing.length === 0) {
    return { label: g.label, state: "ok", detail: `All ${total} set` };
  }
  if (g.optional && missing.length === total) {
    return { label: g.label, state: "off", detail: "Not configured" };
  }
  return {
    label: g.label,
    state: "down",
    detail: `Missing: ${missing.join(", ")}`,
    note: g.optional
      ? "Partly configured, which usually means a feature will fail at runtime"
      : "The app refuses to run, or a required step fails, without this",
  };
}

/** Which configuration is present. Names only, never values. */
export function configRows(env: Env): HealthRow[] {
  const rows: HealthRow[] = GROUPS.map((g) => groupRow(env, g));

  const present = MUST_BE_ABSENT.filter((n) => has(env, n));
  rows.push(
    present.length === 0
      ? { label: "Retired settings", state: "ok", detail: "None present" }
      : {
          label: "Retired settings",
          state: "degraded",
          detail: `Still set: ${present.join(", ")}`,
          note: "Dead settings are mistaken for live controls. Delete them",
        }
  );

  return rows;
}

/** A database round trip as a state: fast, slow, or failing. */
export function classifyDatabaseLatency(ms: number | null, failed: boolean): HealthRow {
  if (failed || ms === null) {
    return { label: "Database round trip", state: "down", detail: "The probe query failed" };
  }
  const shown = `${Math.round(ms)} ms`;
  if (ms < 400) return { label: "Database round trip", state: "ok", detail: shown };
  return {
    label: "Database round trip",
    state: "degraded",
    detail: shown,
    note: "Slow for one small query. Usually distance between the app and the database, or a busy database",
  };
}

export interface ScoreSummary {
  pass: number;
  investigate: number;
  notConfigured: number;
  unknown: number;
}

/** The scorecard headline: how many checks sit in each bucket. */
export function summarize(rows: readonly HealthRow[]): ScoreSummary {
  const out: ScoreSummary = { pass: 0, investigate: 0, notConfigured: 0, unknown: 0 };
  for (const r of rows) {
    if (r.state === "ok") out.pass++;
    else if (r.state === "degraded" || r.state === "down") out.investigate++;
    else if (r.state === "off") out.notConfigured++;
    else out.unknown++;
  }
  return out;
}
