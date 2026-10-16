"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { ObsIssueStatus, ObsSeverity } from "@/lib/obs/types";

/**
 * Every write the observability console can make.
 *
 * **Server Actions are public HTTP endpoints** (AGENTS.md rule 3), so every
 * exported function here begins with `requireRole("developer")` — including the ones
 * that look internal. There is no "called only from a gated page" exemption:
 * the gate protects the page, and this is not the page.
 *
 * Each of these then reaches for `createAdminClient()`, which bypasses RLS
 * entirely (rule 5), so the check above it is not decoration — it is the only
 * authorization in the path.
 *
 * Inputs are narrowed against closed vocabularies rather than passed through.
 * These land in columns with CHECK constraints, so an unlisted value would fail
 * at the database anyway — but failing here means the operator gets a page that
 * did nothing rather than a 500, and it keeps the vocabulary reviewable in one
 * place.
 */

const STATUSES = new Set<ObsIssueStatus>([
  "open",
  "investigating",
  "resolved",
  "ignored",
  "regressed",
]);

const SEVERITIES = new Set<ObsSeverity>(["critical", "high", "medium", "low", "info"]);

const INCIDENT_STATUSES = [
  "detected",
  "investigating",
  "identified",
  "mitigating",
  "resolved",
  "closed",
] as const;

async function adminClient() {
  await requireRole("developer");
  if (!isSupabaseConfigured) throw new Error("backend_not_configured");
  return createAdminClient();
}

/* ============================================================
   Issues
   ============================================================ */

export async function setIssueStatus(formData: FormData): Promise<void> {
  const supabase = await adminClient();

  const shortId = String(formData.get("shortId") ?? "");
  const status = String(formData.get("status") ?? "") as ObsIssueStatus;
  const note = String(formData.get("note") ?? "").trim();

  if (!shortId || !STATUSES.has(status)) return;

  const profile = await requireRole("developer");

  await supabase
    .from("obs_issues")
    .update({
      status,
      // Resolution provenance is only meaningful for a resolution. Stamping it
      // on every transition would make "resolved by" a lie the moment somebody
      // moved an issue back to investigating.
      resolved_at: status === "resolved" ? new Date().toISOString() : null,
      resolved_by: status === "resolved" ? profile.id : null,
      resolution_note: status === "resolved" && note ? note : null,
      updated_at: new Date().toISOString(),
    })
    .eq("short_id", shortId);

  revalidatePath(`/developer/observability/issues/${shortId}`);
  revalidatePath("/developer/observability/issues");
}

export async function setIssueSeverity(formData: FormData): Promise<void> {
  const supabase = await adminClient();

  const shortId = String(formData.get("shortId") ?? "");
  const severity = String(formData.get("severity") ?? "") as ObsSeverity;
  if (!shortId || !SEVERITIES.has(severity)) return;

  await supabase
    .from("obs_issues")
    .update({
      severity,
      // The latch. `obs_ingest` refuses to overwrite a manual severity, so this
      // one write takes the issue out of the auto-classifier's hands
      // permanently — which is the point. An operator who has looked at the
      // thing outranks a lookup table, and an issue that keeps demoting itself
      // after being escalated is one nobody will trust again.
      severity_source: "manual",
      updated_at: new Date().toISOString(),
    })
    .eq("short_id", shortId);

  revalidatePath(`/developer/observability/issues/${shortId}`);
}

/* ============================================================
   Incidents
   ============================================================ */

/**
 * Promote an issue to an incident.
 *
 * An issue is a bug; an incident is the work of handling one, and it is the
 * thing that survives — retention deletes issues at 180 days and never deletes
 * incidents. So this is also the gesture that says "keep this".
 */
export async function openIncident(formData: FormData): Promise<void> {
  const supabase = await adminClient();
  const profile = await requireRole("developer");

  const title = String(formData.get("title") ?? "").trim();
  const fromIssue = String(formData.get("fromIssue") ?? "").trim();
  const severityRaw = String(formData.get("severity") ?? "high") as ObsSeverity;
  const severity = SEVERITIES.has(severityRaw) ? severityRaw : "high";
  if (!title) return;

  // Short id from the count of existing incidents. Display-only — `id` is the
  // real key — so a gap or a repeat after a deletion costs nothing but a label,
  // and it avoids a second RPC on a path that runs a handful of times a month.
  const { count } = await supabase
    .from("obs_incidents")
    .select("id", { count: "exact", head: true });
  const shortId = `INC-${(count ?? 0) + 1}`;

  const { data, error } = await supabase
    .from("obs_incidents")
    .insert({
      short_id: shortId,
      title: title.slice(0, 300),
      severity,
      status: "detected",
      opened_by: profile.id,
      owner_id: profile.id,
    })
    .select("id, short_id")
    .single();

  if (error || !data) return;

  await supabase.from("obs_incident_notes").insert({
    incident_id: data.id,
    author_id: profile.id,
    kind: "status",
    body: `Incident opened${fromIssue ? ` from issue ${fromIssue}` : ""}.`,
  });

  if (fromIssue) {
    await supabase
      .from("obs_issues")
      .update({ incident_id: data.id, status: "investigating" })
      .eq("short_id", fromIssue);
  }

  redirect(`/developer/observability/incidents/${data.short_id}`);
}

export async function setIncidentStatus(formData: FormData): Promise<void> {
  const supabase = await adminClient();
  const profile = await requireRole("developer");

  const shortId = String(formData.get("shortId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!shortId || !INCIDENT_STATUSES.includes(status as never)) return;

  const now = new Date().toISOString();
  // Each stage stamps its own timestamp the first time it is entered. Written
  // as a patch rather than a full row so re-entering a stage (an incident that
  // reopens) cannot rewrite when it was first identified — the same reasoning
  // as the order lifecycle trigger in migration 0026.
  const patch: Record<string, unknown> = { status, updated_at: now };
  if (status === "identified") patch.identified_at = now;
  if (status === "mitigating") patch.mitigated_at = now;
  if (status === "resolved") patch.resolved_at = now;
  if (status === "closed") patch.closed_at = now;

  const { data } = await supabase
    .from("obs_incidents")
    .update(patch)
    .eq("short_id", shortId)
    .select("id")
    .maybeSingle();

  if (data) {
    await supabase.from("obs_incident_notes").insert({
      incident_id: data.id,
      author_id: profile.id,
      kind: "status",
      body: `Status changed to ${status}.`,
    });
  }

  revalidatePath(`/developer/observability/incidents/${shortId}`);
}

export async function addIncidentNote(formData: FormData): Promise<void> {
  const supabase = await adminClient();
  const profile = await requireRole("developer");

  const shortId = String(formData.get("shortId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!shortId || !body) return;

  const { data } = await supabase
    .from("obs_incidents")
    .select("id")
    .eq("short_id", shortId)
    .maybeSingle();
  if (!data) return;

  await supabase.from("obs_incident_notes").insert({
    incident_id: data.id,
    author_id: profile.id,
    kind: "note",
    // Notes are append-only and never edited. A timeline that can be rewritten
    // is not evidence, and this one exists to be read months later by somebody
    // who was not there.
    body: body.slice(0, 4000),
  });

  revalidatePath(`/developer/observability/incidents/${shortId}`);
}

/* ============================================================
   Alerts
   ============================================================ */

export async function setAlertEnabled(formData: FormData): Promise<void> {
  const supabase = await adminClient();

  const id = Number(formData.get("id"));
  const enabled = String(formData.get("enabled")) === "true";
  if (!Number.isSafeInteger(id)) return;

  await supabase
    .from("obs_alert_rules")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", id);

  revalidatePath("/developer/observability/alerts");
}

export async function setAlertThreshold(formData: FormData): Promise<void> {
  const supabase = await adminClient();

  const id = Number(formData.get("id"));
  const threshold = Number(formData.get("threshold"));
  const windowMin = Number(formData.get("windowMin"));
  const minSamples = Number(formData.get("minSamples"));

  if (!Number.isSafeInteger(id) || !Number.isFinite(threshold)) return;

  const patch: Record<string, unknown> = {
    threshold,
    updated_at: new Date().toISOString(),
  };
  // Clamped to the same bounds the CHECK constraints enforce, so a typo is
  // refused here with a no-op rather than at the database with a 500.
  if (Number.isSafeInteger(windowMin) && windowMin >= 1 && windowMin <= 1440) {
    patch.window_min = windowMin;
  }
  if (Number.isSafeInteger(minSamples) && minSamples >= 1) {
    patch.min_samples = minSamples;
  }

  await supabase.from("obs_alert_rules").update(patch).eq("id", id);
  revalidatePath("/developer/observability/alerts");
}

export async function acknowledgeFiring(formData: FormData): Promise<void> {
  const supabase = await adminClient();
  const profile = await requireRole("developer");

  const id = Number(formData.get("id"));
  if (!Number.isSafeInteger(id)) return;

  await supabase
    .from("obs_alert_firings")
    .update({
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: profile.id,
    })
    .eq("id", id);

  revalidatePath("/developer/observability/alerts");
  revalidatePath("/developer/observability");
}
