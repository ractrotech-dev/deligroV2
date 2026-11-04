import Link from "next/link";
import { Phone, Mail, MessageCircle } from "lucide-react";
import { ProfileSubpage } from "@/components/profile/profile-subpage";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { onlinePaymentsEnabled } from "@/lib/payments/availability";
import { getLang } from "@/lib/i18n/server";
import { pick, translator, type Bi } from "@/lib/i18n/lang";

export const dynamic = "force-dynamic";

/** Strip a phone number down to digits for tel:/wa.me links. */
function digits(s: string) {
  return s.replace(/[^\d]/g, "");
}

/**
 * The answers that don't depend on configuration. "Payment methods" used to sit
 * here too, as a constant reading "We currently support Cash on Delivery. Online
 * payments are coming soon." — on a page that already loads live settings for
 * its contact channels. The moment an admin enabled online payment, the official
 * support answer told customers it didn't exist.
 */
const FAQ: { q: Bi; a: Bi }[] = [
  {
    q: { en: "Where is my order?", hi: "मेरा ऑर्डर कहाँ है?" },
    a: {
      en: "Open Orders and tap your active order to see live tracking on the map.",
      hi: "ऑर्डर पेज खोलें और चल रहे ऑर्डर पर दबाएं — नक्शे पर लाइव देख सकते हैं कि ऑर्डर कहाँ है।",
    },
  },
  {
    q: { en: "How do I cancel?", hi: "ऑर्डर कैसे रद्द करें?" },
    a: {
      en: "You can cancel only in the first 20 seconds after placing your order, from the order tracking screen. After that your order will be delivered.",
      hi: "ऑर्डर देने के बाद सिर्फ़ पहले 20 सेकंड में, ऑर्डर ट्रैकिंग वाले पेज से रद्द कर सकते हैं। उसके बाद आपका ऑर्डर डिलीवर किया जाएगा।",
    },
  },
];

export default async function HelpPage() {
  await requireUser();
  // Same gate the checkout and /api/orders use, not the raw toggle: what the
  // customer can actually pay with depends on the admin switch AND the gateway
  // keys, and answering from the switch alone would promise a method the order
  // API would refuse.
  const [s, onlinePayments, lang] = await Promise.all([
    getSettings(),
    onlinePaymentsEnabled(),
    getLang(),
  ]);
  const t = translator(lang);

  const faq = [
    ...FAQ.map((f) => ({ q: pick(lang, f.q), a: pick(lang, f.a) })),
    {
      q: t("Payment methods", "पेमेंट के तरीके"),
      a: onlinePayments
        ? t(
            "You can pay cash on delivery, or online by card, UPI or netbanking at checkout. Some shops set a cash limit on larger orders — checkout will say so.",
            "आप डिलीवरी पर नकद दे सकते हैं, या ऑर्डर करते समय कार्ड, UPI या नेटबैंकिंग से ऑनलाइन पेमेंट कर सकते हैं। कुछ दुकानें बड़े ऑर्डर पर नकद की सीमा रखती हैं — ऑर्डर करते समय यह बता दिया जाएगा।",
          )
        : t(
            "We currently accept Cash on Delivery. Online payment isn't available yet.",
            "अभी सिर्फ़ डिलीवरी पर नकद (कैश ऑन डिलीवरी) लिया जाता है। ऑनलाइन पेमेंट अभी उपलब्ध नहीं है।",
          ),
    },
  ];

  const channels = [
    s.supportPhone && {
      icon: Phone,
      label: t("Call us", "कॉल करें"),
      value: s.supportPhone,
      href: `tel:${digits(s.supportPhone)}`,
      tone: "bg-blue/12 text-blue",
    },
    s.supportWhatsapp && {
      icon: MessageCircle,
      label: "WhatsApp",
      value: s.supportWhatsapp,
      href: `https://wa.me/${digits(s.supportWhatsapp)}`,
      tone: "bg-green/12 text-green",
    },
    s.supportEmail && {
      icon: Mail,
      label: t("Email", "ईमेल"),
      value: s.supportEmail,
      href: `mailto:${s.supportEmail}`,
      tone: "bg-accent/12 text-accent",
    },
  ].filter(Boolean) as {
    icon: typeof Phone;
    label: string;
    value: string;
    href: string;
    tone: string;
  }[];

  return (
    <ProfileSubpage title={t("Help & support", "मदद और सहायता")}>
      <div className="space-y-3">
        {faq.map((item) => (
          <div key={item.q} className="card p-4">
            <h2 className="text-[15px] font-bold">{item.q}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{item.a}</p>
          </div>
        ))}
      </div>

      {channels.length ? (
        <div className="mt-6 space-y-2">
          <p className="text-[13px] font-semibold text-muted">
            {t(
              `Contact ${s.businessName} support`,
              `${s.businessName} सहायता से संपर्क करें`,
            )}
          </p>
          {channels.map((c) => {
            const Icon = c.icon;
            return (
              <a
                key={c.label}
                href={c.href}
                className="press flex items-center gap-3 rounded-xl border border-line bg-surface p-3.5"
              >
                <span
                  className={`grid size-9 shrink-0 place-items-center rounded-full ${c.tone}`}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs text-muted">{c.label}</span>
                  <span className="block truncate text-sm font-semibold">
                    {c.value}
                  </span>
                </span>
              </a>
            );
          })}
        </div>
      ) : (
        <p className="mt-6 text-center text-sm text-muted">
          {t(
            "Still need help? Reach us from the Orders screen.",
            "अब भी मदद चाहिए? ऑर्डर पेज से हमसे संपर्क करें।",
          )}
        </p>
      )}

      <Link
        href="/orders"
        className="press mt-4 flex w-full items-center justify-center rounded-full border border-line bg-surface py-3.5 text-sm font-bold"
      >
        {t("View my orders", "मेरे ऑर्डर देखें")}
      </Link>
    </ProfileSubpage>
  );
}
