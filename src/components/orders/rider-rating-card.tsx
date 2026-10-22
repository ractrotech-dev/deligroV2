"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { useLang } from "@/components/providers/lang-provider";
import { MAX_RATING_COMMENT } from "@/lib/rider/rating";
import { cn } from "@/lib/utils/cn";

/** The name the tracker shows when the rider's profile could not be read. */
const FALLBACK_NAME = "Your courier";

/** "Ravi Kumar" -> "Ravi"; null when we have no real name to use. */
function firstName(name: string | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === FALLBACK_NAME) return null;
  return trimmed.split(/\s+/)[0];
}

interface Given {
  rating: number;
  comment: string | null;
}

/**
 * "Rate <rider>" - 1 to 5 stars and an optional comment for the rider who
 * delivered this order, next to the restaurant review.
 *
 * Posts to `POST /api/orders/:id/rider-rating`; the rider and the customer are
 * the server's to name, so the body is only the stars and the words. One rating
 * per order: when there already is one (an earlier visit, another device) the
 * card shows what was given instead of a form. The rider never sees who rated
 * them - the copy says so, because it is the reason to be honest.
 */
export function RiderRatingCard({
  orderId,
  riderName,
}: Readonly<{ orderId: string; riderName?: string }>) {
  const { t } = useLang();
  const first = firstName(riderName);
  const who = first ?? t("your rider", "अपने राइडर");

  const [loaded, setLoaded] = useState(false);
  const [given, setGiven] = useState<Given | null>(null);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readGiven(): Promise<Given | null> {
    try {
      const res = await fetch(`/api/orders/${orderId}/rider-rating`, { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { rating?: unknown; comment?: unknown };
      return typeof data.rating === "number"
        ? { rating: data.rating, comment: typeof data.comment === "string" ? data.comment : null }
        : null;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    let live = true;
    void readGiven().then((g) => {
      if (!live) return;
      setGiven(g);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readGiven only closes over orderId
  }, [orderId]);

  function explain(code: string | undefined, status: number): string {
    switch (code) {
      case "invalid_rating":
        return t("Pick between 1 and 5 stars.", "1 से 5 के बीच स्टार चुनें।");
      case "comment_too_long":
        return t(
          `Keep it under ${MAX_RATING_COMMENT} characters.`,
          `${MAX_RATING_COMMENT} अक्षरों से कम रखें।`,
        );
      case "not_delivered":
        return t("You can rate once the order is delivered.", "ऑर्डर डिलीवर होने के बाद रेटिंग दे सकते हैं।");
      case "no_rider":
        return t("There is no rider on this order to rate.", "इस ऑर्डर में रेटिंग देने के लिए कोई राइडर नहीं है।");
      case "not_yours":
        return t("This order isn't yours to rate.", "यह ऑर्डर आपका नहीं है।");
      default:
        return status === 429
          ? t("Too many tries. Wait a minute and try again.", "बहुत ज़्यादा कोशिशें। एक मिनट रुककर फिर कोशिश करें।")
          : t("Could not send your rating. Try again.", "रेटिंग नहीं भेजी जा सकी। फिर कोशिश करें।");
    }
  }

  async function submit() {
    if (stars === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/rider-rating`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: stars, comment: comment.trim() || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; rating?: number; comment?: string | null };
      if (res.ok) {
        setGiven({ rating: stars, comment: comment.trim() || null });
      } else if (data.error === "already_rated") {
        // Rated before (another device, an earlier visit): show what was given.
        const earlier = await readGiven();
        if (earlier) setGiven(earlier);
        else setError(explain(data.error, res.status));
      } else {
        setError(explain(data.error, res.status));
      }
    } catch {
      setError(explain(undefined, 0));
    } finally {
      setBusy(false);
    }
  }

  // Until we know whether this order was rated, draw nothing rather than a form that may not apply.
  if (!loaded) return null;

  if (given) {
    return (
      <div className="rounded-2xl bg-surface-2 p-5 text-center" data-testid="rider-rating-given">
        <p className="text-[15px] font-bold">
          {t(`You rated ${who}`, `आपने ${who} को रेटिंग दी`)}
        </p>
        <div className="mt-2 flex justify-center gap-1" role="img" aria-label={t(`${given.rating} out of 5 stars`, `5 में से ${given.rating} स्टार`)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Star key={n} className={cn("size-5", n <= given.rating ? "fill-pop text-pop" : "text-muted")} />
          ))}
        </div>
        {given.comment ? <p className="mt-2 text-sm leading-relaxed text-muted">&ldquo;{given.comment}&rdquo;</p> : null}
        <p className="mt-2 text-[12.5px] text-muted">{t("Thank you for telling us.", "बताने के लिए धन्यवाद।")}</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-surface-2 p-5 text-center" data-testid="rider-rating-form">
      <p className="text-[15px] font-bold">
        {first ? t(`Rate ${first}`, `${first} को रेटिंग दें`) : t("Rate your rider", "अपने राइडर को रेटिंग दें")}
      </p>
      <p className="mt-1 text-[12.5px] text-muted">
        {t("How was the delivery? Your rider won't see your name.", "डिलीवरी कैसी रही? आपका नाम राइडर को नहीं दिखेगा।")}
      </p>
      <div className="mt-3 flex justify-center gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={busy}
            onClick={() => setStars(n)}
            aria-pressed={n <= stars}
            aria-label={t(`Rate ${who} ${n} star${n > 1 ? "s" : ""}`, `${who} को ${n} स्टार दें`)}
            className="press grid size-11 place-items-center rounded-full bg-surface disabled:opacity-100"
          >
            <Star className={cn("size-5", n <= stars ? "fill-pop text-pop" : "text-muted")} />
          </button>
        ))}
      </div>
      {stars > 0 ? (
        <div className="mt-3 text-left">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={MAX_RATING_COMMENT}
            rows={2}
            disabled={busy}
            placeholder={t("Anything to add? (optional)", "कुछ और कहना है? (वैकल्पिक)")}
            aria-label={t("Comment for your rider", "राइडर के लिए टिप्पणी")}
            className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="press mt-2 w-full rounded-xl bg-accent px-4 py-3 text-[15px] font-bold text-[var(--on-accent)] disabled:opacity-60"
          >
            {busy ? t("Sending…", "भेज रहे हैं…") : t("Submit rating", "रेटिंग भेजें")}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] font-semibold text-deal">
          {error}
        </p>
      ) : null}
    </div>
  );
}
