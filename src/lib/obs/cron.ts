import "server-only";
import { captureError, emit } from "./emit";
import { currentEnv } from "./ids";

/**
 * Background jobs (OBSERVABILITY_V2.md, phase 2). Every `/api/cron/*` route is
 * exported through this wrapper:
 *
 *   export const GET = withCronObservability("dispatch-sweep", handler);
 *
 * A throw, or an answer of 500 or more, becomes an issue named after the job
 * (grouped on `cron:<job>`, so it stays one issue from one deploy to the next).
 * A throw is re-thrown after it is recorded, so nothing else about the route
 * changes. `scripts/qa/obs-cron-coverage.ts` fails if a cron route is not
 * wrapped.
 */
/** Set by a route that recorded its own failure, so the wrapper does not record it again. */
export const OBS_RECORDED_HEADER = "x-obs-recorded";

export function withCronObservability<Args extends unknown[]>(
  job: string,
  handler: (req: Request, ...rest: Args) => Promise<Response>,
): (req: Request, ...rest: Args) => Promise<Response> {
  return async (req: Request, ...rest: Args) => {
    let res: Response;
    try {
      res = await handler(req, ...rest);
    } catch (err) {
      try {
        captureError(err, { source: `cron:${job}`, attrs: { job } });
      } catch {
        /* recording must never change what the job does */
      }
      throw err;
    }
    try {
      // 503 is "not set up yet / migration pending", which the route says on
      // purpose. A route that already recorded its own failure says so with
      // x-obs-recorded, so the job is not counted twice.
      if (res.status >= 500 && res.status !== 503 && !res.headers.get(OBS_RECORDED_HEADER)) {
        recordJobProblem(job, `answered ${res.status}`);
      }
    } catch {
      /* likewise */
    }
    return res;
  };
}

/** A job that answered 200 but failed inside, in its own words. */
export function recordJobProblem(job: string, message: string): void {
  emit({
    env: currentEnv(),
    kind: "error",
    level: "error",
    source: `cron:${job}`,
    message: `Background job ${job}: ${message}`,
    errorType: "JobFailed",
    culprit: `cron:${job}`,
    attrs: { job },
  });
}
