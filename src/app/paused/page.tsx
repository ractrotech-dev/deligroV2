import Link from "next/link";
import { PauseCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { getPlatformLock, lockBlocksConsole } from "@/lib/platform-lock";
import { pausedText } from "@/lib/platform-lock-rules";

export const dynamic = "force-dynamic";
export const metadata = { title: "Paused · Deligro", robots: { index: false, follow: false } };

/**
 * Where the Admin console and Manager pages send their staff while the
 * platform developer has paused operations (0177, level "full"). Once the
 * pause is lifted it sends them back to work.
 */
export default async function PausedPage() {
  const [profile, lock] = await Promise.all([getProfile(), getPlatformLock()]);
  if (!profile || !lockBlocksConsole(lock, profile.role)) {
    redirect(profile?.role === "manager" ? "/manager" : profile?.role === "admin" ? "/admin" : "/");
  }
  return (
    <div className="device">
      <div className="app-shell">
        <div className="app-scroll no-scrollbar grid place-items-center px-6 py-16 text-center">
          <div>
            <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-surface-2 text-muted">
              <PauseCircle className="size-7" />
            </span>
            <h1 className="text-xl font-extrabold tracking-tight">Operations are paused</h1>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">{pausedText(lock)}</p>
            <p className="mx-auto mt-3 max-w-sm text-xs text-muted">
              The platform developer paused Deligro. No new orders can be placed. Shops and riders can still finish
              orders already placed.
            </p>
            <Link href="/login" className="mt-5 inline-block text-sm font-semibold underline">
              Sign in with another account
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
