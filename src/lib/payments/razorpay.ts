import "server-only";
import {
  verifyCheckoutSignature as verifyCheckoutSignatureWith,
  verifyWebhookSignature as verifyWebhookSignatureWith,
} from "@/lib/payments/signatures";

import { razorpayFetch } from "@/lib/payments/razorpay-fetch";

export { toPaise } from "@/lib/payments/signatures";

/**
 * Razorpay — server-side gateway client.
 *
 * Credentials come from the environment (see .env.example):
 *
 *   NEXT_PUBLIC_RAZORPAY_KEY_ID  — public key id, ships to the browser checkout
 *   RAZORPAY_KEY_ID              — same value, server-side name
 *   RAZORPAY_KEY_SECRET          — SECRET. Signs and authenticates. Server only.
 *   RAZORPAY_WEBHOOK_SECRET      — SECRET. Dashboard → Webhooks. Server only.
 *
 * No SDK: the two calls we make are plain REST, and a dependency that ships its
 * own HTTP stack is a bigger surface than the twenty lines it saves.
 *
 * Everything here fails closed. `isRazorpayConfigured` is false without keys,
 * and the callers treat that as "online payment is not on offer" — never as
 * "let it through unverified". A verification function with a missing secret
 * returns false; it does not skip the check.
 */

const KEY_ID =
  process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

const API = "https://api.razorpay.com/v1";

/** Can we talk to Razorpay at all? Both halves of the key pair are required. */
export const isRazorpayConfigured = KEY_ID.length > 0 && KEY_SECRET.length > 0;

/**
 * Is the webhook endpoint usable? Tracked separately from the key pair: an
 * install can take payments before the webhook is registered, but the endpoint
 * must refuse traffic until its secret exists rather than trust the body.
 */
export const isRazorpayWebhookConfigured = WEBHOOK_SECRET.length > 0;

/** The public key id, for the browser checkout. Empty when unconfigured. */
export function razorpayPublicKeyId(): string {
  return KEY_ID;
}

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "RazorpayError";
  }
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string;
}

function authHeader(): string {
  const credentials = `${KEY_ID}:${KEY_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/**
 * Create a Razorpay order — the object the browser checkout is opened against.
 *
 * `amountPaise` is the smallest currency unit, which is what Razorpay bills in.
 * The caller derives it from the order total the database computed, never from
 * anything the client sent.
 */
export async function createRazorpayOrder(input: {
  amountPaise: number;
  currency?: string;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  if (!isRazorpayConfigured) {
    throw new RazorpayError("razorpay_not_configured", 503);
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new RazorpayError("invalid_amount", 400);
  }

  const res = await razorpayFetch("orders.create", `${API}/orders`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: input.currency ?? "INR",
      receipt: input.receipt,
      notes: input.notes,
      // Auto-capture. Without it a payment sits authorized and has to be
      // captured by a second call, which is a settlement mode nobody here asked
      // for and a reliable way to lose money to expiry.
      payment_capture: 1,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    // Razorpay's error body carries the customer-safe reason, but it is not
    // ours to forward verbatim — log-shaped message, generic status upstream.
    throw new RazorpayError(`razorpay_order_failed_${res.status}`, 502);
  }

  const order = (await res.json()) as RazorpayOrder;
  if (!order?.id) throw new RazorpayError("razorpay_order_malformed", 502);
  return order;
}

/**
 * Verify the browser checkout's success callback against this environment's key
 * secret. The arithmetic — and the reasoning about what a valid signature does
 * and does not prove — lives in `signatures.ts`, which is what
 * `npm run test:payments` exercises.
 */
export function verifyCheckoutSignature(input: {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}): boolean {
  return verifyCheckoutSignatureWith(KEY_SECRET, input);
}

/** Verify a webhook delivery against this environment's webhook secret. */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null
): boolean {
  return verifyWebhookSignatureWith(WEBHOOK_SECRET, rawBody, signature);
}
