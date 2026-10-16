import Link from "next/link";
import {
  MapPin,
  Wallet,
  Heart,
  Bell,
  CircleHelp,
  Info,
  ChevronRight,
  LogOut,
  LogIn,
  ShieldCheck,
  Code2,
} from "lucide-react";
import { USER, ADDRESSES } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { requireUser } from "@/lib/auth";
import {
  getProfileSummary,
  type ProfileSummary,
} from "@/lib/data-access/profile";
import { AppearanceRow } from "@/components/profile/appearance-row";
import { ProfileAccountRows } from "@/components/profile/profile-account-rows";
import { ProfileAvatar } from "@/components/profile/profile-avatar";
import { SurfaceRows } from "@/components/shared/surface-switch";
import { operatorSurfaces, surfacesForRole } from "@/lib/auth/surfaces";
// Hindi is off for now — see HINDI_ENABLED in lib/i18n/lang.ts.
// import { LanguageSwitch } from "@/components/shared/language-switch";
import { getLang } from "@/lib/i18n/server";
import { pick, translator, type Bi } from "@/lib/i18n/lang";

// Per-request: reads the auth cookie to show the signed-in user's own data.
export const dynamic = "force-dynamic";

/** Toned icon chips, matching the admin section and the bottom nav. */
const ICON_TONE = {
  accent: "bg-accent/12 text-accent",
  green: "bg-green/12 text-green",
  blue: "bg-blue/12 text-blue",
  deal: "bg-deal/12 text-deal",
  violet: "bg-violet-500/15 text-violet-500",
} as const;

type IconTone = keyof typeof ICON_TONE;

const OTHER: {
  icon: typeof MapPin;
  label: Bi;
  href: string;
  tone: IconTone;
}[] = [
  {
    icon: MapPin,
    label: { en: "Saved addresses", hi: "सेव पते" },
    href: "/profile/addresses",
    tone: "blue",
  },
  {
    icon: Bell,
    label: { en: "Notifications", hi: "सूचनाएं" },
    href: "/profile/notifications",
    tone: "accent",
  },
  {
    icon: CircleHelp,
    label: { en: "Help & support", hi: "मदद और सहायता" },
    href: "/profile/help",
    tone: "green",
  },
  // Pointed at /profile/help until now — the same destination as the row above
  // it. Two labels, two icons, one screen, and the one that arrived was the
  // support FAQ, which says nothing about either privacy or security.
  {
    icon: ShieldCheck,
    label: { en: "Privacy & security", hi: "गोपनीयता और सुरक्षा" },
    href: "/profile/privacy",
    tone: "violet",
  },
  {
    icon: Info,
    label: { en: "About Deligro", hi: "Deligro के बारे में" },
    href: "/profile/about",
    tone: "blue",
  },
];

// Change this to the developers' inbox. Powers the "Contact developers" row.
const DEVELOPER_EMAIL = "gauravm7722@gmail.com";

export default async function ProfilePage() {
  // Profile is per-account — guests are bounced to /login by the proxy; this
  // backstops it server-side.
  await requireUser();
  const lang = await getLang();
  const t = translator(lang);

  // Live data when signed in; the mock demo profile when Supabase isn't set up.
  const summary: ProfileSummary | null = isSupabaseConfigured
    ? await getProfileSummary()
    : {
        name: USER.name,
        phone: USER.phone,
        initials: USER.initials,
        avatarUrl: null,
        memberSince: USER.memberSince,
        orders: USER.orders,
        addresses: ADDRESSES.length,
        favorites: 0,
        isDeveloper: false,
        role: "customer",
        ownsRestaurant: false,
      };

  if (!summary) {
    return (
      <div className="px-4 pt-8">
        <section className="card flex flex-col items-center gap-3 p-8 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
            <LogIn className="size-7" />
          </span>
          <div>
            <h2 className="text-lg font-extrabold">
              {t("You're not signed in", "आपने साइन इन नहीं किया है")}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {t(
                "Sign in to see your orders, saved addresses, and profile.",
                "अपने ऑर्डर, सेव पते और प्रोफ़ाइल देखने के लिए साइन इन करें।",
              )}
            </p>
          </div>
          <Link
            href="/login?next=/profile"
            className="press mt-1 flex items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)]"
          >
            <LogIn className="size-4" /> {t("Sign in", "साइन इन करें")}
          </Link>
        </section>
      </div>
    );
  }

  const firstName = summary.name.split(" ")[0];
  const favouritesNoun = summary.favorites === 1 ? "restaurant" : "restaurants";

  // The other Deligros this account opens. Empty for an ordinary customer, so
  // the section below simply isn't rendered — and these are links, not access:
  // each portal's layout still runs its own role check.
  const consoles = operatorSurfaces(
    surfacesForRole(summary.role, { vendorAccess: summary.ownsRestaurant }),
  );

  return (
    <div className="px-4 pb-4 pt-5">
      <h1 className="text-[24px] font-extrabold leading-tight tracking-tight">
        {t("Account", "खाता")}
      </h1>

      <div className="mt-4 flex items-center gap-4">
        <ProfileAvatar
          name={summary.name}
          initials={summary.initials}
          avatarUrl={summary.avatarUrl}
          developer={summary.isDeveloper}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[17px] font-extrabold leading-tight">
              {t(`Hello, ${firstName}`, `नमस्ते, ${firstName}`)}
            </p>
            {summary.isDeveloper ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wide"
                style={{ backgroundColor: "#ffc531", color: "#3d2800" }}
              >
                <Code2 className="size-3" />
                {t("Developer", "डेवलपर")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-[13px] font-medium text-muted">
            {summary.phone ??
              t("Add a phone number below", "नीचे फ़ोन नंबर जोड़ें")}
          </p>
        </div>
      </div>

      {/* Consoles — only for accounts that hold one. This is the way back out of
          the customer app for an operator (the owner's phone is both), so it
          sits above the shopping rows rather than at the bottom of "Other". */}
      {consoles.length ? (
        <>
          <SectionHead title={t("Switch app", "ऐप बदलें")} />
          <SurfaceRows surfaces={consoles} />
        </>
      ) : null}

      {/* Favourites */}
      <SectionHead title={t("Favourites", "पसंदीदा")} />
      <Link
        href="/profile/favorites"
        className="press flex items-center gap-4 rounded-2xl border border-line bg-surface p-4"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold">
            {summary.favorites
              ? t(
                  `${summary.favorites} ${favouritesNoun} saved`,
                  `${summary.favorites} रेस्टोरेंट सेव किए`,
                )
              : t("No favourites added", "कोई पसंदीदा नहीं जोड़ा")}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {summary.favorites
              ? t(
                  "Tap to view all your saved restaurants.",
                  "अपने सभी सेव किए रेस्टोरेंट देखने के लिए दबाएं।",
                )
              : t(
                  "Save all your favourites in one place using the heart icon.",
                  "दिल वाले आइकन से अपने पसंदीदा एक जगह सेव करें।",
                )}
          </p>
        </div>
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-deal-soft text-deal">
          <Heart className="size-6 fill-current" />
        </span>
        <ChevronRight className="size-5 shrink-0 text-muted" />
      </Link>

      {/* Payment. "Edit" and "Change" used to sit here as affordances for a
          picker that doesn't exist — Cash on Delivery is the only method, so the
          row states it rather than inviting a tap that does nothing. */}
      <SectionHead title={t("Payment", "भुगतान")} />
      <div className="flex items-center gap-3 border-b border-line pb-4">
        <span className="grid size-9 place-items-center rounded-lg bg-green/12 text-green">
          <Wallet className="size-[18px]" />
        </span>
        <span className="flex-1 text-[15px] font-semibold">
          {t("Cash on Delivery", "डिलीवरी पर नकद")}
        </span>
        <span className="text-sm text-muted">
          {t("Only method for now", "अभी यही तरीका है")}
        </span>
      </div>

      {/* Profile */}
      <SectionHead title={t("Profile", "प्रोफ़ाइल")} />
      <div className="relative">
        <ProfileAccountRows summary={summary} />
      </div>
      <p className="mt-3 text-xs text-muted">
        {t(
          `Member since ${summary.memberSince} · ${summary.orders} ${summary.orders === 1 ? "order" : "orders"}`,
          `${summary.memberSince} से सदस्य · ${summary.orders} ऑर्डर`,
        )}
      </p>

      {/* Theme */}
      {/* Hindi is off for now — see HINDI_ENABLED in lib/i18n/lang.ts.
      <SectionHead title={t("Language", "भाषा")} />
      <LanguageSwitch />
      */}

      <SectionHead title={t("Theme", "थीम")} />
      <AppearanceRow />

      {/* Other */}
      <SectionHead title={t("Other", "अन्य")} />
      <div className="divide-y divide-line">
        {OTHER.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="press flex w-full items-center gap-3 py-3 text-left"
            >
              <span
                className={`grid size-9 shrink-0 place-items-center rounded-xl ${ICON_TONE[item.tone]}`}
              >
                <Icon className="size-[18px]" />
              </span>
              <span className="flex-1 text-[15px] font-medium">
                {pick(lang, item.label)}
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted" />
            </Link>
          );
        })}
        <a
          href={`mailto:${DEVELOPER_EMAIL}?subject=${encodeURIComponent("Deligro app feedback")}`}
          className="press flex w-full items-center gap-3 py-3 text-left"
        >
          <span
            className={`grid size-9 shrink-0 place-items-center rounded-xl ${ICON_TONE.deal}`}
          >
            <Code2 className="size-[18px]" />
          </span>
          <span className="flex-1 text-[15px] font-medium">
            {t("Contact developers", "डेवलपर से संपर्क करें")}
          </span>
          <ChevronRight className="size-5 shrink-0 text-muted" />
        </a>
      </div>

      {/* Sign out — native form POST, clears the session server-side. */}
      <form action="/auth/signout" method="post" className="mt-6">
        <button
          type="submit"
          className="press flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-3.5 text-sm font-bold text-deal"
        >
          <LogOut className="size-4" /> {t("Sign out", "लॉग आउट")}
        </button>
      </form>

      <p className="pb-2 pt-6 text-center text-xs text-muted">
        Deligro · Phoxera Solutions Private Limited
      </p>
    </div>
  );
}

function SectionHead({ title, action }: Readonly<{ title: string; action?: string }>) {
  return (
    <div className="mb-2 mt-7 flex items-end justify-between">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.06em] text-muted">
        {title}
      </h2>
      {action ? (
        <span className="bolt-section-link text-[13px]">
          {action} <ChevronRight className="size-3.5" />
        </span>
      ) : null}
    </div>
  );
}
