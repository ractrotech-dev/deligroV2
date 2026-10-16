/**
 * Razorpay Checkout — the browser half.
 *
 * Client-side and deliberately thin: it opens the provider's modal and hands
 * back what the provider said. It decides nothing about money. The ids and
 * signature it returns are unverified claims until
 * `/api/payments/razorpay/verify` has checked the HMAC server-side, and the
 * webhook is what finally settles the order.
 *
 * The SDK is loaded on demand rather than in the layout, so the ~90 KB only
 * costs the customers who actually pay online — and nothing at all while the
 * feature reads "Available soon". `script-src` in next.config.ts allows the
 * host; without that entry the CSP blocks this and the promise rejects.
 */

const SDK_SRC = "https://checkout.razorpay.com/v1/checkout.js";

export interface RazorpayHandoff {
  keyId: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  /** Shown in the modal header. */
  name: string;
  description?: string;
  prefill?: { name?: string; email?: string; contact?: string };
}

export interface RazorpayResult {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, handler: (payload: unknown) => void) => void;
}

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

/** Raised when the customer closes the modal without paying. Not an error. */
export class RazorpayDismissedError extends Error {
  constructor() {
    super("payment_dismissed");
    this.name = "RazorpayDismissedError";
  }
}

let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("razorpay_sdk_server_side"));
  }
  if (window.Razorpay) return Promise.resolve();
  // Cached so two taps don't append two script tags.
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SDK_SRC}"]`
    );
    const script = existing ?? document.createElement("script");

    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => {
        // Let the next attempt retry rather than caching the failure forever —
        // this fires on a flaky network as readily as on a CSP block.
        sdkPromise = null;
        reject(new Error("razorpay_sdk_unavailable"));
      },
      { once: true }
    );

    if (!existing) {
      script.src = SDK_SRC;
      script.async = true;
      document.body.appendChild(script);
    }
  });

  return sdkPromise;
}

/**
 * Open the checkout modal and resolve with what the customer's payment
 * produced. Rejects with RazorpayDismissedError if they closed it — the caller
 * treats that as "still unpaid", not as a failure to report.
 */
export async function openRazorpayCheckout(
  handoff: RazorpayHandoff
): Promise<RazorpayResult> {
  await loadSdk();

  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error("razorpay_sdk_unavailable");

  return new Promise<RazorpayResult>((resolve, reject) => {
    let settled = false;

    const instance = new Razorpay({
      key: handoff.keyId,
      amount: handoff.amountPaise,
      currency: handoff.currency,
      order_id: handoff.providerOrderId,
      name: handoff.name,
      description: handoff.description,
      prefill: handoff.prefill,
      theme: { color: "#ff5a1f" },
      handler: (response: {
        razorpay_order_id?: string;
        razorpay_payment_id?: string;
        razorpay_signature?: string;
      }) => {
        settled = true;
        if (
          !response?.razorpay_order_id ||
          !response.razorpay_payment_id ||
          !response.razorpay_signature
        ) {
          reject(new Error("razorpay_response_malformed"));
          return;
        }
        resolve({
          razorpayOrderId: response.razorpay_order_id,
          razorpayPaymentId: response.razorpay_payment_id,
          signature: response.razorpay_signature,
        });
      },
      modal: {
        ondismiss: () => {
          if (!settled) reject(new RazorpayDismissedError());
        },
      },
    } as Record<string, unknown>);

    instance.on("payment.failed", (payload: unknown) => {
      settled = true;
      const description = (
        payload as { error?: { description?: string } } | undefined
      )?.error?.description;
      reject(new Error(description || "payment_failed"));
    });

    instance.open();
  });
}
