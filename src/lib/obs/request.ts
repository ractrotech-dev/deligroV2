import "server-only";
import { headers } from "next/headers";
import {
  newRequestId,
  newTraceId,
  parseCorrelationId,
} from "./ids";
import { OBS_REQUEST_ID_HEADER, OBS_TRACE_ID_HEADER } from "./types";

/**
 * Turning a route handler into something that reports on itself.
 *
 * `instrumentation.ts` already catches every throw. What it cannot see is the
 * successful-but-slow request, the deliberate 4xx, the 503 a route returns
 * rather than throws — and this app returns a great many of those on purpose
 * (`backend_not_configured`, `online_payments_unavailable`, `rate_limited`).
 * Those are the rows the API and Performance pages are built from, and none of
 * them is an exception.
 *
 * So: `onRequestError` records what broke, this records what happened.
 */

/**
 * The correlation ids for the request being served.
 *
 * `proxy.ts` mints these and sets them on the request headers, so every handler
 * in one request agrees on them without threading anything through. When the
 * proxy did not run — a route it excludes, a direct invocation in a test — new
 * ids are minted here rather than left null: a request with no id cannot be
 * correlated with anything, which is the one outcome worth avoiding.
 */
export async function obsRequestContext(): Promise<{
  requestId: string;
  traceId: string;
}> {
  try {
    const h = await headers();
    return {
      requestId:
        parseCorrelationId(h.get(OBS_REQUEST_ID_HEADER), "req") ?? newRequestId(),
      traceId:
        parseCorrelationId(h.get(OBS_TRACE_ID_HEADER), "trace") ?? newTraceId(),
    };
  } catch {
    // Called outside a request scope.
    return { requestId: newRequestId(), traceId: newTraceId() };
  }
}

