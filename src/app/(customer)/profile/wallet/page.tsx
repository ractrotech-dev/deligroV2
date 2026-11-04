import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { getMyWallet, type MyWallet } from "@/lib/data-access/wallet";
import { getLang } from "@/lib/i18n/server";
import { translator } from "@/lib/i18n/lang";
import { shortOrderId } from "@/lib/utils/order-map";
import { formatDateTime } from "@/lib/utils/relative-time";
import { signedRupees, type WalletKind } from "@/lib/wallet/money";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * The customer's wallet: balance and every point added, used or corrected. Read for the
 * signed-in customer only; there is no id in this URL to change. Points never expire and
 * can't be taken out as cash (rule book).
 */
export const dynamic = "force-dynamic";

const KIND_WORDS: Record<WalletKind, [string, string]> = {
  change_credit: ["Change from a cash order", "नकद ऑर्डर के बचे पैसे"],
  order_spend: ["Used on an order", "ऑर्डर में इस्तेमाल"],
  order_return: ["Returned, order cancelled", "वापस, ऑर्डर रद्द हुआ"],
  order_adjust: ["Returned, bill went down", "वापस, बिल कम हुआ"],
  admin_correction: ["Corrected by Deligro", "Deligro ने ठीक किया"],
  legacy: ["Opening balance", "शुरुआती बैलेंस"],
};

export default async function WalletPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ before?: string }> }>) {
  const user = await requireUser();
  const lang = await getLang();
  const t = translator(lang);
  const { before } = await searchParams;
  const cursor = before && Number.isFinite(Date.parse(before)) ? before : null;

  const wallet: MyWallet = isSupabaseConfigured
    ? await getMyWallet(user.id, { cursor })
    : { enabled: false, balance: 0, moves: [], nextCursor: null };

  return (
    <div className="px-4 pb-8">
      <PageHeader title={t("Wallet", "वॉलेट")} />

      <div className="card mt-3 p-5 text-center">
        <p className="text-sm font-semibold text-muted">{t("Your points", "आपके पॉइंट")}</p>
        <p className="text-data mt-1 text-[40px] font-extrabold leading-none">{Math.floor(wallet.balance)}</p>
        <p className="mt-2 text-[13px] leading-snug text-muted">
          {t(
            "1 point = ₹1. Use them on any order at checkout. They never expire and can't be taken out as cash.",
            "1 पॉइंट = ₹1। चेकआउट पर किसी भी ऑर्डर में इस्तेमाल करें। ये कभी खत्म नहीं होते और नकद नहीं निकाले जा सकते।",
          )}
        </p>
        {wallet.enabled ? null : (
          <p className="mt-2 text-[13px] font-medium text-deal">
            {t("The wallet is switched off right now.", "वॉलेट अभी बंद है।")}
          </p>
        )}
      </div>

      <h2 className="mt-5 text-[15px] font-bold">{t("History", "इतिहास")}</h2>
      {wallet.moves.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          {cursor
            ? t("Nothing older.", "इससे पुराना कुछ नहीं।")
            : t("Nothing yet. When a rider adds your change, it shows here.", "अभी कुछ नहीं। जब राइडर आपके बचे पैसे जोड़ेगा, यहाँ दिखेगा।")}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {wallet.moves.map((m) => {
            const words = KIND_WORDS[m.kind] ?? KIND_WORDS.legacy;
            return (
              <li key={m.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{t(words[0], words[1])}</p>
                  <p className="text-xs text-muted">
                    {formatDateTime(m.at)}
                    {m.orderId ? (
                      <>
                        {" · "}
                        <Link href={`/orders/${m.orderId}`} className="underline">
                          #{shortOrderId(m.orderId)}
                        </Link>
                      </>
                    ) : null}
                  </p>
                  {m.kind === "admin_correction" ? <p className="text-xs text-muted">{m.reason}</p> : null}
                </div>
                <span className={`text-data shrink-0 text-[15px] font-bold ${m.amount > 0 ? "text-green" : ""}`}>
                  {signedRupees(m.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {wallet.nextCursor ? (
        <Link
          href={`/profile/wallet?before=${encodeURIComponent(wallet.nextCursor)}`}
          className="press mt-3 block rounded-full border border-line py-3 text-center text-sm font-bold"
        >
          {t("Show older", "पुराना दिखाएं")}
        </Link>
      ) : null}
    </div>
  );
}
