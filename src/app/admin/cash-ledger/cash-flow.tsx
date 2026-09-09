import { ArrowRight } from "lucide-react";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * Where the cash is, as the chain it actually travels.
 *
 * COD money moves rider → manager → owner, by hand, one conversation at a
 * time. The screen used to state that as four figures in a row, which leaves
 * the reader to work out that "outstanding with riders" is the *gap* between
 * two of the others — and the gap is the whole point, because a gap is a
 * question somebody has to go and ask.
 *
 * So it is drawn as the chain: what each pair of hands is holding, and how much
 * has been passed on between them. A stage holding nothing is a stage that has
 * balanced, and is drawn quietly; a stage holding money is the one to ask
 * about, and is drawn in the warning tone.
 *
 * ## What the figures are, exactly
 *
 * All-time and cumulative, not today's. `codOutstandingSummary` is deliberately
 * not day-scoped: a handover missed last Tuesday must not drop off the picture
 * because the calendar rolled over. The figures below are therefore
 * "everything ever recorded", and the stage balances are differences between
 * the totals — which is why they can only be as right as what was recorded.
 *
 * Nothing here is enforced or reconciled. A number in the warning tone is a
 * prompt to ask a person, not a blocked action.
 */
export function CashFlow({
  collected,
  handedToManager,
  handedToOwner,
  withRiders,
  withManagers,
}: {
  collected: number;
  handedToManager: number;
  handedToOwner: number;
  withRiders: number;
  withManagers: number;
}) {
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <Holder
        who="Riders"
        holding={withRiders}
        caption={`${formatINR(collected)} collected in total`}
      />
      <Passed amount={handedToManager} label="handed over" />
      <Holder
        who="Managers"
        holding={withManagers}
        caption={`${formatINR(handedToManager)} received from riders`}
      />
      <Passed amount={handedToOwner} label="handed over" />
      <Holder
        who="Owner"
        holding={handedToOwner}
        caption="Banked or held by the owner"
        // The end of the chain. Money here has arrived rather than stalled, so
        // it is never the warning tone however large it is — which is the one
        // place the "holding money is a question" rule does not hold.
        settled
      />
    </div>
  );
}

function Holder({
  who,
  holding,
  caption,
  settled,
}: {
  who: string;
  holding: number;
  caption: string;
  settled?: boolean;
}) {
  // A negative balance means more was handed on than was recorded as collected.
  // That is not "nothing outstanding" — it is a bookkeeping error, and it gets
  // the warning tone rather than being rounded away to a quiet zero.
  const outstanding = !settled && holding !== 0;

  return (
    <div
      className={cn(
        "min-w-[150px] flex-1 rounded-[var(--c-r)] border px-3 py-2.5",
        outstanding
          ? "border-[color:var(--pop)]/35 bg-[var(--c-tint-amber)]"
          : "border-line bg-surface"
      )}
    >
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
        {who}
      </p>
      <p
        className={cn(
          "text-data mt-1 text-[19px] font-bold leading-none tracking-[-0.025em] tabular-nums",
          outstanding ? "text-[color:var(--c-ink-amber)]" : "text-ink"
        )}
      >
        {formatINR(holding)}
      </p>
      <p className="mt-1 text-[11px] leading-snug text-muted">
        {settled
          ? caption
          : outstanding
            ? holding > 0
              ? "Holding cash · not handed on yet"
              : "Handed on more than recorded as collected"
            : "Nothing outstanding"}
      </p>
      {!settled ? (
        <p className="mt-0.5 text-[10.5px] leading-snug text-[color:var(--c-faint)]">
          {caption}
        </p>
      ) : null}
    </div>
  );
}

function Passed({ amount, label }: { amount: number; label: string }) {
  return (
    <div
      className="flex shrink-0 flex-col items-center justify-center px-1"
      aria-hidden={false}
    >
      <ArrowRight className="size-4 text-[color:var(--c-faint)]" />
      <span className="text-data mt-1 whitespace-nowrap text-[11px] font-semibold tabular-nums text-muted">
        {formatINR(amount)}
      </span>
      <span className="whitespace-nowrap text-[10px] text-[color:var(--c-faint)]">
        {label}
      </span>
    </div>
  );
}
