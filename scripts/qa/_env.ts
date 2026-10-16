/**
 * Shared env loader for QA scripts. Reads `.env.local` without overwriting
 * vars already set in the process environment.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const g = globalThis as { WebSocket?: unknown };
if (typeof g.WebSocket === "undefined") {
  g.WebSocket = createRequire(import.meta.url)("ws");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv(): void {
  try {
    const raw = readFileSync(join(root, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // optional when vars are already exported
  }
}

loadEnv();

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  "";
export const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SECRET_KEY ??
  "";

/** App under test — local default matches `npm run dev` / `npm start`. */
export const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3003").replace(
  /\/$/,
  ""
);

/**
 * Password for QA + seeded demo accounts. Required (12+) — never committed.
 *   QA_PASSWORD='…' npm run test:idor
 */
export const QA_PASSWORD =
  process.env.QA_PASSWORD ?? process.env.SEED_PASSWORD ?? "";

export function requireSupabase(): void {
  if (!SUPABASE_URL.startsWith("http") || SUPABASE_ANON_KEY.length < 20) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / publishable (anon) key in .env.local"
    );
    process.exit(1);
  }
  if (SUPABASE_SERVICE_ROLE_KEY.length < 20) {
    console.error(
      "Missing SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY in .env.local"
    );
    process.exit(1);
  }
  if (QA_PASSWORD.length < 12) {
    console.error(
      "Set QA_PASSWORD or SEED_PASSWORD (12+ chars) for QA accounts.\n" +
        "  Generate one with `openssl rand -base64 18`, export it as QA_PASSWORD, then npm run test:idor"
    );
    process.exit(1);
  }
}
