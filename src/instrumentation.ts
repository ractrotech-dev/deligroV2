import type { Instrumentation } from "next";

/**
 * The framework's own hooks into this app's lifecycle.
 *
 * Next calls `register()` once per server instance before it serves anything,
 * and `onRequestError` whenever it catches a throw — from a Server Component,
 * a Route Handler, a Server Action or the proxy. That last one is the important
 * one: it is the only place that sees ALL of those without every one of them
 * being wrapped by hand, and it is handed `routePath` and `routeType` by the
 * framework, which is better attribution than anything we could reconstruct.
 *
 * Verified against `node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/instrumentation.md` — `onRequestError` is stable from
 * Next 15 and this project is on 16.3.0.
 *
 * Imports are dynamic throughout. This file is loaded in both the Node and the
 * Edge runtime, and `lib/obs/emit.ts` pulls in the Supabase admin client and
 * `server-only`; importing that at module scope would evaluate it in every
 * runtime on every boot, including ones that will never write an event.
 */

/**
 * Runs once per server instance, before the first request.
 *
 * Its whole job is the deploy marker. Without one, "errors started at 10:42"
 * has nothing to sit next to and the release-correlation panel is blank —
 * which, on a platform with no CI and no deploy log, means there is no record
 * anywhere of when a version went out.
 *
 * The insert is an upsert on (release, env), so the second and third instances
 * to cold-start on the same release do not each write a row and turn one deploy
 * into a cluster of markers.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { currentEnv, currentRelease } = await import("@/lib/obs/ids");
    const release = currentRelease();
    if (!release) return; // Local dev: no SHA, so no deploy to mark.

    const { isSupabaseConfigured, SUPABASE_SERVICE_ROLE_KEY } = await import(
      "@/lib/supabase/config"
    );
    if (!isSupabaseConfigured || !SUPABASE_SERVICE_ROLE_KEY) return;

    const { createAdminClient } = await import("@/lib/supabase/admin");
    await createAdminClient()
      .from("obs_deploys")
      .upsert(
        {
          release,
          env: currentEnv(),
          commit_message:
            process.env.VERCEL_GIT_COMMIT_MESSAGE?.slice(0, 500) ?? null,
          branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        },
        { onConflict: "release,env", ignoreDuplicates: true }
      );
  } catch {
    // A missing deploy marker costs one panel. Failing the boot over it would
    // cost the whole platform — never fail the app for the sake of the thing
    // watching it.
  }
}

/**
 * Every server-side throw Next catches.
 *
 * Deliberately not a place for judgement: it records what happened and lets the
 * classifier and the issue grouping decide what it means. The one thing it does
 * decide is what NOT to record — see the digest note below.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context
) => {
  try {
    const { captureError } = await import("@/lib/obs/emit");
    const { parseCorrelationId, templateRoute } = await import("@/lib/obs/ids");
    const { redactUrl } = await import("@/lib/obs/redact");
    const { actorIdFromCookieHeader } = await import("@/lib/obs/session-label");

    // Next replaces a Server Component's error message with a generic string
    // before it reaches the browser and hands the real one here, along with a
    // `digest`. That digest is what `admin/error.tsx` already prints as
    // "Reference:" — recording it is what finally makes that screen's promise
    // true, because it is the only shared key between what the operator is
    // looking at and what actually threw.
    const digest =
      typeof err === "object" && err !== null && "digest" in err
        ? String((err as { digest?: unknown }).digest)
        : undefined;

    const headers = request.headers as Record<string, string | undefined>;

    captureError(err, {
      // `routePath` is the templated route the framework resolved, which beats
      // re-deriving it from the concrete path. `templateRoute` is the fallback
      // for the cases where Next has no route to name (a proxy throw).
      source: context.routePath || templateRoute(redactUrl(request.path)),
      httpMethod: request.method,
      httpRoute: context.routePath || templateRoute(redactUrl(request.path)),
      // No status: the throw is what we saw. Whatever status Next chose to send
      // afterwards is a separate fact, and guessing 500 here would make a
      // handled `notFound()` look like a server fault.
      traceId: parseCorrelationId(headers["x-trace-id"], "trace"),
      requestId: parseCorrelationId(headers["x-request-id"], "req"),
      // Who it hit, from the session cookie, unverified: a label for counting
      // people per issue, never a permission (see session-label.ts).
      actorId: actorIdFromCookieHeader(headers["cookie"]),
      attrs: {
        // `routeType` distinguishes a Server Action failing from a page failing
        // — the same exception in the two places is a different bug with a
        // different blast radius, and grouping them together would hide one
        // inside the other.
        event: context.routeType,
        digest,
        reason: context.revalidateReason ?? undefined,
      },
    });
  } catch {
    // If the error reporter throws, the request has already failed. Adding a
    // second failure on top helps nobody.
  }
};
