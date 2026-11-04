import Link from "next/link";
import {
  KeyRound,
  MapPin,
  ReceiptText,
  Smartphone,
  Trash2,
  CircleHelp,
} from "lucide-react";
import { ProfileSubpage } from "@/components/profile/profile-subpage";
import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/i18n/server";
import { pick, translator, type Bi } from "@/lib/i18n/lang";

export const dynamic = "force-dynamic";

/**
 * Privacy & security.
 *
 * This row existed on the account screen, with a shield icon, pointing at
 * `/profile/help` — the support FAQ, which says nothing about either. Two rows
 * with two labels, two icons and one destination, and the one that arrived was
 * not the one promised.
 *
 * What is written below is deliberately a description of what this app actually
 * does, field by field, not a policy document. Deligro has no published privacy
 * policy or terms — the sign-in screen asserts you agree to both, in plain text,
 * with nothing to read and nothing to link to — and inventing legal text to fill
 * a screen would be worse than the empty row it replaces. Everything here can be
 * checked against the schema; the moment a real policy exists it belongs at the
 * bottom of this page as a link.
 */
const HELD: { icon: typeof MapPin; title: Bi; body: Bi }[] = [
  {
    icon: Smartphone,
    title: { en: "Your phone number", hi: "आपका फ़ोन नंबर" },
    body: {
      en: "It is how you sign in and how a rider reaches you at the door. It is the one thing an account cannot exist without.",
      hi: "इसी से आप लॉग इन करते हैं और राइडर आपके दरवाज़े पर आपसे संपर्क करता है। इसके बिना खाता नहीं बन सकता।",
    },
  },
  {
    icon: MapPin,
    title: { en: "Addresses you save", hi: "आपके सेव किए पते" },
    body: {
      en: "The label, the address line and its map pin, so a rider can find you. Saved only when you add one, and yours to delete at any time.",
      hi: "पते का नाम, पूरा पता और नक्शे पर उसकी जगह, ताकि राइडर आप तक पहुंच सके। यह तभी सेव होता है जब आप पता जोड़ते हैं, और आप इसे कभी भी हटा सकते हैं।",
    },
  },
  {
    icon: ReceiptText,
    title: { en: "Your orders", hi: "आपके ऑर्डर" },
    body: {
      en: "What you ordered, from where, what it cost and how it was paid. This is the record behind your receipts, so it is kept rather than cleared.",
      hi: "आपने क्या मंगाया, कहाँ से, कितने का था और पेमेंट कैसे हुआ। आपकी रसीद का रिकॉर्ड यही है, इसलिए इसे मिटाया नहीं जाता।",
    },
  },
  {
    icon: KeyRound,
    title: {
      en: "A device token for notifications",
      hi: "नोटिफ़िकेशन के लिए डिवाइस टोकन",
    },
    body: {
      en: "Only if you turn push on. It identifies this browser to the notification service — not you — and turning notifications off stops it being used.",
      hi: "सिर्फ़ तब, जब आप नोटिफ़िकेशन चालू करें। इससे नोटिफ़िकेशन सेवा इस ब्राउज़र को पहचानती है — आपको नहीं — और नोटिफ़िकेशन बंद करने पर इसका इस्तेमाल रुक जाता है।",
    },
  },
];

export default async function PrivacyPage() {
  await requireUser();
  const lang = await getLang();
  const t = translator(lang);

  return (
    <ProfileSubpage title={t("Privacy & security", "गोपनीयता और सुरक्षा")}>
      <section>
        <h2 className="mb-2 px-1 text-[15px] font-bold text-ink">
          {t("How you sign in", "आप लॉग इन कैसे करते हैं")}
        </h2>
        <div className="card p-4">
          <p className="text-[15px] font-semibold">
            {t(
              "A code to your phone, never a password",
              "फ़ोन पर कोड आता है, पासवर्ड कभी नहीं",
            )}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {t(
              "Deligro has no password for your account, so there is none to guess, reuse or leak. Each sign-in sends a one-time code to your number and that code expires. Anyone who cannot receive your texts cannot get in, which also means keeping your number current matters — see \u201cGetting help\u201d below if it changes.",
              "Deligro में आपके खाते का कोई पासवर्ड नहीं है, इसलिए उसे कोई अंदाज़ा नहीं लगा सकता, न चुरा सकता। हर बार लॉग इन पर आपके नंबर पर एक बार चलने वाला कोड आता है, जो कुछ देर में ख़त्म हो जाता है। जिसके पास आपके SMS नहीं आते, वह अंदर नहीं आ सकता — इसलिए अपना नंबर सही रखना ज़रूरी है। नंबर बदले तो नीचे \u201cमदद लें\u201d देखें।",
            )}
          </p>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 px-1 text-[15px] font-bold text-ink">
          {t("What we hold about you", "हमारे पास आपकी कौन-सी जानकारी है")}
        </h2>
        <div className="card divide-y divide-line">
          {HELD.map((h) => {
            const Icon = h.icon;
            return (
              <div key={h.title.en} className="flex items-start gap-3 p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
                  <Icon className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold">
                    {pick(lang, h.title)}
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">
                    {pick(lang, h.body)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-3 px-1 text-xs leading-relaxed text-muted">
          {t(
            "Your saved card details are never held here — online payments go straight to the payment provider, and Deligro only learns whether a payment succeeded.",
            "आपके कार्ड की जानकारी यहाँ कभी नहीं रखी जाती — ऑनलाइन पेमेंट सीधे पेमेंट कंपनी के पास जाता है, और Deligro को सिर्फ़ इतना पता चलता है कि पेमेंट हुआ या नहीं।",
          )}
        </p>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 px-1 text-[15px] font-bold text-ink">
          {t("What you can do", "आप क्या कर सकते हैं")}
        </h2>
        <div className="card divide-y divide-line">
          <Link
            href="/profile/addresses"
            className="press flex items-center gap-3 p-4"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-blue/12 text-blue">
              <MapPin className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold">
                {t("Review your saved addresses", "अपने सेव किए पते देखें")}
              </span>
              <span className="mt-0.5 block text-[13px] text-muted">
                {t("Edit or delete any of them.", "किसी को भी बदलें या हटाएं।")}
              </span>
            </span>
          </Link>
          <Link
            href="/profile/notifications"
            className="press flex items-center gap-3 p-4"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
              <Smartphone className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold">
                {t("Turn notifications off", "नोटिफ़िकेशन बंद करें")}
              </span>
              <span className="mt-0.5 block text-[13px] text-muted">
                {t(
                  "Stops the device token being used.",
                  "इससे डिवाइस टोकन का इस्तेमाल रुक जाता है।",
                )}
              </span>
            </span>
          </Link>
          {/* Account deletion is a support request rather than a button,
              because it is not one: orders are financial records a vendor has
              been settled against, so an account cannot simply be dropped. Say
              that plainly instead of offering a button that opens a dialog and
              then explains it cannot finish. */}
          <Link
            href="/profile/help"
            className="press flex items-center gap-3 p-4"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-deal/12 text-deal">
              <Trash2 className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold">
                {t(
                  "Ask us to delete your account",
                  "अपना खाता हटाने के लिए कहें",
                )}
              </span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted">
                {t(
                  "Get in touch and we will remove your profile and addresses. Past orders are kept — they are the record behind receipts and what each shop was paid.",
                  "हमसे संपर्क करें, हम आपकी प्रोफ़ाइल और पते हटा देंगे। पुराने ऑर्डर रखे जाते हैं — रसीद और दुकानों के भुगतान का रिकॉर्ड इन्हीं से है।",
                )}
              </span>
            </span>
          </Link>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 px-1 text-[15px] font-bold text-ink">
          {t("Getting help", "मदद लें")}
        </h2>
        <Link
          href="/profile/help"
          className="card press flex items-center gap-3 p-4"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-green/12 text-green">
            <CircleHelp className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1 text-[15px] font-semibold">
            {t("Contact support", "सहायता से संपर्क करें")}
          </span>
        </Link>
      </section>
    </ProfileSubpage>
  );
}
