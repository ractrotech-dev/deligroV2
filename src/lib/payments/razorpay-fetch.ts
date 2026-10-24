import "server-only";
import { recordProvider } from "@/lib/obs/emit";

/**
 * `fetch` to Razorpay that records the outcome (OBSERVABILITY_V2.md, phase 2):
 * how long it took, and whether it worked. A failure (a non-2xx answer or no
 * answer at all) becomes a provider event that the Payments page counts; the
 * caller's own handling is unchanged, and a network failure is re-thrown as it
 * always was.
 */
export async function razorpayFetch(operation: string, url: string, init: RequestInit): Promise<Response> {
  const started = Date.now();
  try {
    const res = await fetch(url, init);
    try {
      recordProvider("razorpay", operation, {
        ok: res.ok,
        durationMs: Date.now() - started,
        status: res.status,
        detail: res.ok ? undefined : res.statusText || `status ${res.status}`,
      });
    } catch {
      /* recording must never change the payment */
    }
    return res;
  } catch (err) {
    try {
      recordProvider("razorpay", operation, {
        ok: false,
        durationMs: Date.now() - started,
        detail: err instanceof Error ? err.name : "network_error",
      });
    } catch {
      /* likewise */
    }
    throw err;
  }
}
