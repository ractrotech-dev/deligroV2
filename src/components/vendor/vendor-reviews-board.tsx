"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { VendorEmptyState, VendorPanel } from "@/components/vendor/vendor-ui";
import { cn } from "@/lib/utils/cn";
import { saveReviewReplyAction, type ReplyResult } from "@/app/vendor/reviews/actions";
import { REPLY_MAX, type VendorReview } from "@/lib/vendor/vendor-reviews";

const REPLY_ERRORS: Record<Extract<ReplyResult, { ok: false }>["error"], string> = {
  forbidden: "You can't reply to this review.",
  invalid: "Something went wrong. Reload and try again.",
  empty: "Write a reply first.",
  too_long: `Keep it under ${REPLY_MAX} characters.`,
  rate_limited: "Too many replies. Wait a minute and try again.",
  not_found: "This review is no longer available.",
  server_error: "Could not save your reply. Try again.",
  feature_disabled: "Reviews are turned off for your shop by Deligro admin.",
};

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn("size-3.5", n <= value ? "fill-amber-400 text-amber-400" : "text-line")}
          strokeWidth={1.8}
        />
      ))}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function ReplyEditor({ review }: { review: VendorReview }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(review.reply?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveReviewReplyAction(review.id, text);
      if (!result.ok) {
        setError(REPLY_ERRORS[result.error]);
        return;
      }
      setOpen(false);
      // Clears the router's reusable copy of this page as well as re-reading it.
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div className="mt-3">
        {review.reply ? (
          <div className="rounded-lg bg-surface-2 p-3">
            <p className="text-[11.5px] font-bold uppercase tracking-wide text-muted">
              Your reply{review.reply.edited ? " (edited)" : ""} · {formatDate(review.reply.createdAt)}
            </p>
            <p className="mt-1 whitespace-pre-line text-[13px] text-ink">{review.reply.text}</p>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="press mt-2 rounded-full border border-line px-3 py-1.5 text-[12.5px] font-bold"
        >
          {review.reply ? "Edit reply" : "Reply"}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <label className="sr-only" htmlFor={`reply-${review.id}`}>
        Reply to this review
      </label>
      <textarea
        id={`reply-${review.id}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={REPLY_MAX}
        rows={3}
        placeholder="Thank the customer or say what you will do better. Everyone can read this."
        className="w-full rounded-lg border border-line bg-surface p-2.5 text-[13px]"
      />
      <div className="mt-1 flex items-center justify-between text-[11.5px] text-muted">
        <span>
          {text.length}/{REPLY_MAX}
        </span>
        {error ? (
          <span role="alert" className="font-semibold text-red">
            {error}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="press rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-60"
        >
          {pending ? "Saving…" : "Post reply"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setText(review.reply?.text ?? "");
            setError(null);
          }}
          disabled={pending}
          className="press rounded-full border border-line px-4 py-1.5 text-[12.5px] font-bold"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function VendorReviewsBoard({
  average,
  count,
  reviews,
  hasMore,
}: {
  average: number | null;
  count: number;
  reviews: VendorReview[];
  hasMore: boolean;
}) {
  return (
    <div className="space-y-4">
      <VendorPanel title="Your rating">
        {average === null ? (
          <p className="text-[13px] text-muted">
            No ratings yet. They appear here after customers rate a delivered order.
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-[28px] font-extrabold leading-none">{average.toFixed(1)}</span>
            <div>
              <Stars value={Math.round(average)} />
              <p className="mt-0.5 text-[12px] text-muted">
                from {count} {count === 1 ? "rating" : "ratings"}
              </p>
            </div>
          </div>
        )}
      </VendorPanel>

      {reviews.length === 0 ? (
        <VendorEmptyState
          title="No reviews yet"
          description="Customers can rate an order once it is delivered. Their ratings and comments will show up here."
        />
      ) : (
        <ul className="space-y-3">
          {reviews.map((review) => (
            <li key={review.id} className="rounded-xl border border-line bg-surface p-3.5">
              <div className="flex items-center justify-between gap-2">
                <Stars value={review.rating} />
                <span className="text-[11.5px] text-muted">
                  {formatDate(review.createdAt)} · Order #{review.orderCode}
                </span>
              </div>
              {review.comment ? (
                <p className="mt-2 whitespace-pre-line text-[13.5px] text-ink">
                  {review.comment}
                  {review.edited ? <span className="text-muted"> (edited)</span> : null}
                </p>
              ) : (
                <p className="mt-2 text-[13px] text-muted">No comment.</p>
              )}
              {review.details.length > 0 ? (
                <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
                  {review.details.map((d) => (
                    <span key={d.label}>
                      {d.label} {d.value}/5
                    </span>
                  ))}
                </p>
              ) : null}
              <ReplyEditor review={review} />
            </li>
          ))}
        </ul>
      )}

      {hasMore ? (
        <p className="text-center text-[12px] text-muted">Showing the latest reviews.</p>
      ) : null}
    </div>
  );
}
